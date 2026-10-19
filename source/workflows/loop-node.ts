import type { WorkflowNode } from "./definition.js";
import { appendEvent } from "./events.js";
import { evaluateCondition } from "./expr.js";
import { getNodeExecutor, retriesOnResume, type NodeExecutionContext, type NodeExecutor, type NodeResult } from "./executors.js";
import type { TemplateContext } from "./interpolate.js";
import { MAX_INLINE_OUTPUT_BYTES, toleratedFailure, type LoopIterationCheckpoint, type LoopNodeCheckpoint, type NodeCheckpoint, type NodeStatus } from "./store.js";

const DEFAULT_HISTORY_LIMIT = 5;
const TERMINAL = new Set<NodeStatus>(["passed", "failed", "cancelled", "timed_out", "skipped"]);

const outputsOf = (it: LoopIterationCheckpoint): Record<string, unknown> => Object.fromEntries(Object.values(it.nodes).map(cp => [cp.id, cp.output]));

/** A history output capped at MAX_INLINE_OUTPUT_BYTES: larger values become a truncated JSON text with a size note. */
export function capHistoryOutput(output: unknown): unknown {
  const text = output === undefined ? undefined : JSON.stringify(output);
  if (text === undefined || Buffer.byteLength(text, "utf8") <= MAX_INLINE_OUTPUT_BYTES) return output;
  const bytes = Buffer.byteLength(text, "utf8");
  // Slice by bytes and drop a split trailing multi-byte character.
  const head = Buffer.from(text, "utf8").subarray(0, MAX_INLINE_OUTPUT_BYTES).toString("utf8").replace(/\uFFFD$/, "");
  return `${head}… (truncated; ${bytes} bytes)`;
}

/** `loop.*` for iteration `i`: its index, the previous iteration's body view, and the last `historyLimit` finished iterations. */
export function loopContext(node: WorkflowNode, iterations: LoopIterationCheckpoint[], i: number): NonNullable<TemplateContext["loop"]> {
  const prevIt = i > 0 ? iterations[i - 1] : undefined;
  const limit = node.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const finished = iterations.slice(0, i).filter(it => TERMINAL.has(it.status));
  // Each history output is capped so `limit` large iterations cannot blow up the interpolation context.
  const history = limit > 0 ? finished.slice(-limit).map(it => ({ index: it.index, status: it.status, outputs: Object.fromEntries(Object.entries(outputsOf(it)).map(([id, out]) => [id, capHistoryOutput(out)])) })) : [];
  return {
    index: i, history,
    ...(prevIt ? { prev: Object.fromEntries(Object.values(prevIt.nodes).map(cp => [cp.id, { status: cp.status, output: cp.output }])) } : {}),
  };
}

/**
 * On resume of a running iteration, normalizes interrupted body work like `executeRun` does at the top level:
 * a running job (or nested loop) is reattached, a retry-safe agent/prompt is re-dispatched, and any other
 * interrupted node (tool, retrySafe:false agent) is failed closed, never replayed.
 */
function normalizeResumedBody(body: WorkflowNode[], cps: Record<string, NodeCheckpoint>): NodeCheckpoint | undefined {
  let resume: NodeCheckpoint | undefined;
  for (const child of body) {
    const cp = cps[child.id]!;
    if (cp.status !== "running") continue;
    if (getNodeExecutor(child.type).resumable === true && resume === undefined) { resume = cp; continue; }
    if (retriesOnResume(child)) {
      cp.status = "pending";
      for (const key of ["output", "error", "startedAt", "endedAt", "usage", "model", "durationMs"] as const) delete cp[key];
      continue;
    }
    cp.status = "failed"; cp.endedAt = new Date().toISOString();
    cp.error = `uncertain: interrupted ${child.tool ?? child.type} node ${child.id} inside a loop has an unknown outcome; not replayed.`;
  }
  return resume;
}

/**
 * Sequential loop: runs `body` as a nested scope once per iteration (checkpointed in `iterations[i].nodes`) until
 * `stopWhen`/`until` holds after a passed iteration, a body failure, or `maxIterations` (then `onExhausted`).
 * An iteration whose only failures are tolerated (`continueOnError`) body nodes counts as passed, so
 * `stopWhen`/`until` still see the failed statuses (e.g. "run tests, fix, repeat until tests pass").
 * A waiting/cancelled iteration propagates and is continued on resume. `timeoutSeconds` bounds the whole loop,
 * measured from the loop's first start.
 */
async function executeLoop(ctx: NodeExecutionContext): Promise<NodeResult> {
  const { store, run, node, signal } = ctx;
  const cp = ctx.checkpoint as LoopNodeCheckpoint;
  const body = node.body!;
  const max = node.maxIterations!;
  const save = (): Promise<void> => store.save(run);
  const settle = async (status: NodeStatus, extra: { output?: unknown; error?: string } = {}): Promise<NodeResult> => {
    cp.status = status;
    if (extra.output !== undefined) cp.output = extra.output;
    if (extra.error !== undefined) cp.error = extra.error;
    if (TERMINAL.has(status)) cp.endedAt = new Date().toISOString();
    await save();
    return { next: status === "passed" || status === "waiting_approval" ? "continue" : "stop" };
  };
  if (!ctx.runSubScope) return settle("failed", { error: "loop execution unavailable in this context" });

  if (cp.status !== "running") { cp.status = "running"; delete cp.error; delete cp.output; delete cp.endedAt; }
  cp.startedAt ??= new Date().toISOString();
  cp.iterations ??= [];
  await save();

  const child = new AbortController();
  const abortChild = (): void => { child.abort(); };
  signal.addEventListener("abort", abortChild, { once: true });
  if (signal.aborted) abortChild();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (node.timeoutSeconds !== undefined) {
    const started = Date.parse(cp.startedAt);
    const remaining = (Number.isNaN(started) ? Date.now() : started) + node.timeoutSeconds * 1000 - Date.now();
    const fire = (): void => { if (!signal.aborted) { timedOut = true; child.abort(); } };
    if (remaining <= 0) fire(); else timer = setTimeout(fire, remaining);
  }
  const timeoutError = `Loop timed out after ${node.timeoutSeconds}s.`;
  let resuming = ctx.resuming;
  try {
    for (let i = cp.iteration ?? 0; i < max; i++) {
      let it = cp.iterations[i];
      if (!it) {
        it = { index: i, status: "running", nodes: Object.fromEntries(body.map(n => [n.id, { id: n.id, status: "pending" as const }])), startedAt: new Date().toISOString() };
        cp.iterations[i] = it;
        cp.iteration = i;
        await save();
        await appendEvent(store, run.id, { type: "loop_iteration_started", nodeId: node.id, iteration: i });
      }
      const loop = loopContext(node, cp.iterations, i);
      if (!TERMINAL.has(it.status)) {
        // Resumed (or re-dispatched after waiting) iteration: continue it in place.
        const resume = resuming ? normalizeResumedBody(body, it.nodes) : undefined;
        resuming = false;
        it.status = "running";
        await save();
        const status = await ctx.runSubScope({
          nodes: body, checkpoints: it.nodes, loop,
          jobScope: { loopPath: [...(ctx.jobScope?.loopPath ?? []), { loopId: node.id, iteration: i }] },
          outerNodes: { ...(ctx.scopeNodes ?? Object.fromEntries(run.nodes.map(n => [n.id, n]))) },
        }, { signal: child.signal, ...(resume ? { resume } : {}) });
        if (status === "waiting_approval") { it.status = "waiting_approval"; return await settle("waiting_approval"); }
        it.status = timedOut && (status === "cancelled" || status === "timed_out") ? "timed_out" : status;
        it.endedAt = new Date().toISOString();
        await save();
        await appendEvent(store, run.id, { type: "loop_iteration_completed", nodeId: node.id, iteration: i, status: it.status });
      }
      if (it.status === "cancelled") return await settle("cancelled", { error: `iteration ${i} cancelled` });
      if (it.status !== "passed") {
        const failed = body.find(n => { const c = it!.nodes[n.id]!; return (c.status === "failed" || c.status === "timed_out") && !toleratedFailure(n, c); });
        const failedCp = failed ? it.nodes[failed.id] : undefined;
        const error = it.status === "timed_out" && timedOut ? timeoutError : `iteration ${i} ${it.status}${failedCp ? `: ${failedCp.id}: ${failedCp.error ?? failedCp.status}` : ""}`;
        return await settle(it.status === "timed_out" ? "timed_out" : "failed", { error });
      }
      let stop: boolean;
      try {
        if (node.stopWhen) stop = it.nodes[node.stopWhen.node]?.status === node.stopWhen.status;
        else if (node.until !== undefined) {
          const view = (cps: NodeCheckpoint[]): Array<[string, { status: string; output?: unknown }]> => cps.map(n => [n.id, { status: n.status, output: n.output }]);
          const outer = Object.values(ctx.scopeNodes ?? Object.fromEntries(run.nodes.map(n => [n.id, n])));
          stop = evaluateCondition(node.until, { inputs: run.inputs, nodes: Object.fromEntries([...view(outer), ...view(Object.values(it.nodes))]), loop });
        } else stop = false;
      } catch (error) {
        return await settle("failed", { error: `until could not be evaluated: ${error instanceof Error ? error.message : String(error)}` });
      }
      if (stop) return await settle("passed", { output: outputsOf(it) });
      if (signal.aborted || child.signal.aborted) break;
      if (i + 1 < max) { cp.iteration = i + 1; await save(); }
    }
    if (timedOut) return await settle("timed_out", { error: timeoutError });
    if (signal.aborted) return await settle("cancelled");
    const last = cp.iterations[cp.iterations.length - 1];
    if (node.onExhausted === "continue") return await settle("passed", { output: last ? outputsOf(last) : {} });
    return await settle("failed", { error: `loop exhausted after ${max} iterations` });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abortChild);
  }
}

/** Resumable: a running loop is re-entered on resume and continues its current iteration. */
export const loopExecutor: NodeExecutor = { type: "loop", resumable: true, execute: executeLoop };
