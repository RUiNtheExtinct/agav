import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getAgavDir } from "../config/config.js";
import { writeAtomic } from "../background-jobs/storage/atomic-file.js";
import { withJobLock } from "../background-jobs/storage/single-writer-lock.js";
import { validateDefinition, type WorkflowDefinition } from "./definition.js";
import type { ToolRegistry } from "../tools/registry.js";
import { isWorkflowConsent, type WorkflowConsent } from "./grant.js";
import { isDecisionId, type DecidedRecord } from "./decisions.js";

export type NodeStatus = "pending" | "running" | "waiting_approval" | "passed" | "failed" | "cancelled" | "timed_out" | "skipped";
/** Run lifecycle; distinct from NodeStatus (queued/cancelling/interrupted are run-only, skipped is node-only). */
export type RunStatus = "pending" | "queued" | "running" | "passed" | "failed" | "timed_out" | "waiting_approval" | "cancelling" | "cancelled" | "interrupted";
export type RunHost = "background" | "foreground";
/** Durable identity/evidence for a `job` node; requestId is deterministic so a crash before jobId is persisted stays recoverable. */
export interface JobNodeMetadata { requestId: string; jobId?: string; state?: string; exitCode?: number | null; outputTruncated?: boolean }
/** Checkpoint placeholder for an output that exceeded MAX_INLINE_OUTPUT_BYTES; the path is relative to `<root>/<runId>/`. */
export interface ArtifactRef { $artifact: string; bytes: number }
/** `decisionId` links a `waiting_approval` node to its inbox decision; `decision` is the applied result. */
export interface NodeCheckpoint { id: string; status: NodeStatus; output?: unknown; error?: string; startedAt?: string; endedAt?: string; job?: JobNodeMetadata; decisionId?: string; decision?: DecidedRecord }
/** Serialized outputs above this size are written to `<root>/<runId>/artifacts/<nodeId>.json`. */
export const MAX_INLINE_OUTPUT_BYTES = 64 * 1024;
export function artifactRelativePath(nodeId: string): string { return `artifacts/${nodeId}.json`; }
export function isArtifactRef(value: unknown): value is ArtifactRef {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "$artifact");
}
function validArtifactRef(value: unknown, nodeId: string): boolean {
  if (!isArtifactRef(value)) return false;
  const { $artifact, bytes, ...extra } = value as unknown as Record<string, unknown>;
  return Object.keys(extra).length === 0 && $artifact === artifactRelativePath(nodeId) && typeof bytes === "number" && Number.isInteger(bytes) && bytes > 0;
}
/** Deterministic, idempotent request id for a job node attempt (`-1` for the first attempt, as in older checkpoints). */
export function jobRequestId(runId: string, nodeId: string, attempt = 1): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`Invalid job attempt: ${attempt}`);
  return `wf-${runId}-${nodeId}-${attempt}`;
}
/** The attempt encoded in a job node's requestId, or undefined when it does not belong to this run/node. */
export function jobAttempt(requestId: unknown, runId: string, nodeId: string): number | undefined {
  const prefix = `wf-${runId}-${nodeId}-`;
  if (typeof requestId !== "string" || !requestId.startsWith(prefix)) return undefined;
  const suffix = requestId.slice(prefix.length);
  if (!/^[1-9][0-9]{0,5}$/.test(suffix)) return undefined;
  return Number(suffix);
}
const JOB_STATES = new Set(["accepted", "starting", "running", "completed", "failed", "interrupted", "unknown", "recovery-required"]);
/** True for lifecycle states `read` accepts; persisting anything else would make the whole run unreadable. */
export function isPersistableJobState(state: unknown): state is string { return typeof state === "string" && JOB_STATES.has(state); }
function validJobMetadata(job: unknown, runId: string, nodeId: string): boolean {
  if (!job || typeof job !== "object" || Array.isArray(job)) return false;
  const { requestId, jobId, state, exitCode, outputTruncated, ...extra } = job as Record<string, unknown>;
  return Object.keys(extra).length === 0 && jobAttempt(requestId, runId, nodeId) !== undefined &&
    (jobId === undefined || (typeof jobId === "string" && jobId.length > 0)) &&
    (state === undefined || (typeof state === "string" && JOB_STATES.has(state))) &&
    (exitCode === undefined || exitCode === null || (typeof exitCode === "number" && Number.isInteger(exitCode))) &&
    (outputTruncated === undefined || typeof outputTruncated === "boolean");
}
export interface WorkflowRun {
  version: 1; id: string; definition: WorkflowDefinition; workflowHash: string; cwd: string;
  inputs: Record<string, unknown>; status: RunStatus; nodes: NodeCheckpoint[]; createdAt: string; updatedAt: string;
  host?: RunHost;
  /** Per-invocation background consent; relaunches of this run reuse it. */
  consent?: WorkflowConsent;
  /** Linkage to the supervised runner job (`requestId = wf-run-<runId>-<attempt>`). */
  runner?: RunnerLink;
}
export interface RunnerLink { attempt: number; requestId: string; jobId?: string; relaunches: number }
/** Deterministic, idempotent request id for a run's runner job attempt. */
export function runnerRequestId(runId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`Invalid runner attempt: ${attempt}`);
  return `wf-run-${runId}-${attempt}`;
}
function validRunner(runner: unknown, runId: string): boolean {
  if (!runner || typeof runner !== "object" || Array.isArray(runner)) return false;
  const { attempt, requestId, jobId, relaunches, ...extra } = runner as Record<string, unknown>;
  return Object.keys(extra).length === 0 && typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 1 && requestId === runnerRequestId(runId, attempt) &&
    (jobId === undefined || (typeof jobId === "string" && jobId.length > 0)) && typeof relaunches === "number" && Number.isInteger(relaunches) && relaunches >= 0;
}
export function assertRunId(id: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid workflow run id (use the full UUID).");
}
export function definitionHash(def: WorkflowDefinition): string { return createHash("sha256").update(JSON.stringify(def)).digest("hex"); }
const NODE_STATUSES = new Set<string>(["pending", "running", "waiting_approval", "passed", "failed", "cancelled", "timed_out", "skipped"]);
const RUN_STATUSES = new Set<string>(["pending", "queued", "running", "passed", "failed", "timed_out", "waiting_approval", "cancelling", "cancelled", "interrupted"]);
async function syncDir(path: string): Promise<void> {
  const dir = await fs.open(path, "r").catch(() => undefined);
  try { await dir?.sync().catch(() => {}); } finally { await dir?.close(); }
}
export class WorkflowStore {
  /** Last output value spilled per `<runId>/<nodeId>`, so unchanged artifacts are not rewritten on every save. */
  private readonly spilled = new Map<string, unknown>();
  constructor(readonly root = join(getAgavDir(), "workflow-runs")) {}
  private path(id: string, suffix = ".json"): string { assertRunId(id); return join(this.root, `${id}${suffix}`); }
  /** Per-run directory (`<root>/<runId>/`) holding artifacts. */
  runDir(id: string): string { assertRunId(id); return join(this.root, id); }
  async save(run: WorkflowRun): Promise<void> {
    run.updatedAt = new Date().toISOString();
    // Oversized outputs go to artifacts first; the in-memory run keeps the full value.
    const nodes = await Promise.all(run.nodes.map(cp => this.spill(run.id, cp)));
    await writeAtomic(this.path(run.id), JSON.stringify({ ...run, nodes }, null, 2) + "\n");
    await syncDir(this.root);
  }
  private async spill(runId: string, cp: NodeCheckpoint): Promise<NodeCheckpoint> {
    // An existing (unhydrated) reference passes through unchanged.
    if (cp.output === undefined || validArtifactRef(cp.output, cp.id)) return cp;
    const serialized = JSON.stringify(cp.output);
    if (serialized === undefined) return cp;
    const bytes = Buffer.byteLength(serialized, "utf8");
    // Any other value shaped like a reference is spilled too, so a persisted `$artifact` object is always a real reference.
    if (bytes <= MAX_INLINE_OUTPUT_BYTES && !isArtifactRef(cp.output)) return cp;
    const relative = artifactRelativePath(cp.id);
    const key = `${runId}/${cp.id}`;
    if (this.spilled.get(key) !== cp.output) {
      const target = join(this.runDir(runId), relative);
      await writeAtomic(target, serialized); // Durable before the checkpoint references it.
      await syncDir(join(this.runDir(runId), "artifacts"));
      this.spilled.set(key, cp.output);
    }
    return { ...cp, output: { $artifact: relative, bytes } satisfies ArtifactRef };
  }
  /** Resolves a checkpoint output, loading an artifact reference from disk; missing or corrupt artifacts throw. */
  async readOutput(id: string, cp: NodeCheckpoint): Promise<unknown> {
    if (!isArtifactRef(cp.output)) return cp.output;
    if (!validArtifactRef(cp.output, cp.id)) throw new Error(`Corrupt workflow checkpoint; invalid artifact reference for node ${cp.id}.`);
    const text = await fs.readFile(join(this.runDir(id), cp.output.$artifact), "utf8");
    if (Buffer.byteLength(text, "utf8") !== cp.output.bytes) throw new Error(`Corrupt workflow artifact for node ${cp.id}; size mismatch.`);
    const value = JSON.parse(text) as unknown;
    this.spilled.set(`${id}/${cp.id}`, value);
    return value;
  }
  /** Replaces artifact references in `run` with their stored values (executors need real outputs). */
  async hydrateOutputs(run: WorkflowRun): Promise<void> {
    for (const cp of run.nodes) if (isArtifactRef(cp.output)) cp.output = await this.readOutput(run.id, cp);
  }
  async read(id: string, registry: ToolRegistry): Promise<WorkflowRun> {
    // Corruption/I/O failures propagate; never treat them as a fresh run.
    const run = JSON.parse(await fs.readFile(this.path(id), "utf8")) as WorkflowRun;
    if (!run || run.version !== 1 || run.id !== id || typeof run.cwd !== "string" || !run.inputs || typeof run.inputs !== "object" || Array.isArray(run.inputs) ||
        (run.host !== undefined && run.host !== "background" && run.host !== "foreground")) throw new Error("Invalid workflow checkpoint.");
    validateDefinition(run.definition, registry);
    // Consent must be bound to this exact definition and cwd; a mismatched record never authorizes anything.
    if ((run.consent !== undefined && (!isWorkflowConsent(run.consent) || run.consent.definitionHash !== run.workflowHash || run.consent.cwd !== run.cwd)) ||
        (run.runner !== undefined && !validRunner(run.runner, run.id))) throw new Error("Invalid workflow checkpoint.");
    if (run.workflowHash !== definitionHash(run.definition) || !RUN_STATUSES.has(run.status) || !Array.isArray(run.nodes) || run.nodes.length !== run.definition.nodes.length || run.nodes.some((node, i) => !node || node.id !== run.definition.nodes[i]!.id || !NODE_STATUSES.has(node.status) || (isArtifactRef(node.output) && !validArtifactRef(node.output, node.id)))) throw new Error("Corrupt workflow checkpoint; refusing execution.");
    const checkpoints = new Map(run.nodes.map(node => [node.id, node]));
    for (const [i, node] of run.definition.nodes.entries()) {
      const cp = run.nodes[i]!;
      const deps = (node.dependsOn ?? []).map(dep => checkpoints.get(dep)!.status);
      // Every dispatched/decided node requires passed dependencies, including
      // approvals. Check all nodes so a forged passed ancestor cannot unblock work.
      // A skipped node only requires settled (passed/skipped) dependencies.
      // A tool node may wait on an inbox decision (tool consent / uncertain outcome), never without one.
      if ((node.type === "tool" && cp.status === "waiting_approval" && cp.decisionId === undefined) ||
          (cp.decisionId !== undefined && (typeof cp.decisionId !== "string" || !isDecisionId(cp.decisionId))) ||
          (node.type === "approval" && !["pending", "waiting_approval", "passed", "failed"].includes(cp.status)) ||
          (node.type === "job" && cp.status === "waiting_approval") ||
          (cp.job !== undefined && (node.type !== "job" || !validJobMetadata(cp.job, run.id, node.id))) ||
          // A running or passed job must carry its durable identity; fail closed otherwise.
          (node.type === "job" && (cp.status === "running" || cp.status === "passed") && cp.job === undefined) ||
          (cp.status === "skipped" && !deps.every(status => status === "passed" || status === "skipped")) ||
          (cp.status !== "pending" && cp.status !== "skipped" && !deps.every(status => status === "passed"))) {
        throw new Error("Corrupt workflow checkpoint; invalid node state or dependencies.");
      }
    }
    // Keep node-before-run crash snapshots valid (e.g. a decided approval while
    // the run still says waiting_approval), but reject impossible settled states.
    if (run.nodes.filter(node => node.status === "running").length > 1 ||
        (run.status === "pending" && run.nodes.some(node => node.status !== "pending")) ||
        (run.status === "passed" && run.nodes.some(node => node.status !== "passed" && node.status !== "skipped"))) {
      throw new Error("Corrupt workflow checkpoint; invalid run state.");
    }
    return run;
  }
  /** Ids of every run checkpoint in the store (unordered); a missing root means no runs. */
  async listIds(): Promise<string[]> {
    let names: string[];
    try { names = await fs.readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return names.filter(name => name.endsWith(".json")).map(name => name.slice(0, -5)).filter(id => { try { assertRunId(id); return true; } catch { return false; } });
  }
  async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    assertRunId(id);
    await fs.mkdir(join(this.root, "locks"), { recursive: true, mode: 0o700 });
    return withJobLock(this.root, id, fn);
  }
  async requestCancel(id: string): Promise<void> { await writeAtomic(this.path(id, ".cancel"), "cancel\n"); }
  async cancellationRequested(id: string): Promise<boolean> {
    try { await fs.access(this.path(id, ".cancel")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
}
