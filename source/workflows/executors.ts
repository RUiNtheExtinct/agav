import type { AgavConfig } from "../config/config.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { WorkflowNode } from "./definition.js";
import { gatedToolExecute, type WorkflowExecutionHost } from "./gated-tools.js";
import { applyJobOutcome, JobCancellationIncompleteError, runJobNode, type JobNodeDeps } from "./job-node.js";
import { jobRequestId, type NodeCheckpoint, type WorkflowRun, type WorkflowStore } from "./store.js";
import { createPendingDecision, DecisionPendingError, parkCheckpoint } from "./decisions.js";
import { appendEvent } from "./events.js";
import { resolveTemplate, type TemplateContext } from "./interpolate.js";
import { agentExecutor, promptExecutor, type AgentNodeDeps } from "./agent-node.js";

/** Everything a node executor may use; trusted host callbacks never come from the definition. */
export interface NodeExecutionContext {
  store: WorkflowStore;
  run: WorkflowRun;
  node: WorkflowNode;
  /** The node's checkpoint inside `run.nodes`; executors mutate it and persist via `store.save(run)`. */
  checkpoint: NodeCheckpoint;
  registry: ToolRegistry;
  config: AgavConfig;
  /** Run-level abort (caller signal or durable cancel marker). */
  signal: AbortSignal;
  host?: WorkflowExecutionHost;
  jobDeps?: JobNodeDeps;
  /** Invoker (and agent loader) for agent/prompt nodes. */
  agentDeps?: AgentNodeDeps;
  /** Enclosing loop context for interpolation, and the iteration path used to key decisions (loop nodes). */
  loop?: TemplateContext["loop"];
  iteration?: number[];
  /** True when a running checkpoint is being reattached instead of freshly dispatched. */
  resuming: boolean;
}
/** `continue`: pick the next ready node. `stop`: end scheduling (the run status is derived from checkpoints). */
export interface NodeResult { next: "continue" | "stop" }
export interface NodeExecutor {
  type: WorkflowNode["type"];
  /** Only executors that can reattach out-of-process work may be resumed from a running checkpoint. */
  resumable?: boolean;
  /** Non-resumable executors whose interrupted (running) node may be re-dispatched from scratch on resume. */
  retryOnResume?: (node: WorkflowNode) => boolean;
  execute(ctx: NodeExecutionContext): Promise<NodeResult>;
}

/** Resolves `${...}` references in tool input against run inputs and node checkpoints (see interpolate.ts). */
export function interpolate(value: unknown, run: WorkflowRun): unknown {
  return resolveTemplate(value, { inputs: run.inputs, nodes: Object.fromEntries(run.nodes.map(cp => [cp.id, { status: cp.status, output: cp.output }])) });
}

/** Approval gates park the node on an inbox decision; other ready branches still run. */
export const approvalExecutor: NodeExecutor = {
  type: "approval",
  async execute({ store, run, node, checkpoint: cp }) {
    const decision = await createPendingDecision(store, run.id, { kind: "approval", nodeId: node.id, summary: node.prompt ?? `Approve ${node.id}` });
    parkCheckpoint(cp, decision);
    await store.save(run);
    await appendEvent(store, run.id, { type: "decision_requested", nodeId: node.id, decisionId: decision.decisionId, kind: decision.kind });
    return { next: "continue" };
  },
};

/** Tool nodes go only through `gatedToolExecute`; never replayed after an interruption. */
export const toolExecutor: NodeExecutor = {
  type: "tool",
  async execute({ store, run, node, checkpoint: cp, registry, config, signal, host }) {
    cp.status = "running"; cp.startedAt = new Date().toISOString();
    await store.save(run); // Dispatch only after the running checkpoint is durable.
    const child = new AbortController();
    const abortChild = (): void => { child.abort(); };
    signal.addEventListener("abort", abortChild, { once: true });
    if (signal.aborted) abortChild();
    let timedOut = false;
    const timeout = node.timeoutSeconds === undefined ? undefined : setTimeout(() => { timedOut = true; child.abort(); }, node.timeoutSeconds * 1000);
    try {
      const input = interpolate(node.input ?? {}, run) as Record<string, unknown>;
      // No Promise.race: non-cooperative tools must settle before return or retry.
      const result = await gatedToolExecute(registry, node.tool!, input, config, child.signal, host, { nodeId: node.id });
      cp.output = result.output;
      cp.status = timedOut ? "timed_out" : signal.aborted ? "cancelled" : result.isError ? "failed" : "passed";
      if (result.isError) cp.error = result.output;
    } catch (error) {
      if (error instanceof DecisionPendingError && !signal.aborted && !timedOut) {
        // Nothing ran: the node waits on its tool-consent decision while independent branches continue.
        parkCheckpoint(cp, error.decision);
        await store.save(run);
        return { next: "continue" };
      }
      cp.status = timedOut ? "timed_out" : signal.aborted ? "cancelled" : "failed";
      cp.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", abortChild);
    }
    cp.endedAt = new Date().toISOString();
    await store.save(run);
    return { next: cp.status === "passed" ? "continue" : "stop" };
  },
};

/** Job nodes start once per attempt via an idempotent requestId and reattach on resume. */
export const jobExecutor: NodeExecutor = {
  type: "job",
  resumable: true,
  async execute({ store, run, node, checkpoint: cp, signal, jobDeps, resuming }) {
    await runJobCheckpoint(store, run, cp, node.command!, jobDeps, signal, resuming);
    // Cancellation could not be confirmed: the job may still be live. Keep the run non-terminal
    // (node stays running with its job linkage) so a later resume/cancel can retry the stop.
    if (cp.status === "running") throw new JobCancellationIncompleteError(cp.id, cp.error ?? "the job's termination was not confirmed");
    return { next: cp.status === "passed" ? "continue" : "stop" };
  },
};

const EXECUTORS = new Map<string, NodeExecutor>([toolExecutor, approvalExecutor, jobExecutor, agentExecutor, promptExecutor].map(executor => [executor.type, executor]));
/** True when an interrupted (running) node of this definition node is re-dispatched instead of parked as uncertain. */
export function retriesOnResume(node: WorkflowNode): boolean {
  return getNodeExecutor(node.type).retryOnResume?.(node) === true;
}
/** Registry lookup; an unknown node type is a programming error (validation rejects it first). */
export function getNodeExecutor(type: string): NodeExecutor {
  const executor = EXECUTORS.get(type);
  if (!executor) throw new Error(`No executor for workflow node type: ${type}`);
  return executor;
}

/** Executes one job node; the requestId is durable before any start and the jobId right after admission. */
async function runJobCheckpoint(store: WorkflowStore, run: WorkflowRun, cp: NodeCheckpoint, command: string, deps: JobNodeDeps | undefined, signal: AbortSignal, resuming: boolean): Promise<void> {
  // A resumed node reattaches with the attempt id it persisted (old checkpoints carry `-1`).
  const requestId = resuming && cp.job?.requestId ? cp.job.requestId : jobRequestId(run.id, cp.id);
  if (!resuming) {
    if (!deps) {
      cp.status = "failed"; cp.error = "Job nodes unavailable: this execution context supplies no background-job support; no job was launched.";
      cp.startedAt = new Date().toISOString(); cp.endedAt = cp.startedAt;
      await store.save(run);
      return;
    }
    cp.status = "running"; cp.startedAt = new Date().toISOString(); cp.job = { requestId };
    await store.save(run); // Evidence of intent is durable before the workload can exist.
  } else if (!deps) {
    // Keep the running checkpoint so a later resume with job support can still reattach.
    throw new Error(`Job nodes unavailable: node ${cp.id} has a running job (${requestId}); resume with background-job support to reattach.`);
  }
  let admitted = false;
  try {
    const outcome = await runJobNode(deps, {
      requestId, command, cwd: run.cwd, jobId: cp.job?.jobId, resume: resuming, signal,
      onAdmitted: async job => { admitted = true; cp.job = { ...cp.job, ...job }; await store.save(run); },
    });
    // "incomplete" keeps the node running (with its job) and records the reason; it is not terminal.
    applyJobOutcome(cp, outcome);
    if (outcome.status === "incomplete") { await store.save(run); return; }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The durable running checkpoint (with its requestId) exists, so the job may be live: after admission, on
    // resume, or after a throw anywhere around `start`. Never mark the node terminal on an unexpected throw:
    // keep it running with its linkage, note the error and rethrow so the run stays non-terminal and a later
    // resume/cancel can reattach (cf. JobCancellationIncompleteError). Plain "start failed / not found" outcomes
    // are returned (not thrown) by runJobNode and stay ordinary failures below.
    cp.status = "running"; delete cp.endedAt;
    cp.error = `uncertain: job ${requestId}${admitted ? "" : " (admission not confirmed)"} may still be live; ${reason}`;
    try { await store.save(run); } catch { /* the original error is the one to surface */ }
    throw error;
  }
  cp.endedAt = new Date().toISOString();
  await store.save(run);
}
