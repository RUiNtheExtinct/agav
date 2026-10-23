import { BackgroundJobError, type StartJobRequest } from "../background-jobs/types.js";
import { loadConfig, type AgavConfig } from "../config/config.js";
import { createBuiltinToolRegistry } from "../tools/registry-factory.js";
import type { ToolRegistry } from "../tools/registry.js";
import { applySandboxRequiredPolicy } from "../utils/sandbox-startup.js";
import { detectSandboxBackend, isSandboxRequired, setSandboxRequired } from "../utils/sandbox.js";
import { WORKFLOW_TOOLS } from "./definition.js";
import { consentCoversJob, consentSession, type WorkflowConsent } from "./grant.js";
import { createBackgroundHost } from "./hosts.js";
import type { JobCoordinatorLike, JobNodeDeps } from "./job-node.js";
import { postRunNotification } from "./notify.js";
import { executeRun } from "./runtime.js";
import { createProvider } from "../providers/registry.js";
import { createDefaultAgentInvoker, type AgentInvoker } from "./agent-invoker.js";
import type { AgentNodeDeps } from "./agent-node.js";
import { WorkflowStore, type WorkflowRun } from "./store.js";
import type { LaunchDeps } from "./launch.js";
import { updateRun } from "./launch.js";
import { admitQueuedRuns } from "./reconcile.js";

/** SIGTERM must checkpoint within this window, under the supervisor's 5 s SIGKILL grace. */
export const RUNNER_SHUTDOWN_GRACE_MS = 4000;

/**
 * Headless job deps for the runner: only literal job commands covered by the consent may start, and the
 * `stop` deadlines fit inside the shutdown grace so a SIGTERM can still checkpoint `cancelled`.
 */
export function runnerJobDeps(consent: WorkflowConsent, getCoordinator: () => Promise<JobCoordinatorLike>, sandboxRequired: boolean, overrides: Partial<JobNodeDeps> = {}): JobNodeDeps {
  const guarded = async (): Promise<JobCoordinatorLike> => {
    const coordinator = await getCoordinator();
    return {
      poll: id => coordinator.poll(id),
      log: (id, opts) => coordinator.log(id, opts),
      stop: (id, session) => coordinator.stop(id, session),
      ...(coordinator.findByRequestId ? { findByRequestId: (requestId: string) => coordinator.findByRequestId!(requestId) } : {}),
      start: async (request: StartJobRequest, session) => {
        if (request.invocation.mode !== "shell" || !consentCoversJob(consent, request.invocation.commandText)) {
          throw new BackgroundJobError("authorization-denied", "Job command is not covered by this workflow run's consent.");
        }
        return coordinator.start(request, session);
      },
    };
  };
  return {
    getCoordinator: guarded,
    session: () => consentSession(consent, ["start", "stop"]),
    sandboxRequired,
    headless: true,
    stopDeadlineMs: 2500,
    stopSettleMs: 1000,
    ...overrides,
  };
}

export interface RunnerContext {
  store: WorkflowStore;
  registry: ToolRegistry;
  config: AgavConfig;
  getCoordinator: () => Promise<JobCoordinatorLike>;
  sandboxRequired?: boolean;
  jobDepsOverrides?: Partial<JobNodeDeps>;
  /** Agent/prompt node deps; defaults to `defaultAgentNodeDeps()` (provider from the effective config). */
  agentDeps?: AgentNodeDeps;
  graceMs?: number;
  /**
   * Launch deps for admitting the oldest queued runs once this runner has settled/parked and released the run
   * lock (its own still-exiting job does not count toward the pool). Omitted: no admission.
   */
  admitQueued?: Omit<LaunchDeps, "registry" | "exitingRunId">;
}

/** Real agent deps: the invoker (and its provider, via the app's `createProvider`) is built on first use from the run's effective config. */
export function defaultAgentNodeDeps(): AgentNodeDeps {
  let invoker: AgentInvoker | undefined;
  return { getInvoker: config => (invoker ??= createDefaultAgentInvoker({ provider: createProvider(config), config })) };
}
export interface RunnerHandle {
  done: Promise<WorkflowRun>;
  /** Aborts the run, stops child jobs and waits (bounded by the grace) for the `cancelled` checkpoint. */
  shutdown(): Promise<WorkflowRun | undefined>;
}

/** Starts executing a consented background run; the engine itself is unchanged, only the host/deps differ. */
export function startRunner(runId: string, ctx: RunnerContext): RunnerHandle {
  const controller = new AbortController();
  const done = (async () => {
    const run = await ctx.store.read(runId, ctx.registry);
    const consent = run.consent;
    if (!consent) throw new Error(`Workflow run ${runId} has no background consent; refusing to execute.`);
    // The consent's permission mode applies, never a looser one from the runner's own config.
    const config: AgavConfig = { ...ctx.config, permissionMode: consent.permissionMode };
    // The run's persisted requirement (from the launching process) can only be strengthened by this process's config/flags, never weakened.
    const sandboxRequired = run.sandboxRequired === true || ctx.sandboxRequired === true || ctx.config.sandboxRequired === true || isSandboxRequired();
    if (sandboxRequired) {
      setSandboxRequired(true); // run_command in this process
      // Fail closed: if the requirement cannot be made durable, nothing executes (a relaunch would otherwise lose it).
      if (run.sandboxRequired !== true) await updateRun(ctx.store, runId, ctx.registry, current => { current.sandboxRequired = true; });
    }
    const jobDeps = runnerJobDeps(consent, ctx.getCoordinator, sandboxRequired, ctx.jobDepsOverrides);
    // Parks (waiting_approval) or finishes, then the runner exits; deciding a parked run relaunches it.
    const settled = await executeRun(ctx.store, runId, ctx.registry, config, controller.signal, createBackgroundHost(consent, { store: ctx.store, runId }), jobDeps, ctx.agentDeps ?? defaultAgentNodeDeps());
    await postRunNotification(ctx.store, settled);
    // executeRun has released the run lock: hand this runner's pool slot to the oldest queued run. Best effort.
    if (ctx.admitQueued) await admitQueuedRuns(ctx.store, { ...ctx.admitQueued, registry: ctx.registry, exitingRunId: runId }).catch(() => undefined);
    return settled;
  })();
  let shuttingDown: Promise<WorkflowRun | undefined> | undefined;
  const shutdown = (): Promise<WorkflowRun | undefined> => {
    shuttingDown ??= (async () => {
      // Durable intent first: if this process is killed anyway, a relaunch sees the marker and cancels.
      await ctx.store.requestCancel(runId).catch(() => {});
      controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ctx.graceMs ?? RUNNER_SHUTDOWN_GRACE_MS); });
      try { return await Promise.race([done.catch(() => undefined), timeout]); }
      finally { clearTimeout(timer); }
    })();
    return shuttingDown;
  };
  return { done, shutdown };
}

/** Entry point for `--internal-workflow-runner <runId>`; returns the process exit code. */
export async function runWorkflowRunner(runId: string | undefined): Promise<number> {
  if (!runId) throw new Error("Missing workflow run id.");
  const config = await loadConfig();
  if (config.backgroundJobsEnabled !== true || config.workflowsEnabled !== true) throw new Error("Workflows require backgroundJobsEnabled=true AND workflowsEnabled=true.");
  applySandboxRequiredPolicy({ flagSet: false, configValue: config.sandboxRequired, detectBackend: detectSandboxBackend, setRequired: setSandboxRequired, warn: message => { process.stderr.write(message); } });
  const { getSharedCoordinator } = await import("../background-jobs-integration.js");
  const { cliEntryPath } = await import("./background.js");
  const handle = startRunner(runId, {
    store: new WorkflowStore(),
    registry: createBuiltinToolRegistry(WORKFLOW_TOOLS),
    config,
    getCoordinator: getSharedCoordinator,
    sandboxRequired: isSandboxRequired(),
    admitQueued: { coordinator: await getSharedCoordinator(), cliPath: await cliEntryPath(), maxConcurrentWorkflowRuns: config.maxConcurrentWorkflowRuns },
  });
  const onSignal = (): void => { void handle.shutdown(); };
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  try {
    const run = await handle.done;
    process.stdout.write(`Workflow run ${run.id}: ${run.status}\n`);
    return ["failed", "cancelled", "timed_out"].includes(run.status) ? 1 : 0;
  } finally {
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
  }
}
