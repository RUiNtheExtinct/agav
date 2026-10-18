# Design: workflow dependency model inside `/job`

**Status:** draft design. Step 2 of the plan "fixes to `/job` to accommodate workflows".
**Scope:** how jobs (and workflow runs hosted as jobs) depend on other jobs; how that state is stored and resolved while the Agav TUI isn't running; how standalone jobs stay exactly as they are.
**Out of scope here:** approval modes, sandboxing and notifications (step 3), and the phased plan and upgrade guide (step 4).

**Terminology:**
- **TUI not running** means no interactive `agav` session is open. The Agav install still exists on disk.
- **Job** is a `/job` background job (`JobRecord` + `LaunchSpec`).
- **Workflow** is a definition from #411. **Run** is one execution of it.

---

## 1. Design goals and non-goals

**Goals**
1. **Chaining.** A job can start when one or more other jobs reach a terminal outcome. Each edge can fire on completion, on success, or on failure.
2. **Workflow runs depend on jobs too.** A workflow run's runner job can wait for upstream jobs, and a job can wait for a workflow run to finish.
3. **Works with the TUI closed.** Dependencies resolve even when no Agav session is open.
4. **At most once.** Each downstream launch happens at most once per upstream outcome, even with several Agav instances and ticker hosts running.
5. **Standalone jobs keep their semantics.** `/job`, `run_background_job` and schedules behave and are stored exactly as before.

**Non-goals**
- A general DAG engine inside `/job`. Node-level DAG, retries, loops, interpolation and approvals stay in the workflow runtime (#411/#412). `/job` only provides edges between jobs and a durable way to trigger them.
- Automatic retries or backfill. A missed or ambiguous trigger becomes `recovery-required`, following invariant 3 ("never assume death") and invariant 12 ("no backfill").
- Passing data between jobs. Downstream jobs get identifiers and the upstream outcome, not stdout piped in. Passing output is the workflow runtime's job.

---

## 2. Two layers: who orchestrates what

```
┌─────────────────────────── Workflow runtime (#411/#412, in a runner job) ───────────────────────────┐
│  node DAG · retries · when/conditions · interpolation · approvals · checkpoints (workflow-runs/)   │
│  long shell nodes → coordinator.start(child job, requestId = wf-<run>-<node>-<attempt>)            │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
                         ▲ is hosted by                       ▲ may be triggered by
┌──────────────────────────────────── /job (this design) ─────────────────────────────────────────────┐
│  Job ── edge(on: success|failure|completion) ──▶ Job        (Chain = named set of edges + specs)  │
│  Triggers resolved by the dependency evaluator, run by a ticker host (TUI, `agav job tick`, daemon) │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Rules for which layer orchestrates:**
- **Inside a workflow run:** node ordering belongs to the workflow runtime. Child jobs are started directly with `coordinator.start` and awaited with `coordinator.wait`. They don't use `/job` edges. The runtime already has the DAG, and doubling it would create two sources of truth.
- **Between top-level units:** "run workflow B after job A succeeds", "run cleanup job C if workflow run R fails", "after nightly build job, run tests job". This is what `/job` dependencies are for, and it's the only orchestration that has to work with no runtime process alive.

So a workflow run *is* a job (its runner job) for the purposes of dependencies. Nothing in `/job` needs to understand workflows. It sees an `InvocationSpec` of `agav workflows run …` and a terminal outcome.

---

## 3. Concepts

| Concept | Meaning |
|---|---|
| **Chain** | A user-approved, versioned set of **steps** (launch specs) and **edges** between them. A chain is to dependencies what `ScheduleRecord` is to recurrence: a consented template. It can be started manually, by a schedule, or by another chain's edge. |
| **Step** | A named launch-spec template inside a chain (`stepKey`, e.g. `build`, `test`, `deploy`, or `wf:nightly-triage`). |
| **Edge** | `from: stepKey → to: stepKey`, with a `condition` (§4). Multiple incoming edges use `join: "all" \| "any"`. |
| **Chain run** | One instantiation of a chain. Each step runs at most once per chain run. Identified by `chainRunId`. |
| **Trigger reservation** | An exclusively created record proving a given downstream step was dispatched for a given chain run. This is the at-most-once guarantee, using the same pattern as `ScheduleOccurrenceRecord`. |
| **External dependency** (optional, phase 2b) | An edge whose `from` is an existing job/request id outside the chain ("start this chain when job `ab12…` ends"). |

**Why not put `dependsOn` on `LaunchSpec` or `JobRecord`?**
- The `LaunchSpec` hash is what consent binds to. Adding upstream ids would make every chained job a different spec, so grants could never be reused.
- `JobRecord` has a single writer (the supervisor) under a per-job lock. Adding dependency state would bring a second writer.

A separate chain store keeps both of those unchanged (§7, backward compatibility).

---

## 4. Edge conditions: mapping job outcomes to triggers

The upstream job's state is read from `JobRecord.state` (authoritative). The `CompletionEventRecord` is used only for exit code and excerpt display, because some terminal paths write no event: spawn failure, and Windows `unknown`.

| Upstream state | `on: success` | `on: failure` | `on: completion` | Notes |
|---|---|---|---|---|
| `completed` (exit 0) | **fire** | skip | **fire** | |
| `failed` (non-zero exit, spawn failure, foreign signal) | skip | **fire** | **fire** | A spawn failure has no event; the edge still fires on `state` |
| `interrupted` (stop requested, or Agav's own signal) | skip | skip by default | **fire** | `interrupted` means the user or a workflow cancelled it. `onInterrupted: "as-failure"` lets an edge treat it as failure. A stop that races a normal exit is recorded as `completed`/`failed` by exit code (`supervisor/lifecycle.ts`, `handleChildExit`), so edges see the real result |
| `unknown` / `recovery-required` | **hold** | **hold** | **hold** | Never resolved automatically (invariant 3). The chain run becomes `blocked`, and the user resolves it (§6.4). On Windows, a stopped **shell** job always ends `unknown` with no completion event (`handleChildExit` and the stop path in `supervisor/lifecycle.ts`), so cancelling one step blocks its dependents there |
| `accepted` / `starting` / `running` | wait | wait | wait | |

**Condition names:** `"success" | "failure" | "completion"` plus the `onInterrupted` flag. There's no expression language, on purpose. Conditional logic that depends on output belongs in a workflow `when:`.

**Joins:**
- `join: "all"` (default): the downstream step fires when **every** incoming edge's condition is satisfied. If any incoming edge becomes *unsatisfiable* (e.g. a `success` edge whose upstream failed), the step is **skipped**, and that skip propagates downstream as "skipped". Skipped steps satisfy no condition except an `on: completion` edge that sets `skipCounts: true` (default false).
- `join: "any"`: fires on the first satisfied incoming edge. Later satisfactions are ignored, and the reservation (§5.3) guarantees this.

**Chain run outcome:**
- `succeeded`: every step that ran completed, and nothing is blocked.
- `failed`: at least one step failed. The run record also carries `failureHandled: boolean`, which is true when every failed step has an outgoing `on: failure` or `on: completion` edge whose downstream step was dispatched. The UI shows this as "failed (handled)". Edges that react to failure never change the outcome to `succeeded`, so a failure is always visible.
- `cancelled`: the user stopped the chain run.
- `blocked`: some upstream is `unknown` or `recovery-required`.

The chain-run outcome can itself be an upstream for an external dependency (phase 2b).

---

## 5. Data model

Everything new lives in a new module `source/background-jobs/chains/`. It follows the `authorization/grant-store.ts` pattern: a module-owned store with its own directory, outside `Repositories`, so `types.ts` (T01) changes stay minimal and additive.

### 5.1 Records

```ts
// source/background-jobs/chains/types.ts
export const CHAIN_SCHEMA_VERSION = 1;

export type EdgeCondition = "success" | "failure" | "completion";

export interface ChainStepTemplate {
  stepKey: string;                                   // /^[a-z0-9][a-z0-9_-]{0,47}$/
  launchSpecTemplate: Omit<LaunchSpec, "requestId" | "createdAt">;
  /** Optional display label, e.g. "workflow nightly-triage". */
  label?: string;
  join?: "all" | "any";                              // default "all"
}

export interface ChainEdge {
  from: string;                                      // stepKey
  to: string;                                        // stepKey
  on: EdgeCondition;
  onInterrupted?: "skip" | "as-failure";             // default "skip"
  /** For on:"completion" only — whether a skipped upstream satisfies this edge. Default false. */
  skipCounts?: boolean;
}

export interface ChainRecord {
  schemaVersion: number;                             // CHAIN_SCHEMA_VERSION
  chainId: string;                                   // uuid
  version: number;                                   // bumped on any edit; edits need re-consent
  name: string;
  steps: ChainStepTemplate[];
  edges: ChainEdge[];
  /** Roots = steps with no incoming edges; started when a chain run starts. */
  grantId: GrantId;                                  // "chain-create" grant over chainHash (§5.2)
  chainHash: string;
  enabled: boolean;
  pausedAt?: string;
  createdAt: string;
}

export type ChainRunStatus = "running" | "succeeded" | "failed" | "cancelled" | "blocked";
export type StepRunStatus =
  | "pending"          // waiting on upstreams
  | "dispatched"       // reservation created, coordinator.start returned a job
  | "skipped"          // an incoming edge became unsatisfiable (join=all) or never fired
  | "blocked"          // upstream unknown/recovery-required
  | "recovery-required"// dispatch itself was ambiguous (start threw after reservation)
  | "cancelled";

export interface ChainRunRecord {
  schemaVersion: number;
  chainRunId: string;                                // uuid
  chainId: string;
  chainVersion: number;
  /** What started it: manual, schedule occurrence, or an upstream chain/job. */
  origin: { kind: "manual" } | { kind: "schedule"; scheduleId: string; occurrenceId: string }
        | { kind: "external"; upstreamRequestId: string };
  status: ChainRunStatus;
  /** Only meaningful when status === "failed"; see §4. */
  failureHandled?: boolean;
  /** Cached view, derived; the reservation records (§5.3) are the source of truth for dispatch. */
  steps: Record<string, { status: StepRunStatus; requestId?: string; jobId?: string; reason?: string }>;
  cancelRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Exclusive-create proof that one step was dispatched for one chain run (at-most-once). */
export interface StepDispatchReservation {
  reservationId: string;                             // sha256(chainRunId | stepKey)
  chainRunId: string;
  stepKey: string;
  requestId: string;                                 // deterministic, see §5.4
  status: "reserved" | "dispatched" | "skipped" | "recovery-required";
  reason?: string;
  createdAt: string;
}
```

### 5.2 Consent binding

A chain is approved once, as a unit. The new `GrantAction` value is `"chain-create"`, an additive union member that needs T01 sign-off. The grant is bound to:

```
chainHash = sha256(canonicalJSON({
  name, version,
  steps: steps.map(s => ({ stepKey: s.stepKey, join: s.join ?? "all", specHash: hashLaunchSpecForConsent(s.launchSpecTemplate) })),
  edges: sorted(edges),
}))
```

- **Per-step `specHash` reuses the existing consent hash**, so a step's command, cwd, env, isolation and limits are all covered.
- **Editing anything** (a step spec, an edge, or the join type) changes `chainHash`. The old grant then fails `revalidateBeforeDispatch` and a new approval is required. This is invariant 2, extended to the graph.
- **Revalidation needs a chain-level check.** The existing `revalidateBeforeDispatch(grantId, spec)` (`authorization/service.ts:150`) hashes a single `ConsentRelevantSpec` with `hashLaunchSpecForConsent`, so it can't validate a graph hash. Add `revalidateChainBeforeDispatch(grantId, chain)` to the authorization service. It recomputes `chainHash` from the stored chain and compares it with `grant.specHash`, reusing the same `Grant` record shape: for `chain-create` grants, `specHash` holds the `chainHash`.
- **Dispatching a step** checks the chain grant, then calls `coordinator.start`. Today the schedule engine (`schedule/engine.ts`, in the dispatch `try`) passes a synthetic `{ permissionMode: "auto-accept", headlessApprovedActions: [] }` session and leaves `request.headless` unset. Authorization passes because auto-accept mints a `start` grant. The chain evaluator should **not** copy that blanket auto-accept: it passes the step's exact spec and a policy session derived from the chain's approval mode, defined in step 3. This design assumes only that the chain grant authorizes dispatching the chain's exact step specs.

### 5.3 Storage layout

```
~/.agav/background-jobs/
  chains/<chainId>.json                       # ChainRecord          (writer: chain service, under chain lock)
  chain-runs/<chainRunId>.json                # ChainRunRecord       (writer: dependency evaluator, under chain-run lock)
  chain-dispatch/<reservationId>.json         # StepDispatchReservation (exclusive create; then status updates under chain-run lock)
  locks/chain-<chainId>.lock, chain-run-<chainRunId>.lock
```

- **Writes:** use `writeAtomic` and `readJsonIfExists`, with quarantine. Reservations are claimed with `createExclusive`, exactly like occurrences.
- **Single writer:** a chain-run record is only written under `withChainRunLock`, using the same O_EXCL lock implementation plus the stale-lock recovery and bounded retry that step 4 adds to `/job` generally.
- **Scale:** each chain run is O(#steps) small files. Evaluator scans use `chain-runs/` filtered to `status ∈ {running, blocked}`. A small `chain-runs/active.idx` is optional later; at first, a list plus a filter is enough.

### 5.4 Deterministic request ids (link to `/job`)

```
requestId(step) = `ch-${chainRunId}-${stepKey}`        // [A-Za-z0-9_-] only — matches paths.ts ID rule
```

- **Recovering an interrupted dispatch:** re-dispatching after a crash calls `coordinator.start` with the same `requestId` and spec. The coordinator's existing idempotency returns the existing job and launches nothing. If the spec changed in the meantime, it raises `spec-changed`, and the step becomes `recovery-required`.
- **Finding a job's chain:** `/job list` and `JobsTUI` can find a job's chain run by its `ch-` prefix with no extra lookup. The labels side table from `workflows-on-job-implementation.md` §3.2 can add a display name.
- **Workflow runner jobs** that are chain steps use the same id. The workflow `runId` is derived as `wf-${chainRunId}-${stepKey}` and passed to `agav workflows run --run-id`, so resuming the workflow and re-dispatching the chain agree on a single id.

---

## 6. Resolution while the TUI isn't running

### 6.1 The dependency evaluator

The evaluator is a pure-ish function next to `evaluateOnce`, in `source/background-jobs/chains/evaluator.ts`:

```ts
export interface DependencyEvaluator {
  /** Advance every active chain run by at most one dispatch round. Idempotent; safe to call concurrently. */
  evaluateDependencies(args: {
    nowUtc: Date;
    connectedSessions: SessionPolicySnapshot[];     // deny-writes in any connected session blocks dispatch (as schedules)
    policy: HeadlessPolicy;                         // from step 3 (safe/auto); here: "dispatch allowed by chain grant"
  }): Promise<DependencyEvaluationResult[]>;
}
```

**Algorithm, per active chain run:**
1. Load the chain run and its chain at `chainVersion`. If the chain is disabled or revoked, no new dispatches happen; the run continues only for steps already running (invariant 10: revocation blocks future launches only).
2. If `cancelRequestedAt` is set, mark every pending step `cancelled`, call `coordinator.stop` for dispatched non-terminal jobs, and finish with status `cancelled`.
3. For each dispatched step, read `JobRecord` by `requestId` via the new `findByRequestId`. Map `state` to an outcome using the table in §4.
4. For each pending step, compute the join over its incoming edges:
   - Satisfied: go to step 5.
   - Unsatisfiable: mark it `skipped` and propagate.
   - Upstream `unknown` / `recovery-required`: mark it `blocked`.
   - Still waiting: leave it.
5. Dispatch. The whole step runs under `withChainRunLock(chainRunId)`, so only one host advances a given chain run at a time:
   - `revalidateChainBeforeDispatch(chain.grantId, chain)` (§5.2). If invalid, mark the step `recovery-required` with reason `grant-invalid`.
   - `reserveStepDispatch(sha256(chainRunId|stepKey))` with exclusive create. Then:
     - **Created:** this host owns the dispatch. Continue.
     - **Exists with status `reserved`:** an earlier attempt didn't finish dispatching, either because it was deferred for capacity or because the host crashed between reserve and start. Continue with the **same** deterministic `requestId`. This is safe because `coordinator.start` is idempotent on `requestId` plus spec hash: it returns the existing job if one was created, and raises `spec-changed` if the spec differs (`coordinator/service.ts`, "Idempotent retry handling").
     - **Exists with status `dispatched`, `skipped` or `recovery-required`:** already decided. Sync the cached step status and skip.
   - `coordinator.start({ requestId, …template }, chainSession)`:
     - On success: set the reservation to `dispatched`, and the step to `dispatched` with its `jobId`.
     - On `capacity-exceeded` or `lock-held`: **leave** the reservation at `reserved` and the step `pending`. The next tick re-enters through the "exists with status `reserved`" branch and retries with the same `requestId`. A reservation is never deleted or re-created. This differs from schedules, which mark the occurrence `recovery-required` and never retry (see §6.3).
     - On `spec-changed` or any other error: set the reservation and the step to `recovery-required`, with no retry.
6. Recompute `status` and save the chain run under its lock.

The evaluator never signals processes except through `coordinator.stop` when cancelling. It never launches anything except through `coordinator.start`. That keeps invariant 1, the single entry point.

### 6.2 Ticker hosts: who calls the evaluator

The evaluator, like `evaluateOnce`, must run somewhere. Three hosts share one driver function:

```ts
// source/background-jobs-integration.ts (extended)
export async function runBackgroundTick(getSessions: () => SessionPolicySnapshot[]): Promise<TickReport> {
  const engine = await getSharedScheduleEngine();
  const deps = await getSharedDependencyEvaluator();
  const now = new Date();
  const sched = await engine.evaluateOnce({ nowUtc: now, connectedSessions: getSessions() });
  const chains = await deps.evaluateDependencies({ nowUtc: now, connectedSessions: getSessions(), policy: … });
  return { sched, chains };
}
```

| Host | When it runs | Latency | Notes |
|---|---|---|---|
| **TUI ticker** (existing `startScheduleTicker`) | While a session is open | ≤ 30 s | Now calls `runBackgroundTick` |
| **`agav job tick`** (new CLI, one-shot) | Run by the OS scheduler every minute (cron, systemd timer, launchd `StartInterval`, Windows Task Scheduler) | ≤ 60 s | The reliable no-TUI path. Exits after one tick. `agav job tick --install` / `--uninstall` writes the OS entry (phase 2) |
| **`agav job daemon`** (new, optional) | Foreground or service, ref'd interval of 15 s, single-instance O_EXCL daemon lock | ≤ 15 s | For users who want lower latency. Must keep a ref'd timer, unlike #413's daemon |
| **Completion nudge** (optional optimization) | The supervisor, after its terminal update, spawns `agav --internal-background-jobs-tick` detached, best-effort | ~1 s | It *spawns* a host instead of importing the coordinator, so the layering rule is kept. Exactly-once comes from reservations, so an extra nudge is harmless |

**Running several hosts at once is safe.** Reservations are exclusive-create, chain-run writes are locked, and `coordinator.start` is idempotent on `requestId`.

**Connected sessions with no TUI:** with the TUI closed, `connectedSessions` is `[]`. Deny-writes therefore can't come from a session. It comes from the chain or workflow approval mode (step 3) and from a global kill switch in config, `backgroundAutomation: "on" | "paused"`, which `agav job pause-all` toggles.

### 6.3 Capacity and queueing

- Chain dispatches that hit `capacity-exceeded` stay `pending` and are retried every tick. They are not `recovery-required`, because the step never started, so retrying is unambiguous.
- **Fairness:** dispatch order is the oldest chain run first, then topological order inside it.
- **Workflow runner jobs** count against a separate pool, `maxConcurrentWorkflowRuns` (default 2), so a workflow's child jobs can't be starved by its own runner. Defined in `workflows-on-job-implementation.md` G7.
- **Schedules keep their current behaviour:** a scheduled trigger that hits capacity is skipped for that slot (invariant 12). Only chain edges queue. The difference is documented: an edge represents work already committed, a schedule slot does not.

### 6.4 Blocked and recovery-required steps

These are never auto-resolved. The user resolves them via `/job chain resolve <chainRunId> <stepKey> --as success|failure|skip`, or by retrying with `--retry`.

- `--as` records a manual outcome on the step, with an audit `reason` naming the user, time and choice. Downstream edges then evaluate against it. It needs an interactive session and is authorized like `start`, because it can unlock launches.
- `--retry` creates a **new chain-run attempt for that step only**: `requestId = ch-<run>-<step>-r<N>`, a new reservation, and the same spec, so it reuses the grant.
- Blocked runs emit a mailbox event, "Chain X blocked at step Y", so the user sees it on their next session. The sound notification for this is defined in step 3.

---

## 7. Standalone jobs keep working unchanged (backward compatibility rules)

| # | Rule |
|---|---|
| B1 | **No change to existing records.** `LaunchSpec`, `JobRecord`, `CompletionEventRecord`, `ScheduleRecord` and `ScheduleOccurrenceRecord` don't change shape. Chains reference jobs by `requestId`; jobs never reference chains. |
| B2 | **No change to existing behaviour of `CoordinatorClient` methods.** `start/list/poll/log/wait/stop/cleanup/capabilities` behave identically for jobs with no chain. The only addition is `findByRequestId(requestId)`, a read-only method and an additive interface change. |
| B3 | **Consent hashes are unchanged.** `hashLaunchSpecForConsent` is untouched, so existing grants stay valid and a step spec identical to a standalone job reuses its `start` grant. |
| B4 | **Schedules keep their semantics.** No backfill, skip on overlap, skip on capacity. A schedule can target a chain (start a chain run per occurrence) through a new optional `ScheduleRecord.target?: { kind: "chain"; chainId }`. If it's absent, the existing single-spec behaviour applies. |
| B5 | **Off by default.** Chains are gated by `backgroundJobsEnabled` **and** a new `jobChainsEnabled` flag. With the flag off, the evaluator is never constructed, `chains/` is never created, and `/job chain …` prints how to enable it. |
| B6 | **The `/job` UI keeps its meaning.** `/job list`, `JobsTUI` and `run_background_job` still list every job. Chain-launched jobs show an origin label (`chain <name>/<step>`), using the `loadJobOrigins` join extended with the `ch-` prefix. Stopping such a job from `/job stop` works as before; the chain sees `interrupted` and applies the edge rules. |
| B7 | **Tools are separate.** `run_background_job` gets no chain actions in phase 1. The LLM manages chains only through a separate, later `job_chain` tool, so the existing tool schema and its consent prompts don't change. |
| B8 | **Unknown files are ignored by older builds.** Older Agav builds don't read `chains/`, `chain-runs/` or `chain-dispatch/`. A downgrade leaves chain state dormant, not corrupted. Chain records carry `schemaVersion`, and newer builds refuse (quarantine plus a message) records with a higher `schemaVersion` than they understand. |
| B9 | **Layering stays intact.** `chains/` may import `coordinator` (client interface), `authorization`, `storage` and `types`. `supervisor`, `mailbox`, `recovery` and `platform` must not import `chains/`. |

---

## 8. Scheduler and runner changes (summary)

| Component | Change |
|---|---|
| `authorization/service.ts` | `revalidateChainBeforeDispatch(grantId, chain)` (§5.2); `authorize("chain-create", …)` that prompts with a chain summary instead of a single spec |
| `types.ts` (T01, additive) | `GrantAction` adds `"chain-create" \| "chain-resolve"`. `CoordinatorClient.findByRequestId`. `ScheduleRecord.target?`. `ResourceLimits.maxConcurrentWorkflowRuns?` (optional; default applied in normalize) |
| `chains/` (new) | `types.ts`, `store.ts` (chains, chain-runs, chain-dispatch), `hash.ts` (`chainHash`), `service.ts` (create/edit/enable/pause/revoke, `startChainRun`, `cancelChainRun`, `resolveStep`), `evaluator.ts` |
| `schedule/engine.ts` | If `schedule.target?.kind === "chain"`, the occurrence starts a chain run (`origin: schedule`) instead of a single job. The overlap check means "the previous occurrence's chain run is not terminal" |
| `coordinator/service.ts` | `findByRequestId`. Bounded retry on `lock-held` during admission. Separate pool counting for workflow runner jobs |
| `background-jobs-integration.ts` | `runBackgroundTick` shared by all hosts. `getSharedDependencyEvaluator` |
| `cli.tsx` / `main.tsx` | `agav job tick [--install\|--uninstall]`, `agav job daemon start\|stop\|status`, internal `--internal-background-jobs-tick` |
| `supervisor/lifecycle.ts` | Optional completion nudge: best-effort, detached spawn of the internal tick after the terminal update, behind a config flag. No import of the coordinator |
| `commands/job.ts`, `jobs-tui.tsx`, `resources/job-adapters.ts` | `/job chain list\|show\|create\|run\|cancel\|pause\|resume\|revoke\|resolve`, a Chains tab, origin labels |
| Workflow runtime | `agav workflows run --run-id` accepts the chain-derived id. A workflow can be a chain step (`launchSpecTemplate.invocation = direct agav workflows run <wf> …`). A workflow's own nodes still don't use chains (§2) |

---

## 9. Worked examples

**A. Build, then test, with cleanup on failure**

```yaml
# agav job chain create -f nightly.yaml   (one approval for the whole chain)
name: nightly
steps:
  - { stepKey: build,   command: "pnpm build" }
  - { stepKey: test,    command: "pnpm test" }
  - { stepKey: notify,  command: "./scripts/post-status.sh" }
  - { stepKey: cleanup, command: "rm -rf ./tmp-artifacts", join: any }
edges:
  - { from: build, to: test,    on: success }
  - { from: test,  to: notify,  on: completion }
  - { from: build, to: cleanup, on: failure }
  - { from: test,  to: cleanup, on: failure }
```

The chain is scheduled with `/job schedule create "0 2 * * *" Asia/Kolkata --chain nightly`.

**What happens with the TUI closed:**
1. The OS runs `agav job tick` at 02:00. The schedule occurrence starts a chain run, and `build` is dispatched.
2. `build` finishes at 02:07. The completion nudge, or the next tick at 02:08, dispatches `test`.
3. `test` fails, so `notify` (on completion) and `cleanup` (join any) are both dispatched.
4. The chain run's status is `failed`, because `test` failed, with `failureHandled: true` because `cleanup` was dispatched from `test`'s failure edge. The display shows "failed (handled)".

**B. A workflow run as a step:**

```yaml
name: data-triage
steps:
  - { stepKey: fetch, command: "./scripts/pull-data.sh" }
  - { stepKey: triage, workflow: "nightly-triage", inputs: { days: 3 } }  # sugar → direct agav workflows run …
edges:
  - { from: fetch, to: triage, on: success }
```

The `triage` runner job uses `requestId = ch-<run>-triage` and `--run-id wf-<run>-triage`. If the runner job is killed by a reboot, its state becomes `unknown` after reconcile. The chain run becomes `blocked`, and the user later runs `/workflows resume wf-<run>-triage`, then `/job chain resolve … triage --as success`. Resolving automatically via the workflow's own `run.json` is a later enhancement, listed in §10.

---

## 10. Open points for step 3 and step 4

1. The **headless policy** passed to the evaluator (`policy: HeadlessPolicy`) is defined by the safe and auto approval modes in step 3. This design assumes "the chain grant authorizes dispatch of its exact step specs".
2. Whether a chain step that is a workflow can **report its outcome from `run.json`** instead of the runner process exit code. Proposal: the runner exits 0 only when the run `passed`, 3 for `waiting_approval`, and 1 otherwise. An exit code 3 maps to a new chain step status, `waiting-approval`, which doesn't fire edges. This keeps `/job` unaware of workflows.
3. **Retention** for `chain-runs/` and `chain-dispatch/` follows the `/job` retention work (G11) in step 4.
4. **The OS scheduler integration for `agav job tick --install`** is per platform: systemd user timer, launchd agent, Task Scheduler XML, crontab fallback. The details and upgrade notes go in step 4.
