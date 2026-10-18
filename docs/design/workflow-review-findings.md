# Step 4 — independent workflow code review

## Scope and verification

Reviewed the **main working directory `/home/pranav/cli/agav`**, not an isolated worktree, at HEAD `cb427e90` plus its existing dirty/untracked changes. Started with `overview`, inventoried directories/configuration and relevant test locations, and read all `source/workflows/*.ts`, workflow CLI/slash/consent code, integration changes in App/main/config/commands, and supporting permission, registry, lock, atomic-write and shell paths. Compared `docs/workflows-on-job-implementation.md` with the actual `docs/docs/reference/workflows.md`.

This is a **non-test verification** review: no tests were written, edited or executed. Existing assertions were read, including request-queue handoff, command mid-turn safety, config, and sandbox/startup tests. No workflow-specific test files were present in the main tree. `pnpm exec tsc --noEmit` completed successfully with no output. Reproduction procedures below are source-traced scenarios, **not claims of executed runtime reproductions**. No production files, generated outputs or pre-existing dirty files were changed by this review.

## Findings

### WF-R1 — High: retry shortcut bypasses foreground workflow ownership

**Location:** `source/app.tsx:722–725` (missing ownership guard); `source/app.tsx:829–845` (normal serialization that is bypassed).

**Evidence:** Normal submitted prompts defer while `requestPendingRef.current` is true. A workflow holds that ref throughout its slash handler, but does not set the agent's `isLoading`. The Ctrl+R global shortcut checks only `!isLoading`, `!pendingConfirmation`, and an empty composer, then invokes `submit(lastPrompt)` directly. It checks neither `workflowAbortRef` nor `requestPendingRef`, and does not go through `handleSubmit`. `workflowConfirmation` prevents this only while the workflow's tool-consent overlay is actually displayed, not during tool execution.

**Reproduction:** Have a completed user/agent exchange in the transcript. Start an auto-accepted workflow containing a long literal `run_command` (for example `sleep 20`). With the composer empty, press Ctrl+R. The previous agent prompt is submitted immediately while the workflow still owns the foreground. The agent can start its own tools/confirmations and mutate the same files concurrently. This contradicts the reference's foreground serialization guarantee.

**Minimal fix direction:** Route retries through the owned request path, or explicitly defer/refuse them while foreground work owns submission. This is a host integration bug, not a request for workflow concurrency support.

### WF-R2 — Medium: active-workflow cancel shortcut never finalizes an inactive target

**Location:** `source/app.tsx:812–825`; compare `source/workflows/control.ts:22–34` and `source/commands/workflows.ts:43–44`.

**Evidence:** Whenever *any* foreground workflow is active, App intercepts `/workflows cancel <id>`, reads that checkpoint, writes a `.cancel` marker and reports “awaiting settlement.” It does not verify that the ID identifies the active workflow, and does not invoke `cancelRun`. The runtime polls markers only for its own executing ID. Therefore a different, inactive waiting-approval/pending run has no process to observe the marker or acquire its lock and publish cancellation.

**Reproduction:** Leave run B at `waiting_approval`. Start long-running run A in the TUI. Submit `/workflows cancel <B-id>`, then `/workflows status <B-id>`. B remains `waiting_approval`, even after A settles; there is no queued cancellation task for B. Cancelling B again once idle uses `cancelRun` and finally records `cancelled`.

**Impact:** The command reports that it is awaiting settlement although no settlement is underway, and durable status remains nonterminal indefinitely. The reference does not restrict cancellation to the currently executing run.

**Minimal fix direction:** Track the active run identity, or use the shared cancellation control asynchronously for other targets without occupying/replacing the current workflow host.

### WF-R3 — Medium: disabling Ink Ctrl+C exit regresses idle Ctrl+C for every session

**Location:** `source/main.tsx:1093–1095`; `source/app.tsx:629–635,667–676,743–745`; defaults in `source/config/keybindings.ts:87,99`.

**Evidence:** Main now unconditionally supplies `exitOnCtrlC: false`, including when both workflow feature flags are off. App handles Ctrl+C for active workflows and busy agent/request work, but has no idle interrupt-to-exit case. The default `interrupt` action is Ctrl+C; the default `exit` action is Ctrl+Q. The App exit branch therefore does not replace Ink's former idle Ctrl+C exit behavior. Raw terminal Ctrl+C is an input event, not a process SIGINT, so the new process signal handler does not cover it.

**Reproduction:** Start a normal interactive session with `workflowsEnabled` unset/false, leave it idle with an empty composer, and press Ctrl+C. Previously Ink exited; now the event falls through and the session remains open. `/exit` and Ctrl+Q still work.

**Impact:** A global default keyboard behavior changes despite workflows being opt-in. Workflow settlement requires intercepting active cancellation, not dropping the idle behavior.

**Minimal fix direction:** Explicitly preserve idle interrupt exit behavior in App while retaining abort-and-settle behavior for active foreground work.

### WF-R4 — Medium: checkpoint validation accepts impossible approval/dependency states

**Location:** `source/workflows/store.ts:32–35`; consumers `source/workflows/runtime.ts:36–44,61–64` and `source/workflows/control.ts:8–16`.

**Evidence:** Read validation checks individual status membership, IDs/order/count, definition hash, and output type, but not node-type/dependency invariants. The definition hash does not cover node checkpoints. An approval checkpoint in `pending` with an upstream checkpoint in `waiting_approval`, or a tool checkpoint in `waiting_approval`, is accepted as structurally valid. A `passed` checkpoint whose dependencies are not passed is also accepted. Runtime's readiness trusts dependency checkpoints without validating their transitive consistency.

**Reproduction (trusted local-state corruption, not a remote exploit):** Start a valid A → approval P → B workflow and stop it at P. Change only P's checkpoint status from `waiting_approval` to `pending`, and A's from `passed` to `waiting_approval`, leaving the definition/hash unchanged. `status` accepts the checkpoint and `resume` settles back to `waiting_approval`. `approve A` fails because A is a tool, while `approve P` fails because P is not waiting/ready. The corrupted state is not rejected and has no valid approval transition. Alternatively mark P `passed` while A is still pending: B may become ready based solely on P, violating transitive dependency order when listed before A.

**Impact:** This contradicts “corrupt checkpoints fail closed” and dependency-order guarantees. It does **not** establish a hostile filesystem security boundary: the reference explicitly trusts local storage. It is a consistency/recovery failure under damaged or externally modified state.

**Minimal fix direction:** Validate supported node-state/dependency invariants when reading checkpoints, accounting for the legitimate crash window where a node decision is durable before the run-level status update. Do not reject those valid transitional snapshots.

## Checked boundaries and expected subset gaps (not findings)

- The implementation is intentionally much smaller than plan phase 1: only foreground JSON tool/approval nodes, sequential DAG execution, scalar interpolation and basic checkpoints. Missing YAML/discovery, agents/skills/tests, conditions, policies, retries/rewinds, concurrency, schemas/evals/metrics/history, detached execution, child jobs, unattended grants, scheduling, notifications and retention are **explicit reference-document exclusions**, not regressions disguised as bugs. This is not completion of the original full engine-port plan.
- UUID-v4 run IDs are validated at every checkpoint/marker/lock path construction. Node IDs are bounded and path-free. Absolute paths in ordinary read/write tools remain deliberately allowed; no workspace-confinement claim is made. Storage symlink attacks are outside the stated trusted-local-state boundary.
- Runtime readiness checks dependencies for every pending node; completed nodes do not automatically replay. A leftover `running` checkpoint is refused as uncertain. Failure checkpoints are reconciled before new dispatch after a crash. Snapshot writes use the existing fsynced temporary-file/rename helper and run saves additionally attempt directory fsync.
- Foreground cancellation/timeout aborts the node signal and awaits the executor promise rather than racing it. Non-cooperative tools and shell descendants that escape ordinary process ownership remain documented limitations, not proof that all OS effects have stopped. No child-job wait is being confused with authorized stop because child-job dispatch is absent.
- Workflow approval decisions do not alter permission mode or tool grants. Tool gating rejects unsupported tools, validates resolved input, denies destructive commands, respects deny-writes and explicit mutating allowlists, and fails closed without a headless confirmation handler. App's workflow consent is separate from the agent's reusable “always” queue. Built-in-only registries exclude extensions and background dispatch.
- Literal shell-only input is an intentional restriction: interpolation anywhere in `run_command` input is rejected. Shell `timeout_ms` and per-node `timeoutSeconds` are separate controls.
- Both entry surfaces require the two feature flags; project config cannot set `workflowsEnabled`. CLI global options must precede `workflows`, as documented. Workflow run/resume applies sandbox-required startup policy; interactive App relies on main's startup policy.
- Existing project config may add `allowedTools` grants (`source/config/config.ts:449–454`). Workflows inherit this existing project-trust policy rather than introducing a new global-only grant model. Do not describe workflow allowlists as trusted-global-only consent without changing that policy separately.

## Disposition

The initial review above made no production changes. A subsequent Step 4 repair pass fixed all four findings directly in the main tree, preserving its pre-existing dirty changes. None was dismissed as incorrect.

| Finding | Disposition and exact repair | Non-test evidence |
| --- | --- | --- |
| WF-R1 | **Fixed** in `source/app.tsx`: retry requires no pending foreground owner, shell owner or queued requests, as well as the existing idle/consent checks. The shortcut is refused rather than introducing concurrent or detached execution. | Mounted the actual emitted App through Ink with a previous user message, started a real sandboxed literal shell workflow, sent Ctrl+R during execution, and observed no attempted agent submission (the deliberately unconfigured provider would expose an escaped submission). |
| WF-R2 | **Fixed** in `source/app.tsx`: the active-workflow cancel interception awaits shared `cancelRun` and displays the settled checkpoint, without replacing the current foreground host. An inactive target therefore acquires its own lock and publishes cancellation, while an executing target still waits for its executor. | While workflow A's real shell was running, sent `/workflows cancel <B-id>` through actual App input; B's durable status became `cancelled` while A was still active. |
| WF-R3 | **Fixed** in `source/app.tsx`: idle raw Ctrl+C explicitly invokes the existing clean exit path. Busy workflow/agent/request and shell cancellation keep their earlier precedence; Ink still delegates cancellation to App. | Actual Ink App instances exited on idle Ctrl+C with both feature flags disabled and with both enabled. An active workflow instead aborted its real sandbox shell and published `cancelled` before a later idle exit. |
| WF-R4 | **Fixed** in `source/workflows/store.ts`: tool nodes cannot wait for approval; approval nodes cannot be running/cancelled/timed-out; every non-pending node must have passed dependencies. Also reject multiple running nodes, non-pending nodes in a pending run, and incomplete passed runs. | Manual persisted-checkpoint mutations rejected tool-as-approval, passed approval with pending ancestor, running/timed-out approval and incomplete passed run. Approved-node/run-still-waiting and failed-node/run-still-running crash snapshots remained readable and reconciled successfully. |

Verification used `tsc --noEmit`, temporary emission, and a disposable ESM filesystem/Ink harness, **not tests**. Compiler diagnostics and harness stderr were empty; the harness printed `ALL REPAIR MANUAL CHECKS COMPLETE`. Its real shell cwd was a disposable directory beneath the repository, avoiding the known `/tmp` workspace mount incompatibility without changing or weakening the sandbox. See the repair addendum in `docs/workflow-verification-report.md` for limits and exact changed files. Independent final verification is now complete (see below).

## Final independent disposition

A separate worker reread the repaired **main-checkout** App/store paths and their runtime/control/CLI/consent/sandbox call chain, then ran `./node_modules/.bin/tsc --noEmit`, temporary TypeScript emission and a standalone manual ESM smoke harness. Both compiler invocations passed with no diagnostics. No tests were written, edited or executed; no production changes were needed in this final pass. Main-checkout unrelated dirty files were preserved.

All four findings remain **verified fixed**, not deferred:

- **WF-R1:** actual mounted App refused raw Ctrl+R during a real sandbox shell while retaining foreground ownership. Retry now checks pending ownership, shell ownership and queue emptiness. No missing-provider submission diagnostic appeared in the deliberately unconfigured-provider harness.
- **WF-R2:** actual App cancelled a separate inactive waiting-approval checkpoint while the current shell workflow remained running; B became durably cancelled without replacing A's host.
- **WF-R3:** actual Apps exited on idle raw Ctrl+C with both feature flags disabled and enabled. Active Ctrl+C instead settled the real shell workflow to cancelled before subsequent idle exit.
- **WF-R4:** persisted corruption variants rejected unsupported tool/approval states, dependency violations and impossible pending/passed run states. Crucially, unchanged paused snapshots, approved-node/run-still-waiting snapshots, actual denied approval snapshots and failed-approval/run-still-running crash snapshots stayed readable and resumed/reconciled correctly.

Additional independent checks closed the original headless signal gap: **complete spawned emitted CLI → main → workflow CLI** processes received real OS SIGINT and SIGTERM after their production sandbox shell wrote a start marker. Each exited normally with code 1, printed/persisted cancelled status, left dependent work pending and created no late/dependent effect. A real shell node timeout similarly persisted timed_out. Delayed non-cooperative hosts proved cancel/timeout awaited late effects and prevented dependent dispatch. Actual App pending-consent Ctrl+C, external unmount and awaited shutdown all resolved false, settled cancelled and performed no write.

No new blocker was found. The existing bubblewrap `/tmp` cwd mount-order compatibility bug remains **unresolved**, not concealed by a bypass: the successful independent checks used a disposable repository-bound workspace with isolated HOME/config and unmodified sandboxing. Full interactive-main OS-signal/PTY coverage, escaped descendants, exhaustive race/stale-lock/power-loss recovery and the broader planned workflow `/job` increment remain explicit verification/scope limits, not claims of completion. Exact commands, observations and next job-integration requirements are recorded in the final independent addendum of `docs/workflow-verification-report.md`.

## Open items for job nodes

Foreground `job` nodes (slice A+B) were added after WF-R1–WF-R4 were reviewed against a tool/approval-only tree, so the statement above that child jobs are "absent" is stale. WF-R1–WF-R4 are not reopened.

The job slice has since had an **independent review, done by reading code only: the reviewers executed nothing.** Findings were then fixed by separate workers. Each fix was verified afterwards by the fixing worker with a fake-coordinator harness (not the real supervisor), `tsc` clean, and the existing tests passing (193–209 across the app/commands/background-jobs sets). Nothing below was exercised against a real supervisor. The letters are the reviewers' labels, not WF numbers.

### Fixed

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| A | low | An unrecognised coordinator lifecycle state persisted into `node.job` made the run unreadable. | **Fixed:** such a state is omitted at persist time (`isPersistableJobState` in `store.ts`). |
| B | medium | Any unexpected throw after admission (save failure, `getCoordinator` throwing) marked the node/run failed while the job could be live. | **Fixed:** in `runJobCheckpoint` (`runtime.ts`) the node stays `running` with its job linkage and the error is rethrown; the run stays non-terminal and resumable. |
| D | low | `cancelRun` could never finish for a `running` job node whose job was never launched. | **Fixed:** new *never-started* result when lookup succeeds, finds nothing and no `jobId` is stored. Lookup errors, unsupported lookup, or a stored `jobId` are still cancellation incomplete. |
| S2 | low | `JobNodeDeps.headless` was optional and failed open. | **Fixed:** now a required boolean; the start request sends `headless` unless it is explicitly `false`; the headless-stop gate is inside the `try`. |
| B2 | medium-low | Unbounded awaits in the stop/observe paths. | **Fixed:** per-call deadline (`callDeadlineMs`, default 30 s) with late results ignored; observer polls race the abort. **Limitation:** a deadline stops *waiting*; it cannot cancel the underlying call. |
| — | — | Start prompt not withdrawn when a store-level cancel aborted only the executor's inner signal; stop prompt stale after `stopDeadlineMs`. | **Fixed:** `confirmBackgroundAction` gained an optional 4th signal argument (types in `background-jobs/types.ts` and `commands/types.ts`); `authorization/service.ts` passes `session.signal` when present and `app.tsx` relays it. Stop prompts remain deliberately unlinked from the outer run signal. |
| B5 | — | Active-run `/workflows cancel` interception parsed the id differently from the command (quoted ids); shutdown could cut off an in-flight stop. | **Fixed:** shared `parseWorkflowsArgs` (`commands/workflows.ts`); pending cancels are awaited by `settleWorkflow`. |
| — | — | Stale user-facing strings (tool/approval-only wording). | **Updated** in `workflows-cli.ts`, `commands/workflows.ts`, the `main.tsx` help and the `config.ts` template text. |

### Open (not fixed)

| ID | Severity | Item | Why open |
| --- | --- | --- | --- |
| B3 | low-medium, unverified at runtime | One Esc may be delivered both to the App global handler (`denyJobConsents`) and to `ToolConfirm`, denying an unrelated queued confirmation. | **Fixed:** `ConfirmationQueue.resolve(choice, expected)` ignores the answer unless `expected` is still the displayed item; `ToolConfirm` answers the prompt that was displayed when the key event began. |
| B4 | low | Esc/Ctrl+C used to decline another run's stop prompt also aborts the active workflow A; only `n` declines safely. | **Fixed:** while a `/workflows cancel <other run>` stop prompt is displayed, Esc/Ctrl+C only declines that prompt and does not abort A (a further press aborts A as before). |
| C | medium (reviewer's rating); documented design | `unknown`/`recovery-required`, or three poll failures, turn the node (and run) `failed`/terminal while a job may still be live, so resume/cancel become no-ops for that run. | Inconsistent with the "incomplete" treatment used for cancellation. Consider keeping such nodes `running`/resumable. |
| — | accepted | Reattach and stop intentionally skip the `sandboxRequired` check (they act on an existing job). | By design. |
| — | accepted | Interactive `--auto-accept` mints start and stop grants without prompts, same as `/job`; job nodes are unsandboxed, unrestricted shell commands (`allowedTools` does not apply). | By design; unchanged from `/job`. |
| — | latent | `createWorkflowJobDeps` captures `permissionMode`/`sandboxRequired` once per run. | Nothing mutates them today. |
| — | low | A double prompt is possible when cancelling the active run's own id; `ConfirmationQueue.clear()` on an agent-turn cancel also denies workflow job prompts. | Not fixed. |

### Not verified at all

- Any real-supervisor run: real process stop, reattach after a real kill, absence of double launch against the real coordinator.
- A queued stop prompt behind another confirmation in the real UI.
- `getSharedCoordinator` being in-process for session callbacks/signals.
- Windows and non-TTY.

Headless `agav workflows` still cannot start a job (coordinator headless gate) or stop one (cancellation reported incomplete); only the interactive App can. Not implemented: detach, schedules, workflow-run grants, job timeouts, interpolation, retries, parallelism, labels/mailbox notifications. See "Job nodes (slice A+B)" in `docs/workflow-verification-report.md`.
