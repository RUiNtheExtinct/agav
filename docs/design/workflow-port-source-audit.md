# Workflow port: source audit and first implementation milestone

## Scope and evidence

This is **Step 1 research only**: no production changes, test additions, test execution, checkout, stash application, or implementation. Findings are from repository inventory, Git tree/history inspection, and reading source/tests, not reproducing runtime behaviour. The separate `/job` phase-0 audit remains authoritative for foundation gaps and their current completion status.

Audited base: `cb427e906d4c3926d02f45d60f25180b9083dc34` (the user's `feat/workflows`, also the isolated research worktree's starting commit). The user worktree contains substantial dirty production changes, tests, and design documents; those were read where relevant and left untouched. The branch name **does not mean the workflow engine has been ported**.

Author source was retrieved and read at **`7b3d91101946e57f10848ea483837dfd24b52770`**, advertised by `https://github.com/code-hack-batch/agav.git`, branch `feat/workflow-scheduling-v2`. This is an observed accessible source snapshot, not an assumed PR revision or a claim that its tests pass.

## 1. Inventory before source selection

The initial `overview` was followed by a recursive file inventory (excluding Git internals/dependencies), root/config inspection, test-location inspection, and Git status/ref/worktree inventory.

- Main application: TypeScript ESM under `source/`; `source/cli.tsx`, `main.tsx`, `app.tsx`, `agent/`, `agents/`, `commands/`, `components/`, `config/`, `hooks/`, `providers/`, `resources/`, `skills/`, `tools/`, `utils/`, and a vendored `ink/` renderer.
- Background execution: `source/background-jobs/` has authorization, coordinator, host/OS-scheduler, IPC, launch normalization/environment, logging, mailbox, packaging, platform, recovery, schedule, storage, and supervisor layers. Product adapters include `background-jobs-integration.ts`, `tools/background-job.ts`, `commands/job.ts`, `cli/job-cli.ts`, and `components/jobs-tui.tsx`.
- Main tests: `source/__tests__/` and `source/background-jobs/__tests__/`, including fixtures and OS-scheduler expected artifacts. Other suites: installer tests in `scripts/tests/`, and release-worker tests in `docs/deploy/releases-worker/test/`. There was no root `test/`, `tests/`, `verifier/`, or `expected/` directory in the inventoried worktree. Benchmark verification lives in `benchmarks/verify-run.sh`; it is not a workflow-port acceptance harness.
- Config/build constraints: root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`, `.nvmrc`, `.editorconfig`, `.github/workflows/`, and `.husky/`. Root scripts use `tsc`, `tsx`, Vitest, and pnpm; `build/` and `dist/` are generated outputs, not port targets. `ajv` and `yaml`, used by the author engine, already exist as dependencies. Documentation has its own Next.js package/config and deployment config; no dependency/build edit is needed for this report.
- Documentation: user-facing pages are under `docs/docs/`; design/research/release material also exists outside that tree. The requested implementation plan exists as an **untracked file in the user's worktree**, not in the clean research base. It was read directly there.

### Related-document availability

Read `docs/workflows-on-job-implementation.md` in full from the user worktree. `docs/job-vs-process-comparison.md` is absent from the current working tree, but **is present in `refs/stash`**, whose message is `On feat/workflows: workflow initial progress`; it was read using `git show refs/stash:docs/job-vs-process-comparison.md`, without applying the stash. This distinction matters: its historical counts, PR statuses, missing features, and platform descriptions are not evidence of today's implementation.

Also inspected the headings of `job-dependency-model.md` and `job-approval-sandbox-notifications.md`.

## 2. Motivation and intended phase boundaries

The implementation plan preserves the author's workflow language, DAG execution, checkpoints/attempt history, retries, conditions, approvals, evals, and metrics. It replaces the duplicated detached process launcher and scheduler underneath it with `/job`.

The historical comparison argues against importing `/process`: mutable JSON records and raw PID tracking, races between writers, prematurely recorded kills, weak environment filtering, permission bypass on scheduled execution, and a duplicate launcher with no captured output. The current `/job` architecture supplies a coordinator boundary, spec-bound consent, supervisors, validated identifiers, identity-aware reconciliation, segmented logs, durable completion events, and occurrence reservation. Those are architectural reasons to reuse it; this report does not certify every current guarantee.

Implementation-plan phases, in order:

1. **Phase 0:** audit/harden `/job` foundations; do not mechanically reimplement gaps already fixed.
2. **Phase 1:** foreground/in-process engine port, permission gating, dependency/retry and timeout/cancellation fixes. No detached execution or workflow scheduling.
3. **Phase 2:** explicit child-job nodes, ownership metadata, per-job timeout, queueing/capacity, and request-ID-based recovery.
4. **Phase 3:** detached runner on `/job`, definition/input/cwd-bound unattended grants, mailbox/UI delivery and notification sinks.
5. **Phase 4:** workflow schedules on the existing `/job` schedule engine and shared tick hosts; explicit migration/consent.
6. **Phase 5:** retention, labels/UX, optional model-facing workflow tool, and polish.

An engine-first milestone must not silently introduce `process`, the author's detached launcher, or a second schedule driver as shortcuts.

## 3. Where source exists and how to retrieve it safely

### Local observations

- Configured remote is only `origin`, pointing to `git@github.com:prapaa-ai/agav.git`. No author-fork remote is configured.
- Named branches include `feat/workflows` and `feat/background-processes`; neither tree contains `source/workflows/` or `source/cli/workflows-cli.ts`.
- Every currently named ref was checked for those engine paths, including remote-tracking refs and stash refs: **none contains the engine**. This is a ref/tree finding, not proof about every unreachable object in the object database.
- Git history reachable through refs contains the comparison document. The workflow-progress stash contains design/research documents, not the author engine. It must not be applied or dropped to obtain source.
- Read-only Git commands (`show`, `ls-tree`, `log`, `for-each-ref`) suffice to inspect local refs without checkout. Other worktrees listed by Git were not checked out or modified.

### Verified remote availability

`git ls-remote https://github.com/code-hack-batch/agav.git refs/heads/feat/workflow-scheduling-v2` returned:

```text
7b3d91101946e57f10848ea483837dfd24b52770 refs/heads/feat/workflow-scheduling-v2
```

A fetch into the user's shared object store using `--no-tags --no-write-fetch-head` was **refused by the filesystem** while creating a pack temp file. There was no checkout/ref update. Rather than bypassing that restriction, retrieval succeeded into a separate temporary bare Git repository using HTTPS and a shallow fetch. Its `FETCH_HEAD` resolved to the advertised SHA; `ls-tree` and `log` exposed the modules and tests below. Subsequent source reads used immutable raw URLs at the same SHA. Tool temporary directories are not guaranteed to persist across calls; the temporary clone is **not a delivered source cache**.

Recommended implementation retrieval (separate scratch directory, no user branch/ref changes):

```sh
scratch=$(mktemp -d)
git init --bare "$scratch/author.git"
git -C "$scratch/author.git" fetch --depth=20 --no-tags \
  https://github.com/code-hack-batch/agav.git \
  refs/heads/feat/workflow-scheduling-v2
git -C "$scratch/author.git" rev-parse FETCH_HEAD
# Confirm the audited SHA, or explicitly review drift before proceeding.
git -C "$scratch/author.git" ls-tree -r --name-only FETCH_HEAD
```

Use `git show <sha>:<path>` or extract an explicitly reviewed path allowlist from the pinned tree into scratch. Review each selected file before copying it into an implementation worktree. Do not merge/cherry-pick the entire author branch: it includes unrelated changes, `process`, scheduler/config wiring, and different host APIs. Do not run fetched code/install hooks merely to inspect it. Preserve source attribution and inspect applicable license/PR provenance before shipping; exact ancestry to PRs #411/#412/#413 and licensing equivalence were **not established** here. A moving branch name is not a reproducible import reference.

## 4. Reuse map at the pinned author snapshot

Verified author tree paths are prefixed `source/workflows/` unless stated otherwise.

| Modules | Reuse decision and concrete adaptation |
| --- | --- |
| `types.ts`, `hash.ts` | Preserve versioned definitions, node/run statuses, usage, policies, attempts and definition hashes. Reconcile with current provider/config/tool contracts; defer host/job fields until their phase. |
| `loader.ts` | Reuse YAML/JSON loading, explicit paths, project-first discovery. Observed `workflowSearchDirs` hardcodes `homedir()/.agav/workflows` (`:15–16`); change the global root to current `getAgavDir()` during the port. Loading casts parsed data; execution must pass validation. |
| `validator.ts` | Reuse supported-node, dependency/cycle, condition, registry and output-schema checks. Supply the actual populated registry/agent/skill capabilities, not an empty registry. Explicitly reject legacy `process` nodes/tools. Audit malformed nested input and identifier constraints before exposing writes. |
| `interpolate.ts`, `condition.ts` | Reuse recursive input/output substitution and restricted comparisons (not arbitrary JS evaluation). Plain interpolation is not shell quoting. Interpreter-aware quoting/validation must precede shell-backed workflow nodes. |
| `store.ts` | Reuse run/checkpoint/attempt/log layout and injectable `rootDir`, but not blind trust in its I/O safety; see storage risks below. Defaults already use `getAgavDir()`. |
| `retry.ts` | Reuse attempt budgets, backoff, explicit crash-retry approval and retry-safe policy. Idempotency keys are metadata, not proof that a third-party side effect is deduplicated. |
| `evals.ts`, `metrics.ts` | Preserve eval/observability and usage accounting; adapt surrounding interfaces minimally. These are identified as reusable by the plan and present in the tree, not exhaustively audited here. |
| `runtime.ts` | Reuse DAG batching, node handlers, parallel/loop machinery, `RunController`, deadlines/token budgets and checkpoint flow **with the fixes below**. It imports current-style `ConversationState`, providers, registry and `runAgentLoop`; those interfaces have drifted. |
| `control.ts` | Reuse status/approval/attempt/rewind concepts. Rewrite active pause/cancel to control the actual live foreground controller, not only JSON. Retry must clear stale run errors and preserve dependency ordering. |
| `source/cli/workflows-cli.ts`, `source/commands/workflows.ts` | Adapt foreground commands incrementally to current CLI/command host contracts. Remove/reject detached `jobs`/`jobs-stop`, scheduler and daemon surfaces from milestone one; do not port whole integration files. |
| `jobs.ts` | **Do not import.** Replace later with a `/job`-backed host. No `WorkflowJobRecord`, stop-file loop or raw PID liveness layer. |
| `schedule-plan.ts`, `schedule-run.ts`, `scheduler-daemon.ts`, `source/cli/scheduler-cli.ts`, workflow changes to `config/scheduler.ts` | **Do not import as production infrastructure.** Carry useful policy/fixtures forward later onto `/job` occurrence reservation and existing tick/host modules. |
| `notifications.ts`, `source/utils/desktop-notify.ts` | Optional later sink/presentation reuse after security review. Durable delivery belongs to mailbox claims/acks, not polling and rewriting `run.json`. |
| `source/tools/process.ts`, `source/utils/tool-confirmation.ts` | Drop the execution implementation; warning wording may inform later `/job` consent UX. |

### Existing local integration seams

- `ToolRegistry.execute` catches errors and bounds results, but **is not the permission gate**. In current `source/agent/loop.ts`, allowed-tools filtering, destructive-command classification, deny-writes handling, confirmation and trusted background policy are applied before registry dispatch. A workflow must preserve those semantics, including stricter background consent, rather than invoking the registry unchecked.
- Current `ToolContext` has signal, env, trusted background policy, headless/conversation/system-prompt and permission-mode fields, but **no `idempotencyKey`**. The registry forwards context only when certain fields are present. Adding the key later requires checking both the interface and the dispatch forwarding condition; do not assume a type addition delivers it.
- `createToolRegistry` in `tools/registry-factory.ts` builds ordinary built-ins; specialized agents/skills/MCP may require additional host wiring. Validation should use the same effective capabilities as execution, not claim factory creation alone populates all integrations.
- `CommandContext` currently has no general `confirmTool` callback (it has background-action confirmation). Foreground workflow prompts need an explicit trusted approval seam and active-run lifecycle integration in the host. Absent a callback, mutating work must fail closed, not default to consent.
- Keep workflow orchestration above `coordinator`; preserve dependency and single-writer rules in `background-jobs/README.md`. Do not import UI into storage/mailbox/platform layers or use private supervisor internals as workflow APIs.

## 5. Confirmed code risks and required port fixes

These are source observations at the pinned snapshot, not executed repros:

1. **Permission bypass:** `runtime.ts:539–555` calls `deps.toolRegistry.execute` directly for tool nodes. Test-command assertions similarly execute `run_command` at `:594` without a gate. Route both through a trusted executor matching current `ask`, `deny-writes`, `auto-accept`, allowed-tools and destructive-command semantics. `auto-accept` is not sandboxing and must not bypass exact background-job consent.
2. **Readiness bypass:** `isReady` at `runtime.ts:343` returns true for `pending` before checking dependencies at `:365–375`. Cancelled and retryable failure branches also return early (`:344–356`); audit **all** paths that become runnable, not only the single pending line. Retry/rewind must never release a descendant before the upstream attempt finishes successfully under the defined skip policy.
3. **Timeout does not stop work:** `withNodeTimeout` at `runtime.ts:1484–1528` races the work against a timer without aborting a node controller. Work is already started before the wrapper. Create/link the node signal before dispatch; abort on expiry, track settlement, and prohibit overlapping retries. Non-cooperative work cannot be claimed stopped: checkpoint/report uncertainty and block unsafe retry instead of pretending cancellation is confinement.
4. **Test cancellation signal lost:** `executeNode` calls `executeTestNode` without the run signal at `:450`; the test handler accepts a signal, but its command registry invocation at `:594` omits context. Forward the effective node signal through both hops and every executable assertion path.
5. **Pause/cancel only edit records:** `control.ts:54–79` changes JSON status; it does not stop in-flight work. Foreground controls must abort the live controller and settle/checkpoint consistently. Detached controls are out of the first milestone.
6. **Stale error after retry:** `control.ts:82–108` resets checkpoint errors/statuses but does not clear `run.error`. Clear it when establishing the new attempt state.
7. **Storage safety needs a real port review:** `store.ts:26–27` joins caller-supplied run IDs directly to the root; `safeNodeId` (`:186–187`) is lossy (`a/b` and `a_b` collide). Validate run IDs at the storage boundary and make accepted node IDs/checkpoint filenames collision-safe, including loop-generated IDs. `writeJsonAtomic` (`:162–175`) does not fsync and on Windows removes the destination before renaming; failed replacement can lose the previous checkpoint. `readJson` (`:178–182`) swallows corruption and I/O errors as absence. Use the project's safe atomic-write patterns, preserve old state on failed writes, clean temp files, and surface corruption rather than treating it as permission to rerun side effects. No exploit or crash durability test was run.
8. **Interpolation is unquoted:** `interpolate.ts:19–25` substitutes strings verbatim; it is not safe shell argument escaping. Even foreground tool/test `run_command` can receive interpolated untrusted output. Keep permission checks, define/document the boundary, and reject or safely quote unsafe command substitution before presenting a workflow as safe unattended execution. The plan's `${shell:…}` feature is proposed, not present in this snapshot.
9. **Dry-run is not guaranteed side-effect-free:** the author's `DRY_RUN_SAFE_TOOLS` includes `run_tests` (`runtime.ts:48–59`). Test runners execute repository-controlled code. Do not equate safe-tool classification with no writes/network; use explicit mocks/skips and the same execution gate/sandbox policy.
10. **Do not resurrect obsolete infrastructure:** the author daemon declares a lock path but its startup reads a PID record then writes a file (`scheduler-daemon.ts:98–119`), not an exclusive acquisition. This confirms a race-prone pattern, not a new service to adopt. The plan's other launcher/daemon/notification bug reports are historical findings unless independently checked above; current `/job` replacements need their own audit.

Security fixes in the user's dirty workspace (sandbox enforcement, workspace warnings and related host changes) are active work, not permission to overwrite those files with author versions. Coordinate integration against their final APIs. The existing `/job` README also explicitly says real macOS/Windows verification and staged hardening are incomplete; do not repeat the older comparison's platform guarantees as current guarantees.

## 6. Existing tests worth importing later

The author tree includes engine suites for runtime, loader, control, condition/when, parallel, loop, retry-hardening/retry-policy, attempts-cancellation, run-deadline, shutdown, token-budget, agent usage, budget reporting/display, dry-run/evals and observability. It separately includes jobs, jobs-finish, schedule-plan, schedule-regressions, schedule-orphan, scheduler-daemon and notifications tests.

Read assertions from `workflows.runtime.test.ts`, `workflows.retry-hardening.test.ts`, `workflows.attempts-cancellation.test.ts` and `workflows.loader.test.ts`. They establish intended dependency-order execution/output passing, passed-checkpoint reuse, approval-aware crash retry, exponential backoff/attempt bounds, persisted terminal attempts, already-aborted runs pausing before execution, timeout status, and project YAML/explicit JSON loading. These are useful regression contracts, **not evidence of present passing behaviour or full security coverage**. In particular a timeout-status assertion does not prove work stopped; source fixes require stronger cancellation/non-overlap assertions.

Import only engine tests into allowed `__tests__/` locations, adapt fixtures to real current interfaces, and add failing-first regression coverage for the safety fixes. Rewrite launcher/scheduler tests against `/job` only when those phases begin. No tests were added or run in this research step.

## 7. Proposed smallest coherent implementation milestone

**Recommendation: a feature-gated, foreground-only vertical slice of the engine after the independent phase-0 audit, not a detached/scheduled run.** This corresponds to phase 1 in `workflows-on-job-implementation.md`.

### Entry gate

- Reconcile the independent `/job` gaps report with the older G1–G12 table; record fixed/missing/deferred items rather than implementing it wholesale. Current trees already contain host/tick/storage/recovery work absent from the old comparison.
- Confirm ownership of dirty host/security/config files and use an isolated implementation worktree based on the agreed integration point. Do not reset, stash, overwrite or autoformat the user's dirty files.
- Pin the author SHA and make a reviewed import allowlist. Agree the foreground approval callback, active-controller ownership, storage identifier policy, and feature-flag behaviour before exposing executable commands.

### Deliverable

1. Import/adapt the reusable engine modules, preserving the version-1 language and existing parallel/loop/retry/usage behaviour where supported. Do not invent a second job runner or partially import scheduler internals.
2. Supply gated tool/test execution and real capability validation; fix readiness, per-node abort/settlement, signal propagation, active foreground pause/cancel, retry error reset, and storage safety at their source boundaries.
3. Expose only feature-gated foreground commands: list/validate/run, status/logs/checkpoints/attempts, approval decisions, resume/retry/rewind, and actual pause/cancel. Adapt CLI and slash commands to the same service. Reject detached/schedule/legacy process forms clearly rather than silently running them foreground.
4. Exercise a small sequential A→approval→B workflow: A's checkpoint/output is reused after approval/resume; B cannot run early after retry/rewind; a denied mutating node never executes. Foreground agent/skill/prompt adapters must inherit the trusted policy and cancellation context too.

### Exit criteria for that later implementation

- Imported engine suites compile/pass with current interfaces; new regressions prove permission modes/allowlists/no-callback fail-closed behaviour, retry dependency ordering, abort propagation and no overlapping retries, real pause/cancel, corruption/identifier safety and atomic failure handling.
- CLI and slash-command smoke checks demonstrate validate/run/status/approval/resume and clear unsupported detach/schedule errors; disabled flag leaves current standalone `/job` behaviour unchanged.
- Run relevant source tests and broader surrounding suites with the required build-first treatment for tests importing `build/`. Typecheck/build and inspect complete output; do not edit generated artifacts.
- No promises yet of surviving host exit, headless approval, child-job exactly-once recovery, background notifications or schedule execution. Those remain later milestones with real-supervisor, mailbox and concurrent-host integration tests.

## 8. Remaining uncertainty / handoff

- Remote accessibility and the pinned tree are verified; runtime correctness, test pass status, PR-head mapping and full historical ancestry are not.
- This is not a full current `/job` gaps audit. Timeouts, workflow capacity/labels/grants, mailbox delivery and retention must be reconciled with that report before expanding scope.
- The author's complete CLI/agent/skill API compatibility and every validator branch still need import-time review. Presence of a module is not a drop-in compatibility claim.
- Windows process ownership/cancellation, real OS sandbox behaviour and desktop notification command safety are not runtime-verified here. Avoid widening claims based on historical design prose.

**Bottom line:** the engine is absent from locally named source refs but available from the specified author fork at a concrete SHA. Selectively port the foreground engine with its safety fixes; retain the existing `/job` execution/schedule architecture and defer all author launcher/scheduler infrastructure.
