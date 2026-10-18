import type { ToolRegistry } from "../tools/registry.js";
import { BackgroundJobError, isLiveLifecycle } from "../background-jobs/types.js";
import { jobRequestId, WorkflowStore, type WorkflowRun } from "./store.js";
import { applyJobOutcome, JobCancellationIncompleteError, stopJobNodeOutcome, type JobNodeDeps } from "./job-node.js";
import { decide, defaultDecider, isDecisionId, listPendingDecisions, readDecision, type DecidedRecord, type DecisionKind, type PendingDecision } from "./decisions.js";
import { findRunnerJob, launchRun, type LaunchDeps, type LaunchResult } from "./launch.js";

export interface DecideOptions {
  registry: ToolRegistry;
  /** `user@host` recorded on the decision (default: this process's user and host). */
  by?: string;
  note?: string;
  /** With launch deps, a won decision on a parked run relaunches its runner (attempt+1). */
  launch?: LaunchDeps;
  /** How long to wait for a parking runner to exit before relaunching (default 5000 ms). */
  parkWaitMs?: number;
}
export interface DecideResult {
  won: boolean;
  record: DecidedRecord;
  pending: PendingDecision;
  run: WorkflowRun;
  /** `live`: the runner is still executing and applies the decision in-process. */
  relaunch?: LaunchResult | "live";
}

const TERMINAL = ["passed", "failed", "cancelled", "timed_out"];

/** The run's pending decision for `target` (a decision id, or a node id with exactly one undecided decision). */
export async function resolveDecisionTarget(store: WorkflowStore, runId: string, target: string, kind?: DecisionKind): Promise<PendingDecision> {
  if (isDecisionId(target)) {
    const state = await readDecision(store, runId, target);
    if (!state || (kind && state.pending.kind !== kind)) throw new Error(`No ${kind ?? "workflow"} decision ${target} in run ${runId}.`);
    return state.pending;
  }
  const matches = (await listPendingDecisions(store, runId)).filter(item => item.nodeId === target && (!kind || item.kind === kind));
  if (matches.length === 0) throw new Error(`Node ${target} has no pending ${kind ?? ""}${kind ? " " : ""}decision in run ${runId}.`);
  if (matches.length > 1) throw new Error(`Node ${target} has several pending decisions (${matches.map(item => item.decisionId).join(", ")}); pass the decision id.`);
  return matches[0]!;
}

/**
 * Decides any inbox decision of a run. Only a create-once `.decided.json` is written (never run.json); the
 * runner applies it. The winner of a parked run relaunches the runner, waiting briefly for a parking runner
 * to exit; a runner still executing other branches picks the decision up from `decisions/` itself.
 */
export async function decideRunDecision(store: WorkflowStore, runId: string, decisionId: string, approve: boolean, opts: DecideOptions): Promise<DecideResult> {
  const before = await store.read(runId, opts.registry);
  if (TERMINAL.includes(before.status)) throw new Error(`Run ${runId} is ${before.status}; nothing to decide.`);
  const state = await readDecision(store, runId, decisionId);
  if (!state) throw new Error(`No decision ${decisionId} in run ${runId}.`);
  const { won, record } = await decide(store, runId, decisionId, approve, opts.by ?? defaultDecider(), opts.note);
  let run = await store.read(runId, opts.registry);
  const result: DecideResult = { won, record, pending: state.pending, run };
  if (!won || !opts.launch || !run.consent || !run.runner) return result;
  const deadline = Date.now() + (opts.parkWaitMs ?? 5000);
  for (;;) {
    const job = await findRunnerJob(opts.launch.coordinator, run);
    if (!job || !isLiveLifecycle(job.state)) break;
    // Live and not parked: the runner polls decisions/ and applies this one in-process.
    if (run.status !== "waiting_approval" || Date.now() >= deadline) return { ...result, relaunch: "live" };
    await new Promise(resolve => setTimeout(resolve, 100));
    run = await store.read(runId, opts.registry);
  }
  if (TERMINAL.includes(run.status)) return { ...result, run };
  const relaunch = await launchRun(store, runId, { registry: opts.registry, ...opts.launch });
  return { ...result, run: relaunch.run, relaunch };
}

/** Decides an `approval` decision by node id or decision id (see `decideRunDecision`). */
export async function decideApproval(store: WorkflowStore, runId: string, target: string, approve: boolean, opts: DecideOptions): Promise<DecideResult> {
  const pending = await resolveDecisionTarget(store, runId, target, "approval");
  return decideRunDecision(store, runId, pending.decisionId, approve, opts);
}

/** One-line outcome for the CLI and slash command. */
export function decisionSummary(result: DecideResult): string {
  const { pending, record } = result;
  const verb = record.decision === "approve" ? "approved" : "denied";
  if (!result.won) return `Decision ${pending.decisionId} (${pending.kind} on ${pending.nodeId}) was already ${verb} by ${record.decidedBy} at ${record.decidedAt}.`;
  const follow = result.relaunch === undefined ? "" : result.relaunch === "live" ? "; the live runner applies it" : `; runner ${result.relaunch.status} (attempt ${result.relaunch.run.runner?.attempt ?? 1})`;
  return `${pending.kind} on ${pending.nodeId} ${verb} (${pending.decisionId}) in run ${result.run.id}${follow}.`;
}

/**
 * Asks the supervisor to SIGTERM a live runner so it checkpoints `cancelled` promptly. Best effort: the cancel
 * marker is already durable and a live runner polls it, so a denied or failed stop never blocks cancellation.
 */
async function stopRunner(requestId: string, jobDeps: JobNodeDeps): Promise<void> {
  try {
    const coordinator = await jobDeps.getCoordinator();
    const job = await coordinator.findByRequestId?.(requestId);
    if (!job || job.requestId !== requestId || !isLiveLifecycle(job.state)) return;
    const session = typeof jobDeps.session === "function" ? jobDeps.session() : jobDeps.session;
    await coordinator.stop(job.jobId, session);
  } catch { /* the cancel marker still stops the runner */ }
}

/**
 * Durable intent first; never claim cancellation until the executor releases its lock.
 * With `jobDeps`, a running job node is reconciled and stopped under the lock; the run is only
 * marked cancelled once every job node is terminal. Otherwise a `JobCancellationIncompleteError`
 * is thrown and the node/run stay non-terminal with their job linkage so cancel/resume can retry.
 */
export async function cancelRun(store: WorkflowStore, id: string, registry: ToolRegistry, signal?: AbortSignal, jobDeps?: JobNodeDeps): Promise<WorkflowRun> {
  const existing = await store.read(id, registry);
  if (["passed", "failed", "cancelled", "timed_out"].includes(existing.status)) return existing;
  await store.requestCancel(id);
  if (existing.runner && jobDeps) await stopRunner(existing.runner.requestId, jobDeps);
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await store.lock(id, async () => {
        const run = await store.read(id, registry);
        for (const cp of run.nodes) {
          if (cp.status !== "running") continue;
          const isJob = run.definition.nodes.find(node => node.id === cp.id)?.type === "job";
          // Tool nodes are never replayed or assumed stopped.
          if (!isJob) throw new Error("Cancellation requested, but interrupted work has an uncertain outcome; not claiming it stopped.");
          // Stop the attempt the checkpoint recorded (old checkpoints carry `-1`).
          const requestId = cp.job?.requestId ?? jobRequestId(run.id, cp.id);
          if (!jobDeps) throw new Error(`Cancellation requested, but node ${cp.id} has a running job (${requestId}) and this context has no background-job support to stop it; not claiming it stopped. Cancel from a context with job support.`);
          const outcome = await stopJobNodeOutcome(jobDeps, { requestId, jobId: cp.job?.jobId });
          applyJobOutcome(cp, outcome);
          await store.save(run); // Real outcome (or the kept linkage/reason) is durable before anything else.
          if (outcome.status === "incomplete") throw new JobCancellationIncompleteError(cp.id, outcome.error ?? "termination not confirmed");
        }
        if (!["passed", "failed", "cancelled", "timed_out"].includes(run.status)) { run.status = "cancelled"; await store.save(run); }
        return run;
      });
    } catch (error) {
      if (!(error instanceof BackgroundJobError) || error.code !== "lock-held") throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
