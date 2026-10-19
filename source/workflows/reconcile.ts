import { isLiveLifecycle, isTerminalLifecycle, BackgroundJobError } from "../background-jobs/types.js";
import { createBuiltinToolRegistry } from "../tools/registry-factory.js";
import { WORKFLOW_TOOLS } from "./definition.js";
import { appendEvent } from "./events.js";
import { getNodeExecutor, retriesOnResume } from "./executors.js";
import { findRunnerJob, launchRun, liveRunnerCount, updateRun, DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS, type LaunchDeps } from "./launch.js";
import { runnerRequestId, scopedCheckpoints, type WorkflowRun, type WorkflowStore } from "./store.js";
import { hasUnappliedDecision, parkUncertainNodes } from "./decisions.js";
import { postRunNotification } from "./notify.js";

/** Automatic relaunches after the runner died; beyond this the run stays `interrupted`. */
export const MAX_RUNNER_RELAUNCHES = 3;

export type ReconcileAction =
  | "none" // not a background run with a runner, terminal, parked, or its runner is live
  | "relaunched" // runner gone: interrupted, then attempt+1 launched (or queued)
  | "interrupted" // runner gone and not relaunched (bound reached or an uncertain tool node)
  | "interrupted-unknown" // runner state uncertain: never relaunched automatically
  | "admitted" // queued run started
  | "queued" // queued run still waiting for pool room
  | "parked" // runner gone with an interrupted tool node: waiting on an `uncertain_tool` decision
  | "busy"; // run lock held: a live writer owns it

export interface ReconcileResult { runId: string; action: ReconcileAction; reason?: string }

/** A running node that can neither be reattached (job) nor safely re-run (retry-safe agent/prompt) has an uncertain outcome. */
function isUncertain(run: WorkflowRun, cp: WorkflowRun["nodes"][number]): boolean {
  // Body checkpoints of loop iterations are included (ids are unique across the definition).
  const node = scopedCheckpoints(run).find(visit => visit.cp === cp)?.node;
  return !!node && cp.status === "running" && getNodeExecutor(node.type).resumable !== true && !retriesOnResume(node);
}
/** The engine refuses to replay an uncertain node, at top level or inside a loop iteration (a running loop node itself is resumable). */
function hasUncertainNode(run: WorkflowRun): boolean {
  return scopedCheckpoints(run).some(({ cp }) => isUncertain(run, cp));
}

function isLockHeld(error: unknown): boolean { return error instanceof BackgroundJobError && error.code === "lock-held"; }

async function markInterrupted(store: WorkflowStore, deps: LaunchDeps, runId: string, requestId: string, relaunch: boolean, reason: string): Promise<WorkflowRun | undefined> {
  let changed = false;
  const run = await updateRun(store, runId, deps.registry!, current => {
    // Only act on the snapshot we judged: same attempt, still non-terminal and not parked.
    if (current.runner?.requestId !== requestId || !["running", "queued"].includes(current.status)) return false;
    current.status = "interrupted";
    if (relaunch) {
      const attempt = current.runner.attempt + 1;
      current.runner = { attempt, requestId: runnerRequestId(runId, attempt), relaunches: current.runner.relaunches + 1 };
    }
    changed = true;
  });
  if (!changed) return undefined;
  await appendEvent(store, runId, { type: "run_status", status: "interrupted", reason });
  return run;
}

/** The runner is dead, so this lock holder is the single writer: park interrupted tool nodes on inbox decisions. */
async function parkUncertain(store: WorkflowStore, deps: LaunchDeps, runId: string, requestId: string, reason: string): Promise<WorkflowRun | undefined> {
  const run = await store.lock(runId, async () => {
    const current = await store.read(runId, deps.registry!);
    if (current.runner?.requestId !== requestId || !["running", "queued"].includes(current.status)) return undefined;
    if ((await parkUncertainNodes(store, current, cp => isUncertain(current, cp))).length === 0) return undefined;
    current.status = "waiting_approval";
    await store.save(current);
    return current;
  });
  if (!run) return undefined;
  await appendEvent(store, runId, { type: "run_status", status: "waiting_approval", reason: `${reason}; an interrupted tool node has an uncertain outcome` });
  await postRunNotification(store, run);
  return run;
}

/** Applies the reconcile decision table to one run. */
export async function reconcileRun(store: WorkflowStore, runId: string, deps: LaunchDeps): Promise<ReconcileResult> {
  const full: LaunchDeps = { ...deps, registry: deps.registry ?? createBuiltinToolRegistry(WORKFLOW_TOOLS) };
  const run = await store.read(runId, full.registry!);
  if (run.runner && run.consent && run.status === "waiting_approval" && await hasUnappliedDecision(store, run)) {
    // A decision landed while the parking runner was still exiting: relaunch so it is applied (idempotent).
    const job = await findRunnerJob(full.coordinator, run);
    if (job && isLiveLifecycle(job.state)) return { runId, action: "none" };
    try { await launchRun(store, runId, full); } catch (error) { if (isLockHeld(error)) return { runId, action: "busy" }; throw error; }
    return { runId, action: "relaunched", reason: "decided while parked" };
  }
  if (!run.runner || !run.consent || !["running", "queued"].includes(run.status)) return { runId, action: "none" };
  const job = await findRunnerJob(full.coordinator, run);
  if (job && isLiveLifecycle(job.state)) return { runId, action: "none" };
  if (!job && run.status === "queued") return admit(store, runId, full);
  try {
    if (job && !isTerminalLifecycle(job.state)) {
      // unknown / recovery-required: the first runner may still be alive; never start a second one.
      const marked = await markInterrupted(store, full, runId, run.runner.requestId, false, `runner job ${job.jobId} is ${job.state}`);
      return { runId, action: marked ? "interrupted-unknown" : "none", reason: `runner ${job.state}` };
    }
    const reason = job ? `runner job ${job.jobId} ${job.state}` : "runner job not found";
    if (hasUncertainNode(run)) {
      // Never replayed: the run parks on an `uncertain_tool` decision; deciding it relaunches the runner.
      const parked = await parkUncertain(store, full, runId, run.runner.requestId, reason);
      return { runId, action: parked ? "parked" : "none", reason: "uncertain tool node" };
    }
    const relaunch = run.runner.relaunches < MAX_RUNNER_RELAUNCHES;
    const marked = await markInterrupted(store, full, runId, run.runner.requestId, relaunch, reason);
    if (!marked) return { runId, action: "none" };
    if (!relaunch) return { runId, action: "interrupted", reason: `relaunch bound (${MAX_RUNNER_RELAUNCHES}) reached` };
  } catch (error) {
    if (isLockHeld(error)) return { runId, action: "busy" };
    throw error;
  }
  await launchRun(store, runId, full);
  return { runId, action: "relaunched" };
}

async function admit(store: WorkflowStore, runId: string, deps: LaunchDeps): Promise<ReconcileResult> {
  try {
    const result = await launchRun(store, runId, deps);
    return { runId, action: result.status === "queued" ? "queued" : "admitted" };
  } catch (error) {
    if (isLockHeld(error)) return { runId, action: "busy" };
    throw error;
  }
}

/**
 * Reconciles every run: dead runners first (so freed slots are visible), then queued runs FIFO by `createdAt`
 * while the workflow-runner pool has room. Per-run errors are reported, never thrown, so one bad run cannot block others.
 */
export async function reconcileRuns(store: WorkflowStore, deps: LaunchDeps): Promise<ReconcileResult[]> {
  const full: LaunchDeps = { ...deps, registry: deps.registry ?? createBuiltinToolRegistry(WORKFLOW_TOOLS) };
  const runs: WorkflowRun[] = [];
  for (const id of await store.listIds()) {
    const run = await store.read(id, full.registry!).catch(() => undefined);
    if (run?.runner && run.consent && ["running", "queued", "waiting_approval"].includes(run.status)) runs.push(run);
  }
  const results: ReconcileResult[] = [];
  const attempt = async (id: string): Promise<void> => {
    try { results.push(await reconcileRun(store, id, full)); }
    catch (error) { results.push({ runId: id, action: "none", reason: error instanceof Error ? error.message : String(error) }); }
  };
  for (const run of runs.filter(run => run.status === "running" || run.status === "waiting_approval")) await attempt(run.id);
  const max = full.maxConcurrentWorkflowRuns ?? DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS;
  for (const run of runs.filter(run => run.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (await liveRunnerCount(store, full.coordinator, full.registry!) >= max) break;
    await attempt(run.id);
  }
  return results;
}
