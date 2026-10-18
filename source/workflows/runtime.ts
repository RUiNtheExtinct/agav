import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { AgavConfig, PermissionMode } from "../config/config.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { WorkflowExecutionHost } from "./gated-tools.js";
import { definitionHash, type NodeCheckpoint, type NodeStatus, type RunHost, type RunStatus, type WorkflowRun, WorkflowStore } from "./store.js";
import type { JobNodeDeps } from "./job-node.js";
import { narrowPermissionMode, type WorkflowDefinition, type WorkflowNode } from "./definition.js";
import { getNodeExecutor, retriesOnResume, type NodeResult } from "./executors.js";
import { templateContext, type AgentNodeDeps } from "./agent-node.js";
import { evaluateCondition } from "./expr.js";
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
/** Node statuses after which a node will not change again in this run (dependents may be decided). */
const SETTLED = new Set<NodeStatus>(["passed", "skipped", "failed", "timed_out", "cancelled"]);

/** Cancellable sleep: resolves early (without throwing) when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted || ms <= 0) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Why a ready node (every dependency settled) must be skipped instead of executed, or undefined to run it.
 * A failed/timed-out/cancelled dependency (only reachable with `stopOnFailure: false`) skips its dependents;
 * a skipped dependency is satisfied only with `allowSkipped: true`, otherwise the skip cascades. Finally a
 * false `when` skips the node itself. A missing reference in `when` is undefined, never an error.
 */
export function skipReason(run: WorkflowRun, node: WorkflowNode): string | undefined {
  for (const dep of node.dependsOn ?? []) {
    const status = run.nodes.find(cp => cp.id === dep)!.status;
    if (status === "failed" || status === "timed_out" || status === "cancelled") return `dependency ${dep} ${status}`;
    if (status === "skipped" && node.allowSkipped !== true) return `dependency ${dep} was skipped`;
  }
  if (node.when !== undefined && !evaluateCondition(node.when, templateContext(run))) return `when is false: ${node.when}`;
  return undefined;
}

/** True when a settled attempt may be retried: retry budget left, not cancelled, and no possibly-live job behind it. */
function shouldRetry(node: WorkflowNode, cp: NodeCheckpoint, signal: AbortSignal): boolean {
  if (!node.retry || signal.aborted || (cp.status !== "failed" && cp.status !== "timed_out")) return false;
  if ((cp.attempt ?? 1) > node.retry.max) return false;
  // An uncertain job outcome (unknown state, unverifiable start) may still be running: never start a second workload.
  if (node.type === "job" && (cp.error ?? "").startsWith("uncertain")) return false;
  return true;
}

/** Job deps whose session permission mode is narrowed like the run config (deny-writes blocks `start`). */
function narrowJobDeps(deps: JobNodeDeps | undefined, mode: PermissionMode | undefined): JobNodeDeps | undefined {
  if (!deps || mode === undefined) return deps;
  const base = deps.session;
  return { ...deps, session: () => { const session = typeof base === "function" ? base() : base; return { ...session, permissionMode: narrowPermissionMode(session.permissionMode, mode) }; } };
}

/** Sequential DAG execution; the exclusive run lock spans work and shutdown settlement. */
export async function executeRun(store: WorkflowStore, id: string, registry: ToolRegistry, sessionConfig: AgavConfig, signal?: AbortSignal, host?: WorkflowExecutionHost, sessionJobDeps?: JobNodeDeps, agentDeps?: AgentNodeDeps): Promise<WorkflowRun> {
  return store.lock(id, async () => {
    const run = await store.read(id, registry);
    if (await realpath(process.cwd()) !== run.cwd) throw new Error(`Resume must use the original working directory: ${run.cwd}`);
    if (["passed", "failed", "cancelled", "timed_out"].includes(run.status)) return run;
    const policies = run.definition.policies ?? {};
    const stopOnFailure = policies.stopOnFailure !== false;
    // policies.permissionMode can only narrow the session's (or the run consent's) mode, never widen it.
    const config: AgavConfig = { ...sessionConfig, permissionMode: narrowPermissionMode(sessionConfig.permissionMode, policies.permissionMode) };
    const jobDeps = narrowJobDeps(sessionJobDeps, policies.permissionMode);
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
    // The run deadline is fixed at the first execution and persisted, so a resumed run keeps the original budget.
    if (policies.maxRuntimeSeconds !== undefined && run.deadlineAt === undefined) {
      run.deadlineAt = new Date(Date.now() + policies.maxRuntimeSeconds * 1000).toISOString();
      dirty = true;
    }
    if (dirty) await store.save(run);
    // A crash can occur after a failed node is durable but before the run's
    // terminal status is saved. Never dispatch another branch on resume
    // (with stopOnFailure:false a failed/timed-out node only skips its dependents).
    const stopped = run.nodes.find(node => node.status === "cancelled" || (stopOnFailure && (node.status === "failed" || node.status === "timed_out")));
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
    // Run deadline: aborts the running node; the run (and the interrupted node) end `timed_out`.
    let deadlineHit = false;
    const hitDeadline = (): void => { deadlineHit = true; abort(); };
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (run.deadlineAt !== undefined) {
      const remaining = Date.parse(run.deadlineAt) - Date.now();
      if (remaining <= 0) hitDeadline();
      // setTimeout's max delay is ~24.8 days; policies.maxRuntimeSeconds is capped at 7 days.
      else deadlineTimer = setTimeout(hitDeadline, remaining);
    }
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
    const failureStops = (): boolean => stopOnFailure && run.nodes.some(cp => cp.status === "failed");
    const finalStatus = (): RunStatus => {
      if (deadlineHit) return "timed_out";
      if (controller.signal.aborted) return "cancelled";
      // With stopOnFailure:false independent branches still parked on decisions keep the run waiting.
      if (!stopOnFailure && run.nodes.some(cp => cp.status === "waiting_approval")) return "waiting_approval";
      if (run.nodes.some(cp => cp.status === "timed_out")) return "timed_out";
      if (run.nodes.some(cp => cp.status === "failed")) return "failed";
      if (run.nodes.some(cp => cp.status === "cancelled")) return "cancelled";
      return run.nodes.every(cp => cp.status === "passed" || cp.status === "skipped") ? "passed" : "waiting_approval";
    };
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
            if (failureStops()) break;
          }
          const node = resume !== undefined
            ? run.definition.nodes.find(candidate => candidate.id === resume!.id)
            : run.definition.nodes.find(candidate => run.nodes.find(cp => cp.id === candidate.id)!.status === "pending" && (candidate.dependsOn ?? []).every(dep => SETTLED.has(run.nodes.find(cp => cp.id === dep)!.status)));
          if (!node) break;
          const cp = run.nodes.find(item => item.id === node.id)!;
          const resuming = resume !== undefined;
          resume = undefined;
          if (!resuming) {
            let reason: string | undefined;
            try { reason = skipReason(run, node); }
            catch (error) { reason = undefined; cp.status = "failed"; cp.error = `when could not be evaluated: ${error instanceof Error ? error.message : String(error)}`; }
            if (reason !== undefined || cp.status === "failed") {
              if (reason !== undefined) { cp.status = "skipped"; cp.error = `Skipped: ${reason}.`; }
              cp.endedAt = new Date().toISOString();
              await store.save(run);
              await appendEvent(store, id, { type: "node_completed", nodeId: node.id, status: cp.status, ...(cp.error ? { error: cp.error } : {}) });
              if (cp.status === "failed" && stopOnFailure) break;
              continue;
            }
            if (node.retry && cp.attempt === undefined) cp.attempt = 1;
          }
          const executor = getNodeExecutor(node.type);
          let result: NodeResult;
          let first = true;
          for (;;) {
            if (!resuming || !first) await appendEvent(store, id, { type: "node_started", nodeId: node.id, ...(cp.attempt !== undefined ? { attempt: cp.attempt } : {}) });
            result = await executor.execute({ store, run, node, checkpoint: cp, registry, config, signal: controller.signal, host, jobDeps, agentDeps, resuming: resuming && first });
            first = false;
            // The run deadline aborted this node: it timed out rather than being cancelled by a user.
            if (deadlineHit && cp.status === "cancelled") {
              cp.status = "timed_out"; cp.error = `Run deadline exceeded (policies.maxRuntimeSeconds=${policies.maxRuntimeSeconds}).${cp.error ? ` ${cp.error}` : ""}`;
              await store.save(run);
            }
            if (!["pending", "running", "waiting_approval"].includes(cp.status)) await appendEvent(store, id, { type: "node_completed", nodeId: node.id, status: cp.status, ...(cp.error ? { error: cp.error } : {}) });
            if (!shouldRetry(node, cp, controller.signal)) break;
            // Durable retry intent first: a crash during backoff resumes with the next attempt (and a new job requestId).
            const failure = cp.error;
            cp.attempt = (cp.attempt ?? 1) + 1;
            cp.status = "pending";
            for (const key of ["output", "error", "startedAt", "endedAt", "usage", "model", "durationMs", "job"] as const) delete cp[key];
            await store.save(run);
            await appendEvent(store, id, { type: "node_retry", nodeId: node.id, attempt: cp.attempt, ...(failure ? { error: failure } : {}) });
            await sleep((node.retry!.backoffSeconds ?? 0) * 1000, controller.signal);
            if (controller.signal.aborted) break;
          }
          if (controller.signal.aborted && cp.status === "pending") break;
          // With stopOnFailure:false a failed or timed-out node only skips its dependents; other branches continue.
          if (result.next === "stop" && (stopOnFailure || !["failed", "timed_out"].includes(cp.status))) break;
        }
        if (pollingError) throw pollingError;
        run.status = finalStatus();
        await store.save(run);
        await appendEvent(store, id, { type: "run_status", status: run.status, ...(deadlineHit ? { reason: "run deadline exceeded" } : {}) });
        // Parked. A decider that saw this runner live does not relaunch, so re-check once the park is durable:
        // a decision written before this point is applied now instead of being stranded.
        if (run.status !== "waiting_approval" || !await applyDecisions(store, run)) return run;
        decisionReady = false;
        if (failureStops()) {
          run.status = "failed";
          await store.save(run);
          await appendEvent(store, id, { type: "run_status", status: run.status });
          return run;
        }
      }
    } finally {
      clearInterval(timer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", abort);
      await polling;
    }
  });
}
