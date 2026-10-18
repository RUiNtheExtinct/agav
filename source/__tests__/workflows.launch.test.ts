import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { PlatformCapabilities } from "../background-jobs/types.js";
import { buildConsent } from "../workflows/grant.js";
import { launchRun, runnerLaunchSession } from "../workflows/launch.js";
import { reconcileRuns } from "../workflows/reconcile.js";
import { createRun } from "../workflows/runtime.js";
import { WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import { def, FakeCoordinator, registry, tempStore } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const definition = def([{ id: "a", type: "job", command: "echo hi" }]);
const CLI = "/opt/agav/build/cli.js";

async function backgroundRun(envNames: string[] = []): Promise<WorkflowRun> {
  const run = await createRun(store, definition, {}, { host: "background" });
  run.consent = buildConsent(definition, run.cwd, "ask", envNames);
  await store.lock(run.id, () => store.save(run));
  return run;
}

class CapCoordinator extends FakeCoordinator {
  constructor(private readonly nativeHelperAvailable = true) { super(); }
  async capabilities(): Promise<PlatformCapabilities> {
    return { platform: "linux", availableIsolationBackends: [], strongestOwnershipScope: "process-group", supportsGracefulApplicationShutdown: true, supportsDelegatedCgroup: false, nativeHelperAvailable: this.nativeHelperAvailable, limitations: this.nativeHelperAvailable ? [] : ["no helper"] } as PlatformCapabilities;
  }
}

describe("launchRun", () => {
  it("starts one supervised runner job with the expected request", async () => {
    const run = await backgroundRun(["OPENAI_API_KEY"]);
    const coordinator = new CapCoordinator();
    const result = await launchRun(store, run.id, { coordinator, cliPath: CLI });
    expect(result.status).toBe("started");
    expect(coordinator.starts).toHaveLength(1);
    expect(coordinator.starts[0]).toEqual({
      requestId: `wf-run-${run.id}-1`,
      invocation: { mode: "direct", executable: process.execPath, args: [CLI, "--internal-workflow-runner", run.id] },
      cwd: run.cwd, envInherit: ["OPENAI_API_KEY"], isolation: { backend: "none", required: false }, headless: true,
    });
    const saved = await store.read(run.id, registry);
    expect(saved.status).toBe("queued");
    expect(saved.runner).toEqual({ attempt: 1, requestId: `wf-run-${run.id}-1`, jobId: "job-1", relaunches: 0 });
  });

  it("is idempotent: a second launch reattaches and never starts a second runner", async () => {
    const run = await backgroundRun();
    const coordinator = new CapCoordinator();
    await launchRun(store, run.id, { coordinator, cliPath: CLI });
    const again = await launchRun(store, run.id, { coordinator, cliPath: CLI });
    expect(again.status).toBe("attached");
    expect(again.job?.jobId).toBe("job-1");
    expect(coordinator.starts).toHaveLength(1);
  });

  it("refuses when the coordinator reports nativeHelperAvailable:false", async () => {
    const run = await backgroundRun();
    const coordinator = new CapCoordinator(false);
    await expect(launchRun(store, run.id, { coordinator, cliPath: CLI })).rejects.toThrow(/native process helper is missing/);
    expect(coordinator.starts).toHaveLength(0);
    expect((await store.read(run.id, registry)).status).toBe("pending");
  });

  it("refuses a run without consent", async () => {
    const run = await createRun(store, definition, {}, { host: "background" });
    await expect(launchRun(store, run.id, { coordinator: new CapCoordinator(), cliPath: CLI })).rejects.toThrow(/no background consent/);
  });

  it("queues when the workflow-runner pool is full and admits the run once a slot frees", async () => {
    const coordinator = new CapCoordinator();
    const first = await backgroundRun();
    const second = await backgroundRun();
    expect((await launchRun(store, first.id, { coordinator, cliPath: CLI, maxConcurrentWorkflowRuns: 1 })).status).toBe("started");
    const queued = await launchRun(store, second.id, { coordinator, cliPath: CLI, maxConcurrentWorkflowRuns: 1 });
    expect(queued.status).toBe("queued");
    expect((await store.read(second.id, registry)).status).toBe("queued");
    expect(coordinator.starts).toHaveLength(1);

    // Still full: reconcile leaves it queued.
    await reconcileRuns(store, { coordinator, cliPath: CLI, maxConcurrentWorkflowRuns: 1 });
    expect(coordinator.starts).toHaveLength(1);

    // The first runner finishes its run, freeing the slot.
    const firstRun = await store.read(first.id, registry);
    firstRun.status = "passed"; firstRun.nodes[0]!.status = "passed"; firstRun.nodes[0]!.job = { requestId: `wf-${first.id}-a-1`, jobId: "x", state: "completed" };
    await store.lock(first.id, () => store.save(firstRun));
    coordinator.jobs.set("job-1", { ...coordinator.jobs.get("job-1")!, state: "completed", exitCode: 0 });

    const results = await reconcileRuns(store, { coordinator, cliPath: CLI, maxConcurrentWorkflowRuns: 1 });
    expect(results).toContainEqual({ runId: second.id, action: "admitted" });
    expect(coordinator.starts.map(request => request.requestId)).toEqual([`wf-run-${first.id}-1`, `wf-run-${second.id}-1`]);
  });

  it("uses a headless session that approves only the workflow-run launch actions", () => {
    expect(runnerLaunchSession().headlessApprovedActions).toEqual(["workflow-run", "start", "headless-start"]);
  });
});
