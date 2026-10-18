import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { AgavConfig } from "../config/config.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { WorkflowExecutionHost } from "./gated-tools.js";
import { definitionHash, type RunHost, type RunStatus, type WorkflowRun, WorkflowStore } from "./store.js";
import type { JobNodeDeps } from "./job-node.js";
import type { WorkflowDefinition } from "./definition.js";
import { getNodeExecutor, retriesOnResume } from "./executors.js";
import type { AgentNodeDeps } from "./agent-node.js";
import { resolveInputs } from "./inputs.js";
import { appendEvent } from "./events.js";
import { applyDecisions, hasUnappliedDecision, parkUncertainNodes } from "./decisions.js";

/** Creates a pending run; provided inputs are checked against the definition's typed inputs (defaults applied). */
export async function createRun(store: WorkflowStore, definition: WorkflowDefinition, inputs: Record<string, unknown>, options: { host?: RunHost } = {}): Promise<WorkflowRun> {
  const resolved = resolveInputs(definition, inputs);
  const now = new Date().toISOString();
  const run: WorkflowRun = { version: 1, id: randomUUID(), definition, workflowHash: definitionHash(definition), cwd: await realpath(process.cwd()), inputs: resolved, status: "pending", nodes: definition.nodes.map(node => ({ id: node.id, status: "pending" })), createdAt: now, updatedAt: now, ...(options.host ? { host: options.host } : {}) };
  await store.lock(run.id, () => store.save(run));
  return run;
}
/** Sequential DAG execution; the exclusive run lock spans work and shutdown settlement. */
export async function executeRun(store: WorkflowStore, id: string, registry: ToolRegistry, config: AgavConfig, signal?: AbortSignal, host?: WorkflowExecutionHost, jobDeps?: JobNodeDeps, agentDeps?: AgentNodeDeps): Promise<WorkflowRun> {
  return store.lock(id, async () => {
    const run = await store.read(id, registry);
    if (await realpath(process.cwd()) !== run.cwd) throw new Error(`Resume must use the original working directory: ${run.cwd}`);
    if (["passed", "failed", "cancelled", "timed_out"].includes(run.status)) return run;
    await store.hydrateOutputs(run); // Executors interpolate real outputs, never artifact references.
    // Tool nodes are never replayed. A running job node is instead reattached below via its durable requestId.
    const resumedJob = run.nodes.find(cp => cp.status === "running" && getNodeExecutor(run.definition.nodes.find(node => node.id === cp.id)!.type).resumable === true);
    // A retry-safe agent/prompt node (retrySafe !== false) is simply dispatched again from scratch.
    let dirty = false;
    for (const cp of run.nodes) {
      if (cp.status !== "running" || cp === resumedJob || !retriesOnResume(run.definition.nodes.find(node => node.id === cp.id)!)) continue;
      cp.status = "pending";
      for (const key of ["output", "error", "startedAt", "endedAt", "usage", "model", "durationMs"] as const) delete cp[key];
      dirty = true;
    }
    // An interrupted tool (or retrySafe:false agent) becomes an `uncertain_tool` inbox decision (approve retries, deny fails); never auto-replayed.
    if ((await parkUncertainNodes(store, run, cp => cp !== resumedJob)).length > 0) dirty = true;
    // Decisions recorded while no runner was live (the decider never writes run.json).
    if (await applyDecisions(store, run)) dirty = true;
    if (dirty) await store.save(run);
    // A crash can occur after a failed node is durable but before the run's
    // terminal status is saved. Never dispatch another branch on resume.
    const stopped = run.nodes.find(node => ["failed", "cancelled", "timed_out"].includes(node.status));
    if (stopped) {
      run.status = stopped.status as RunStatus;
      await store.save(run);
      await appendEvent(store, id, { type: "run_status", status: run.status });
      return run;
    }
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let pollingError: unknown;
    let polling = Promise.resolve();
    // Set by the poller when a waiting node's decision was decided by another session; applied between nodes.
    let decisionReady = false;
    const timer = setInterval(() => {
      polling = polling.then(async () => {
        if (await store.cancellationRequested(id)) abort();
        if (!decisionReady && await hasUnappliedDecision(store, run)) decisionReady = true;
      }).catch(error => { pollingError = error; abort(); });
    }, 100);
    try {
      if (await store.cancellationRequested(id)) abort();
      let resume = resumedJob;
      for (;;) {
        run.status = "running";
        await store.save(run);
        await appendEvent(store, id, { type: "run_status", status: "running" });
        while (resume !== undefined || !controller.signal.aborted) {
          if (resume === undefined && await store.cancellationRequested(id)) { abort(); break; }
          if (resume === undefined && decisionReady) {
            decisionReady = false;
            if (await applyDecisions(store, run)) await store.save(run);
            if (run.nodes.some(cp => cp.status === "failed")) break;
          }
          const node = resume !== undefined
            ? run.definition.nodes.find(candidate => candidate.id === resume!.id)
            : run.definition.nodes.find(candidate => run.nodes.find(cp => cp.id === candidate.id)!.status === "pending" && (candidate.dependsOn ?? []).every(dep => run.nodes.find(cp => cp.id === dep)!.status === "passed"));
          if (!node) break;
          const cp = run.nodes.find(item => item.id === node.id)!;
          const resuming = resume !== undefined;
          resume = undefined;
          const executor = getNodeExecutor(node.type);
          if (!resuming) await appendEvent(store, id, { type: "node_started", nodeId: node.id });
          const result = await executor.execute({ store, run, node, checkpoint: cp, registry, config, signal: controller.signal, host, jobDeps, agentDeps, resuming });
          if (!["pending", "running", "waiting_approval"].includes(cp.status)) await appendEvent(store, id, { type: "node_completed", nodeId: node.id, status: cp.status, ...(cp.error ? { error: cp.error } : {}) });
          if (result.next === "stop") break;
        }
        if (pollingError) throw pollingError;
        run.status = controller.signal.aborted ? "cancelled" : run.nodes.some(cp => cp.status === "timed_out") ? "timed_out" : run.nodes.some(cp => cp.status === "failed") ? "failed" : run.nodes.some(cp => cp.status === "cancelled") ? "cancelled" : run.nodes.every(cp => cp.status === "passed" || cp.status === "skipped") ? "passed" : "waiting_approval";
        await store.save(run);
        await appendEvent(store, id, { type: "run_status", status: run.status });
        // Parked. A decider that saw this runner live does not relaunch, so re-check once the park is durable:
        // a decision written before this point is applied now instead of being stranded.
        if (run.status !== "waiting_approval" || !await applyDecisions(store, run)) return run;
        decisionReady = false;
        if (run.nodes.some(cp => cp.status === "failed")) {
          run.status = "failed";
          await store.save(run);
          await appendEvent(store, id, { type: "run_status", status: run.status });
          return run;
        }
      }
    } finally {
      clearInterval(timer);
      signal?.removeEventListener("abort", abort);
      await polling;
    }
  });
}

