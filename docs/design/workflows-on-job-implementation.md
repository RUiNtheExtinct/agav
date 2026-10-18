# Workflows on `/job`: design and implementation plan

**Goal:** keep the workflow model from the author's PRs #411–#413 (definitions, DAG runtime, checkpoints, retries, approvals and scheduling) and replace their home-grown detached launcher with the `/job` background-jobs subsystem (PR #526 (merged now), `source/background-jobs/`). That launcher is `workflows/jobs.ts`, which copies the pattern of #409's `process` tool.

**Related docs:**
- `docs/job-vs-process-comparison.md`: why `/job` is the base.

**Source references:**
- Workflow PRs: branch `feat/workflow-scheduling-v2` in the fork `code-hack-batch/agav`.
- `/job`: the local `feat/background-processes` branch.
- Everything was established by reading code, not by running it.

---

## 1. Summary

1. **Keep the workflow engine, change what sits underneath it.** Keep these modules from #411/#412 mostly as they are:
   - `types`, `loader`, `validator`, `interpolate`, `condition`, `hash`, `store`, `retry`, `evals`, `metrics`
   - most of `runtime`

   Fix the bugs listed in §8 as they are ported.
2. **A whole workflow run is one `/job`.** Detached and scheduled runs are launched with `coordinator.start()` as a `direct` invocation of `agav workflows run <wf> --run-id <id>`. This replaces `workflows/jobs.ts`, its `WorkflowJobRecord`, the stop files and the `kill(pid,0)` liveness checks. `/job` then provides:
   - survival after the parent exits
   - process-group stop
   - liveness checks with PID-reuse protection
   - log capture
   - durable completion events
   - consent and capacity limits
3. **Steps that are long shell commands can optionally run as child `/job`s.** These are `tool: run_command` nodes and a new `job` node type. Each gets a deterministic `requestId` (`wf-<runId>-<nodeId>-<attempt>`), so resuming after a crash re-attaches to the existing job instead of starting it again. Agent, prompt, skill, approval and test nodes stay inside the runner process.
4. **Close the gaps in `/job` that workflows need**, in phases (§4):
   - headless approval
   - completion delivery through the mailbox
   - per-job timeout
   - metadata via a side table, not `JobRecord`
   - stale-lock recovery
   - retrying admission when the lock is held
   - stderr and tail access in `log`
   - a separate capacity pool for workflows
5. **Scheduling uses `/job`'s schedule engine**, not `config/scheduler.ts`. A workflow schedule is a `ScheduleRecord` whose launch template is the `agav workflows run` invocation. That gives timezones, one-time occurrence reservation across instances, and grant checks for free. #413's shared `tick()` idea becomes "one `evaluateOnce` driver used by the interactive ticker, a one-shot `agav job schedule tick`, and a daemon".

---

## 2. Mapping workflow concepts to `/job` primitives

| Workflow concept (#411–#413) | Current implementation | `/job` primitive | Notes |
|---|---|---|---|
| Detached workflow run | `startWorkflowJob` in `workflows/jobs.ts`: `spawn(detached, stdio:"ignore")` | `coordinator.start({ requestId: "wf-<runId>", invocation: {mode:"direct", executable: node, args:[cli, "workflows","run",…]} })` | Logs are now captured (previously `stdio:"ignore"`). |
| `WorkflowJobRecord` (`starting\|running\|finished`) | JSON in `workflow-jobs/` | `JobRecord` + `JobSummary` | Delete the workflow job record type. Keep the run→job link in `run.json` (§3.1). |
| Liveness check (`isWorkflowJobAlive`) and orphan sweep | `process.kill(pid,0)` | `coordinator.poll()` → `reconcileJob` (IPC nonce, then start-time check) | Uncertain jobs become `unknown` instead of being treated as dead. |
| Stop a detached run | `<runId>.stop` file polled every 500ms; marks the job `finished` immediately (bug) | `coordinator.stop()` → supervisor → SIGTERM to the process group, wait 5s, then SIGKILL | The runner traps SIGTERM through `RunController` and checkpoints the run as `cancelled` within the grace period. See §5.5 for Windows. |
| Overlap guard (`skipIfRunning`) | `isWorkflowTaskRunning` (pid check) | The schedule engine skips if the previous occurrence's job is not terminal | Already in `schedule/engine.ts`. |
| Scheduled task `kind:"workflow"` | `config/scheduler.ts` + `schedule-plan.ts` + `schedule-run.ts` | `ScheduleRecord` + `ScheduleOccurrenceRecord` + `evaluateOnce` | Gains timezones and deduplication across instances. Missed-run reporting needs a small extension (§4, G9). |
| Scheduler daemon (`scheduler-daemon.ts`) | Foreground loop; exits immediately (bug) | A daemon driver around `evaluateOnce`, with an exclusive lock via `withCoordinatorLock`-style O_EXCL | Rewrite (§6). |
| Completion notification (`notifications.ts`, `notifiedAt`) | Polls `run.json`; never wired into the app | `CompletionEventRecord` → `MailboxService` (claim + ack) → UI and agent subscriber | Deliver both run-level and step-level events. Desktop and bell sinks from #413 become mailbox subscribers. |
| `tool` / `test command` step | `toolRegistry.execute()` in-process, **no permission gate** | In-process through a gated executor, **or** a child `/job` for long commands | §5.2 |
| Step idempotency key | `ToolContext.idempotencyKey = <runId>:<nodeId>` | `requestId = wf-<runId>-<nodeId>-<attempt>` | Allowed characters `[A-Za-z0-9_-]`, so node ids must be sanitized (`#` in loop ids). |
| Step crash recovery (`retryRunningAfterCrash`, approval before retry) | Re-runs with approval unless `retrySafe` | Re-request with the same `requestId` returns the existing job; poll, then either `wait` or treat it as completed | Removes most of the need for approve-before-retry on job-backed steps. |
| Step timeout (`withNodeTimeout`) | `Promise.race`; the work keeps running (bug) | Per-job `timeoutMs` enforced by the supervisor (gap G3); in-process nodes get an `AbortController` | |
| Run deadline, token budget | In-process checks in `runtime.ts` | Unchanged; on expiry, also `stop()` every active child job | |
| Approval node | `deps.confirm` or `waiting_approval` | Unchanged (workflow level). Headless runs persist `waiting_approval` and post a mailbox event | |
| Consent for a run | Implicit when `scheduler add` is called; tool nodes are not gated | Grant action `workflow-run`, bound to the workflow definition hash and inputs (gap G1) | §5.6 |
| Environment filtering | `childEnv` regex | `buildMinimalEnvironment` + `envInherit` | The runner needs provider configuration (§7, Q3). |
| `AGAV_NODE`, `AGAV_WORKFLOW_JOB_DIR` | Environment variables | `packaging/locator.ts` (node / Bun binary); storage root | Drop `AGAV_WORKFLOW_JOB_DIR`. |

---

## 3. Data model

### 3.1 Workflow side (extend #411 types, no change to `/job` types)

```ts
// source/workflows/types.ts (additions)
export interface WorkflowRun {
  // ...existing #411 fields...
  /** Set when the run is hosted by a /job. */
  host?: {
    kind: "job";
    requestId: string;          // "wf-<runId>"
    jobId?: string;             // filled after admission
    scheduleId?: string;        // when started by a schedule
    occurrenceId?: string;
  };
}

export interface WorkflowNodeRun {
  // ...existing #411 fields...
  /** Set when the node executed as a child /job. */
  job?: {
    requestId: string;          // "wf-<runId>-<safeNodeId>-<attempt>"
    jobId?: string;
    state?: LifecycleState;     // last observed
    resultEventId?: string;
    exitCode?: number | null;
  };
}

/** New node type: an explicit long-running command executed as a /job. */
export interface WorkflowJobNode extends WorkflowNodeBase {
  type: "job";
  command: string;                       // interpolated; shell mode, default interpreter
  cwd?: string;
  envInherit?: string[];
  interpreter?: "posix-sh" | "bash" | "cmd" | "powershell";
  /** How output feeds downstream: "stdout" (default), "json" (parse stdout), "none". */
  output?: "stdout" | "json" | "none";
  maxOutputBytes?: number;               // default 64 KiB tail
}
```

`WorkflowNodeType` gains `"job"`. The validator requires `command`. In dry-run, `job` nodes are recorded as `skipped` (`dryRun: true`) unless mocked.

### 3.2 `/job` side: a metadata side table, not a `JobRecord` change

`types.ts` is owned by T01 and changes to it are gated, so job ownership is recorded in a new repository, following the pattern of schedule occurrences:

```ts
// source/background-jobs/storage/job-labels.ts   (new; T01 sign-off still needed for the Repositories interface)
export interface JobLabelRecord {
  requestId: RequestId;            // primary key (same id space as specs/)
  owner: "workflow" | "schedule" | "tool" | "user";
  workflowRunId?: string;
  workflowNodeId?: string;
  attempt?: number;
  displayName?: string;            // shown in /job list and JobsTUI
  createdAt: string;
}
// stored at <root>/labels/<requestId>.json, written with writeAtomic before coordinator.start()
```

`JobsTUI` and `/job list` join on `requestId`, the same way `loadJobOrigins` already joins schedule runs. This replaces "what started it" from `WorkflowJobRecord.target`.

### 3.3 Storage layout after the change

```
~/.agav/workflow-runs/<runId>/run.json, nodes/*.json, nodes/*.attempts/*, logs/*.log   # unchanged (#411 store)
~/.agav/background-jobs/specs|jobs|events|acks|labels|schedules|occurrences|grants/...  # /job
~/.agav/workflow-jobs/            # removed
~/.agav/scheduled-tasks.json      # workflow tasks migrated to /job schedules (§6, phase 4)
```

---

## 4. Gaps in `/job` that need extending

| ID | Gap | Why workflows need it | Proposed change | Where |
|---|---|---|---|---|
| G1 | Headless consent: `headlessApprovedActions` is always `[]` | Scheduled and detached runs have no terminal | New `GrantAction` `"workflow-run"`. A grant bound to `hash(definition, inputs, cwd)` is created interactively (`/workflows schedule …` or a first manual run with "allow in background"). The schedule engine and the runner pass `headlessApprovedActions: ["start"]` **only** for child specs whose launch is covered by a live `workflow-run` grant | `authorization/{service,policy}.ts`, `types.ts` (T01) |
| G2 | Completion delivery is not wired up | Run and step notifications; the LLM learns about results | Wire `MailboxService` into `use-agent.ts`: on an interval, `listPendingForPresentation` → `claimForPresentation(clientId)` → show the message **and** append a short system note to `ConversationState` → `acknowledge`. Add the bell and desktop sinks from #413 as subscribers | `hooks/use-agent.ts`, `background-jobs-integration.ts` |
| G3 | No per-job timeout | Node `timeoutSeconds`, run deadline | `LaunchSpec.limits.maxRuntimeMs?`. The supervisor arms a timer that calls `requestStop` with reason `timeout`. The completion outcome becomes `interrupted` with `uncertaintyReason: "timeout"` | `supervisor/lifecycle.ts`, `types.ts` (T01) |
| G4 | No way to find a job's owner | Show "workflow X / node Y" in `/job` and the TUI; clean up per run | `labels/` repository (§3.2) | `storage/` |
| G5 | Stale lock files block forever | A crashed runner must not stall the next scheduled run | Stale-lock recovery: if the lock file's `{pid, acquiredAt}` is dead (verified with the platform's start-time check) **and** older than N seconds, rename it to `quarantine/` and retry once. Log the recovery | `storage/single-writer-lock.ts` |
| G6 | Admission returns `lock-held` immediately | Parallel nodes and two sessions | Bounded retry with jitter in `coordinator.start` (e.g. 10 tries, 20–100 ms) | `coordinator/service.ts` |
| G7 | Capacity of 4 is shared | A runner job occupies 1 slot, and its 4 parallel child jobs then hit `capacity-exceeded`, so a workflow can starve itself | Runner jobs count against a separate `maxConcurrentWorkflowRuns` (default 2). Child jobs count against `maxConcurrentJobs`. When full, the runtime **queues** the node as `pending` and retries instead of failing | `coordinator/admission.ts`, runtime |
| G8 | `log` via the tool shows stdout only, from the start of the log | Step output for interpolation and debugging | Expose `stream` and `tail` (default tail) in `run_background_job`. The runtime calls `coordinator.log(id, {stream, maxBytes})` with `readTail` | `tools/background-job.ts`, `coordinator/service.ts` |
| G9 | Schedules don't report missed runs; failures are labelled `skipped-grant-invalid` | #413 records `missedRuns` and `lastSkipReason` | Add `ScheduleOccurrenceRecord.status: "missed"` for occurrences found in a look-back window (no replay, as in #413). Fix the skip reason labels | `schedule/engine.ts` |
| G10 | The scheduled launch drops `envInherit` and `limits` | The runner needs provider configuration and a timeout | Pass the template's `envInherit` and `limits` through to `start` | `schedule/engine.ts`, `StartJobRequest` (T01) |
| G11 | Retention is not enforced; `cleanup()` deletes nothing | Workflows create many child jobs | Enforce `completedLogRetentionDays` and the per-user log budget in a `pruneTerminalJobs()` that runs on ticker start. `cleanup()` removes logs and events for terminal jobs | `logging/`, `coordinator/service.ts` |
| G12 | No startup reconcile pass | `/workflows status` should not show `running` for a job that is gone | Reconcile non-terminal jobs once when the coordinator is first created, without blocking startup | `background-jobs-integration.ts` |

**Not gaps:** workflows don't need these.
- Agent/LLM job kinds: agent and prompt nodes stay in the runner process.
- Tags on `JobRecord`: the side table covers this.
- Sandboxing: an existing limitation, documented and unchanged.

---

## 5. How steps execute

### 5.1 Two execution hosts

```
            ┌──────────────── interactive session (agav TUI) ─────────────────┐
/workflows run X      →  in-process runtime (as #411), child steps may be /jobs
/workflows run X --detach  or schedule fires
                     →  coordinator.start(runner job: agav workflows run X --run-id R)
                          └─ supervisor ─ runner process ─ runtime
                                                         ├─ agent/prompt/skill/test/approval: in-process
                                                         └─ job / run_command nodes: coordinator.start(child)
```

The runtime code is the same in both. Only `WorkflowRuntimeDeps` differ: interactive runs have `confirm` and `confirmTool`; runner jobs get headless policies.

### 5.2 Node execution rules

| Node | Execution | Permission |
|---|---|---|
| `agent`, `skill` | In-process, as in #411 | Existing agent and skill paths |
| `prompt` / `reduce` | `runAgentLoop` with `allowedTools`, as in #411 | Agent loop gate (`confirmTool`, `permissionMode`) |
| `tool` | In-process, through a **new `gatedToolExecute(name, input, ctx)`** that applies the same checks as `agent/loop.ts`: `needsConfirm`, deny-writes, destructive command, `allowedTools`. Fixes the #411 permission bypass | `policies.permissionMode`. Headless: allowed only if the tool is read-only, or listed in `policies.allowedTools` covered by the `workflow-run` grant |
| `tool: run_command` with `background: true`, and the new `job` node | A child `/job` (§5.3) | `/job` authorization. Interactive: `confirmBackgroundAction`. Headless: the `workflow-run` grant (G1) |
| `test` `command` assertion | `gatedToolExecute("run_command")` **with the run signal** (fixes #411 bug 9) | As for `tool` |
| `approval` | As in #411. Headless: persist `waiting_approval` and post a mailbox event "Workflow X waiting for approval" | — |
| `parallel`, `loop` | As in #411. Child jobs inside a `parallel` node are subject to G7 queueing | — |

**Note:** `process` must not be usable as a workflow tool. Validation rejects `tool: process`, and `tool: run_background_job` points the user to the `job` node.

### 5.3 Running a child job

```ts
async function executeJobNode(run, node, attempt, deps, signal): Promise<WorkflowNodeRun> {
  const requestId = `wf-${run.id}-${safeId(node.id)}-${attempt}`;
  await deps.labels.put({ requestId, owner: "workflow", workflowRunId: run.id, workflowNodeId: node.id, attempt, displayName: `${run.workflowName}/${node.id}` });

  // Idempotent: on resume, the same requestId returns the existing job instead of launching again.
  let summary = await startWithQueue(deps.coordinator, {
    requestId,
    invocation: { mode: "shell", interpreter: node.interpreter ?? defaultInterpreter(), commandText: interpolate(node.command, ctx) },
    cwd: resolveCwd(node.cwd, run),
    envInherit: node.envInherit,
    isolation: { backend: "none", required: false },
    headless: deps.headless,
    // G3: limits.maxRuntimeMs = min(node timeout, remaining run deadline)
  }, deps.session, signal);                   // retries on capacity-exceeded/lock-held while signal not aborted (G6/G7)

  await saveNode({ status: "running", job: { requestId, jobId: summary.jobId, state: summary.state } });

  summary = await deps.coordinator.wait(summary.jobId, signal); // abort → returns current poll (job continues)
  if (signal.aborted) { await deps.coordinator.stop(summary.jobId, deps.session); summary = await deps.coordinator.wait(summary.jobId); }

  const out = node.output === "none" ? undefined
            : (await deps.coordinator.log(summary.jobId, { stream: "stdout", maxBytes: node.maxOutputBytes ?? 65536 })).text; // G8 tail
  return mapJobOutcome(summary, out, node);
}
```

**How job outcomes map to node status:**

| `/job` result | Node status |
|---|---|
| `completed` (exit 0) | `passed`. `output` is the stdout tail, or parsed JSON when `output: json`. Then `outputSchema` is checked with Ajv |
| `failed` | `failed`, with `error: "exit <code>"` and the stderr tail |
| `interrupted` because a stop was requested by the runtime | `cancelled` |
| `interrupted` because of a timeout (G3) | `timed_out` (`timedOutBy: "node"` or `"run"`) |
| `unknown` / `recovery-required` | `failed`, with `error: "uncertain: <reason>"`. **Never retried automatically**, because the side effect may already have happened. Requires `/workflows retry <run> <node>` |

### 5.4 Sequencing, dependencies and passing state

- **Scheduling is unchanged from #411:** a DAG, batches of ready nodes limited by `policies.maxConcurrency`, and `parallel` and `loop` as before.
- **Fix the readiness bug** (#411 bug 2): in `isReady`, the `pending` branch must fall through to the dependency check instead of returning `true` early. Retries and rewinds then run strictly in dependency order.
- **State passing is unchanged:** `${inputs.x}` and `${nodes.<id>.output…}` against the checkpoints. A job node's `output` is the stdout tail or parsed JSON. Its exit code, job id and result event id are available as `${nodes.<id>.job.exitCode}`, `…jobId` and `…resultEventId`.
- **Shell safety:** interpolating into a `job.command` uses a new `${shell:nodes.a.output}` form that shell-quotes for the selected interpreter. The plain form keeps the old behaviour but logs a validator warning when it is used inside `command`.

### 5.5 Failure, retry and cancellation

**Retry policy:** the `WorkflowRetryPolicy` from #412 applies. Each attempt gets a **new** `requestId` (`…-<attempt>`), so attempts are separate jobs with separate logs and grants are reused through the spec hash.

**Crash recovery:**
1. The runner job dies, or the host reboots.
2. On resume, a node checkpoint in `running` that has `job.requestId` set is handled with `coordinator.poll` by request id. This needs a small `findJobByRequestId` export.
3. Then:
   - Terminal state: map the outcome as in §5.3, with no re-run.
   - `running`: wait for it again.
   - `unknown`: mark the node failed as uncertain.
4. Only in-process `agent` and `tool` nodes still need #412's approval before retry.

**Node timeout:**
- Job nodes use the supervisor timer (G3).
- In-process nodes: `withNodeTimeout` gets its own `AbortController`, linked to the run signal, and aborts on timeout (fixes #411 bug 5). The work is tracked by `RunController` until it settles, and no retry starts until it has settled.

**Run cancellation:**
- **Interactive:** Ctrl+C or `/workflows cancel <run>` → `RunController.abort()` → in-process nodes are aborted and `coordinator.stop()` is called for each active child job → wait for the grace period → checkpoint.
- **Detached:** `/workflows cancel <run>` resolves `run.host.jobId` and calls `coordinator.stop(jobId)`.
  - The supervisor sends SIGTERM to the runner's process group, which also reaches child-job **supervisors**. Those are detached in their own groups, so the runner's SIGTERM handler explicitly stops its child jobs through the coordinator before it exits.
  - Escalation to SIGKILL after 5s: the runner's shutdown grace period (`shutdownGraceMs`, default 5000) must be **less than** the supervisor's stop grace period. Lower it to 4000.
  - `pause` works the same way but checkpoints as `paused`. The runner sees which via the `StopControlState` reason. The simplest approach is to write `run.requestedStop = "pause" | "cancel"` before calling `stop`, and the runner reads it in its handler.
  - **Windows:** a stop is a hard termination with no handler. The run is left `running`, and the next resume reconciles it: child jobs are polled, the run is marked `cancelled` because `run.requestedStop` is set. Document this.
- `pauseWorkflow` and `cancelWorkflow` must actually stop the host job, not only edit `run.json` (fixes #413 bug 10).

**Run-level failure policy:** unchanged (`stopOnFailure`). When the run fails, every child job still running is stopped.

### 5.6 Consent model, end to end

| Situation | What is asked | What is stored |
|---|---|---|
| Interactive `/workflows run X` | Normal per-node prompts (tool gate, `confirmBackgroundAction` per child job spec) | `/job` grants per spec hash, so the same command does not ask again |
| `/workflows run X --detach` or creating a schedule | **One** prompt: "Run workflow X (hash …) unattended, allowing: job commands [list], tools [list]". The list is derived statically from the definition: tool names, and job command templates **before** interpolation | A `workflow-run` grant on `hash(definition, inputs, cwd)` |
| Headless runner start | None. `revalidateBeforeDispatch` checks the `workflow-run` grant is still valid | — |
| Headless child job | None if the node's template is in the granted list. Otherwise the node fails with `authorization-denied` | — |
| Definition edited after it was granted | Hash mismatch, so the schedule dispatch is skipped with `grant-invalid` and posted to the mailbox | — |
| Deny-writes session connected | `/job` already skips dispatch and blocks start | — |

---

## 6. Commands and APIs

### 6.1 Slash commands and CLI (from #411/#413, with `/job` underneath)

```
/workflows list | runs | validate <wf> | status <run> | logs <run> [node] | checkpoints <run> | attempts <run> <node>
/workflows run <wf> [--input-json …] [--detach]        # --detach → runner /job
/workflows dry-run <wf> | test <wf> [--eval]
/workflows resume <run> [--approve-retry]
/workflows approve|deny <run> <node>
/workflows pause|cancel <run>                          # stops host job if detached
/workflows retry|rewind <run> <node>
/workflows schedule create "<cron>" <tz> <wf> [--input-json …]   # → /job ScheduleRecord + workflow-run grant
/workflows schedule list | pause <id> | resume <id> | revoke <id>
agav workflows …            # same, non-interactive (detach/schedule require an existing grant)
agav job schedule tick      # one-shot evaluateOnce for system cron (needs G1)
agav job schedule daemon start|stop|status
```

`/job list` and `JobsTUI` show workflow-owned jobs with their `displayName` (`<workflow>/<node>` or `<workflow> (run)`). Stopping a workflow job from the TUI calls `coordinator.stop`; the runtime observes it as a node or run cancellation.

### 6.2 LLM tool (optional, phase 5)

`run_workflow` with the actions `list`, `validate`, `run` (detached only, which needs a grant), `status`, `cancel`, `logs`. Run consent goes through the `workflow-run` grant prompt. This tool did not exist in #411–#413 and is optional.

### 6.3 Internal APIs

```ts
// source/workflows/job-host.ts (new; replaces workflows/jobs.ts)
startDetachedRun(def, inputs, opts): Promise<{ runId: string; jobId: string }>
stopRun(runId, mode: "pause" | "cancel"): Promise<void>
getRunHostState(runId): Promise<JobSummary | null>

// source/workflows/gated-tools.ts (new)
gatedToolExecute(registry, name, input, ctx: { permissionMode; confirmTool?; allowedTools?; signal; idempotencyKey }): Promise<ToolResult>

// source/background-jobs additions
coordinator.findByRequestId(requestId): Promise<JobSummary | null>
labels repository (G4); limits.maxRuntimeMs (G3); admission retry (G6); workflow pool (G7)
```

---

## 7. What to reuse and what to rewrite from PRs #409–#413

| Source | Verdict | Notes |
|---|---|---|
| **#409** `tools/process.ts`, `utils/tool-confirmation.ts`, `/schedule background`, `app.tsx` process dispatch | **Drop.** Superseded by `run_background_job` and `/job schedule` | Keep the warning text ("may outlive Agav…") in `/job`'s confirm prompt. Keep the stdout/stderr tail idea (G8) |
| **#411** `types.ts`, `loader.ts`, `validator.ts`, `interpolate.ts`, `hash.ts`, `store.ts`, `evals.ts`, `metrics.ts` | **Reuse** | Add the `job` node type, `host` / `job` fields and `${shell:…}`. The validator gets a real registry (fixes #413 bug 7) and rejects `tool: process`. Search paths should respect `getAgavDir()` |
| **#411** `runtime.ts` | **Reuse, with fixes** | `isReady` pending fall-through. `withNodeTimeout` abort. `executeToolNode` and test commands use `gatedToolExecute`. New `executeJobNode`. Child-job stop on shutdown |
| **#411** `control.ts` | **Partial rewrite** | `pause` and `cancel` call `stopRun`. `retry` clears `run.error` |
| **#411** `workflows-cli.ts`, `commands/workflows.ts` | **Reuse** | Add `--detach` and `schedule` subcommands. Remove `jobs` and `jobs-stop`, which move to `/job` |
| **#412** `condition.ts`, `retry.ts`, `RunController`, deadlines, token budget, `ToolContext.idempotencyKey` | **Reuse** | Retries on job nodes use per-attempt `requestId`s. Crash recovery for job nodes uses poll by request id instead of approval |
| **#413** `jobs.ts` | **Rewrite** as `job-host.ts` on top of the coordinator | Stop files, the pid liveness check and `WorkflowJobRecord` are removed |
| **#413** `schedule-plan.ts`, `schedule-run.ts`, `config/scheduler.ts` workflow kind | **Rewrite** onto `/job` `schedule/engine.ts` | Port the useful rules: catch-up window and missed-run accounting (G9); overlap guard (already present) |
| **#413** `scheduler-daemon.ts`, `cli/scheduler-cli.ts` | **Rewrite** | The daemon keeps a ref'd timer (fixes #413 bug 3), takes an exclusive O_EXCL daemon lock (bug 6), drives `evaluateOnce`, and exits cleanly on signal |
| **#413** `notifications.ts`, `utils/desktop-notify.ts` | **Reuse the sinks** | They become mailbox subscribers (G2). Drop `notifiedAt` polling of `run.json`; the runner posts a run-level completion event |
| **#413** `AGAV_CONFIG_DIR` | **Evaluate separately** | Unrelated to workflows; read once at import, which can surprise tests |
| Tests from #411/#412 (runtime, parallel, loop, retry, condition, …) | **Reuse** | They test the engine without the launcher |
| Tests from #413 (jobs, schedule-plan, daemon) | **Rewrite** against the coordinator and the schedule engine | |

---

## 8. Workflow PR bugs to fix while porting

Each of these was confirmed by reading the code.

| # | Bug | Fix in this design |
|---|---|---|
| 1 | `tool` nodes and `test` commands skip permission checks | `gatedToolExecute` (§5.2) |
| 2 | A retry lets downstream nodes run early (`isReady` returns early for `pending`) | Fall through to the dependency check |
| 3 | `scheduler daemon start` exits immediately (unref'd timer) | A new daemon with a ref'd timer |
| 4 | Completed runs are never announced in the app | Mailbox wiring (G2) |
| 5 | Timed-out work keeps running (`Promise.race`) | Abort controller per node; supervisor timeout for jobs (G3) |
| 6 | `scheduler-daemon.lock` is unused | Exclusive daemon lock |
| 7 | `scheduler add` validates against an empty `ToolRegistry` | Validate with `createToolRegistry()` |
| 8 | `stopWorkflowJob` marks the job finished before the child exits | `coordinator.stop` + `wait` |
| 9 | Test nodes don't receive the run signal | Pass `controller.signal` |
| 10 | `pause` and `cancel` don't stop a live run | `stopRun` |
| 11 | Windows PID check prevents the record from being closed | No self-closing record; the supervisor owns the outcome |

---

## 9. Phased implementation plan

Each phase can be merged on its own behind `backgroundJobsEnabled` plus a new `workflowsEnabled` flag.

**Phase 0: harden `/job` foundations**
- G5 stale-lock recovery, G6 admission retry, G12 startup reconcile, G8 stderr and tail in the tool.
- Fix the stale "no periodic timer yet" text.
- *Exit:* existing `/job` tests pass, plus new tests for lock recovery and the log stream.

**Phase 1: workflow engine port, in-process only**
- Bring over the #411/#412 modules listed as reuse in §7.
- Apply bug fixes 1, 2, 5, 7, 9 and 10 (the in-process parts), and add `gatedToolExecute`.
- `/workflows run`, `status`, `resume`, `approve` and the other in-process commands work. No detach and no schedule yet.
- *Exit:* the #411/#412 test suites pass, plus new tests for the permission gate and retry ordering.

**Phase 2: child job nodes**
- `job` node type, the `labels/` repository (G4), `executeJobNode`, `findByRequestId`.
- G3 per-job timeout, G7 workflow pool and queueing.
- Child-job stop on cancel or failure, and crash recovery by request id.
- *Exit:* integration tests with a real supervisor: sequential A→B with output passing, a parallel batch above capacity that queues, timeout gives `timed_out`, cancel stops the process group, kill the runner mid-node then resume re-attaches without running it again.

**Phase 3: detached runs and notifications**
- `job-host.ts` (`startDetachedRun`, `stopRun`), `--detach`.
- G1 `workflow-run` grant and headless approvals for child jobs covered by the grant.
- G2 mailbox wiring into `use-agent.ts` (UI and conversation) and the bell/desktop sinks.
- *Exit:* detached run survives exiting the TUI; completion is shown exactly once across two open sessions; cancel of a detached run checkpoints as `cancelled`; editing the definition invalidates the grant.

**Phase 4: scheduling**
- `/workflows schedule …` on top of the `/job` schedule engine.
- G9 missed-run records, G10 template pass-through, `agav job schedule tick` and a daemon with a lock.
- Migration: read `scheduled-tasks.json` entries with `kind: "workflow"` and offer to convert them. This needs an interactive grant, so it can't be silent.
- *Exit:* the same occurrence never fires twice across the TUI and the daemon; the overlap guard works; timezone/DST cases; the daemon stays alive and stops on SIGTERM.

**Phase 5: retention, UX and polish**
- G11 retention and `cleanup` deletion, workflow labels in `JobsTUI`, the optional `run_workflow` LLM tool, docs.
- Remove the `/process` code paths if #409 was merged in the meantime.

---

## 10. Testing strategy

**Unit tests**, run with vitest and following the existing `background-jobs/__tests__` layout:
- Runtime: readiness after a retry or rewind; that `pending` respects dependencies; that a timeout aborts the work and blocks a retry until the work settles; that `gatedToolExecute` respects `ask`, `deny-writes`, `auto-accept`, `allowedTools` and the destructive-command check; `${shell:…}` quoting for each interpreter.
- Mapping from job outcomes to node status, covering every lifecycle state (including `unknown` → failed, no retry).
- `requestId` construction: sanitization, uniqueness per attempt, staying within `/^[A-Za-z0-9_-]+$/`.
- Authorization: grant hashing for `workflow-run`; invalidation when the definition changes; that headless child specs are covered only by the grant.
- Admission: the workflow pool versus the job pool; queueing on `capacity-exceeded`; retry on `lock-held`.
- Lock recovery: a dead owner gets recovered, a live owner is never stolen.

**Integration tests** with a real supervisor process. Use a temporary `getAgavDir()` and tiny `node -e` workloads, as the existing `supervisor.lifecycle` tests do:
- A sequential DAG with stdout passed to the next node; a parallel batch with queueing; `outputSchema` failure.
- Cancellation: process-group stop of a child job that spawns a grandchild (assert the grandchild is gone, POSIX only).
- Crash recovery: SIGKILL the runner job mid-node, resume, and assert a single `CompletionEventRecord` for that node's `requestId` and no second launch.
- Timeout via G3.
- Mailbox: two clients, with exactly one presentation and an ack persisted.
- Schedule: `evaluateOnce` called concurrently from two coordinators produces exactly one occurrence and one runner job.
- Daemon: started as a real child process, assert it is still alive after 2 ticks, and that SIGTERM removes its record and lock.

**Platform tests:** reuse the adapter mocks for macOS and Windows. Add a Windows-only test that a stop leaves the run reconcilable as `cancelled` on resume.

**Regression tests:** keep the #411/#412 engine suites green throughout. Each bug in §8 gets a dedicated failing-first test.

**Manual checklist:** adapt `background-process-manual-test.md` from #409 to cover detached runs, closing the TUI mid-run, rebooting mid-run (expect `unknown`), and schedules with the TUI closed plus the daemon running.

---

## 11. Open questions

1. **Should runs be detached by default?** Interactive `/workflows run` could stay in-process, which allows approvals and is simpler, or always use a runner job, which survives a TUI crash. This design proposes in-process by default with `--detach` opt-in.
2. **How granular should the grant be?** One `workflow-run` grant per definition hash, or per node? Per definition is easier to use, but interpolated commands vary at runtime. Is "template before interpolation" an acceptable unit of consent?
3. **Provider credentials in the runner:** `/job` passes a minimal environment. The #413 child relied on `loadConfig()` decrypting stored credentials, which is fine, but providers configured *only* through environment variables (e.g. `ANTHROPIC_API_KEY`) would need `envInherit` names in the runner spec, and those become part of the consent hash. Should the user be asked, or should it be derived from the active provider?
4. **Changes to T01 `types.ts`:** G1, G3 and G10 touch shared types. Do they go through the T01 owner as one batch, or should workflows use extension types inside `workflows/`?
5. **Agent nodes as jobs?** Should long `agent` or `prompt` nodes get their own runner job, so they survive a runner crash? This design keeps them in-process; the crash-retry approval from #412 still covers them.
6. **Are capacity defaults right?** `maxConcurrentJobs=4` and `maxConcurrentWorkflowRuns=2`. Should they be configurable in `config.ts`?
7. **What happens to `/schedule` prompt tasks?** Keep the old `config/scheduler.ts` for LLM prompt schedules, or move them onto `/job` schedules as a later "prompt" runner job?
8. **Fate of #409:** if it merges first, do we add a migration shim (`process` → `run_background_job`) or a deprecation period?
9. **Retention of run state:** `workflow-runs/` grows without bound in #411 too. Should it share `completedLogRetentionDays`?
10. **Approval while headless:** a headless run that reaches an `approval` node waits for it. Should it time out (with a policy such as `approvalTimeoutSeconds`) and fail, or wait indefinitely?
