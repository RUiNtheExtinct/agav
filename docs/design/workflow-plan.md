# Workflow plan: agent/loop, background execution, Workflows TUI

**Status:** draft for review.
**Builds on:** the validated foreground workflow implementation in `/home/pranav/cli/agav/source/workflows/`. Today it supports `tool`, `approval` and `job` nodes, sequential execution, atomic checkpoints and resume.

**Supporting documents** (this plan summarizes them; the detail lives there):
- `docs/workflow-plan-research.md`: code facts and the current limitations.
- `docs/workflow-roadmap.md`: the full feature ranking with IDs (A1, L1, B1…) used below.
- `docs/workflow-background-and-tui-design.md`: the full background-runner and TUI design.

---

## 1. Goals

1. **Agent and loop workflows.** A workflow can call installed agents (native and A2A) and repeat a sub-graph boundedly until a condition holds. One example is "run tests → fix failures → repeat until passing".
2. **Runs outlive the terminal.** Starting a workflow returns at once. The run continues as a supervised background job, survives closing the CLI or TUI, and can be watched, approved, cancelled or resumed from any later session.
3. **A first-class Workflows TUI** built on the same `ResourceManager` theme as agents, skills, jobs and memory. It replaces raw-JSON output and copy-pasted UUIDs.
4. **Keep the safety properties already validated:**
   - fail-closed validation and checkpoints
   - no auto-replay of interrupted mutating tools
   - workflow approvals never grant tool permission
   - job reattach instead of re-launch

**Non-goals:** dynamic model routing, a visual graph editor, arbitrary graph cycles, a cloud control plane, and shell interpolation into commands.

---

## 2. Scope

### 2.1 Kept (extend, don't rewrite)

- The JSON definition with strict Ajv validation, cycle checks and unknown-dependency checks.
- `tool` nodes through `gatedToolExecute`.
- `job` nodes with an idempotent `requestId`, reattach, explicit stop, and fail-closed handling of uncertain states.
- Atomic checkpoints, the run lock, the durable cancel marker, cwd pinning, and refusal of corrupt checkpoints.
- The rule that an interrupted mutating tool node is never replayed automatically. It now gets an explicit operator retry or skip action instead (R5).
- The two feature gates, `backgroundJobsEnabled` and `workflowsEnabled`.
- `approval` nodes, **upgraded**: decisions are structured, can be made from any session, and approving resumes the run automatically.

### 2.2 New

P0 means in this plan's release. P1 means a fast follow.

| Area | P0 | P1 |
|---|---|---|
| **Agent** | A1 `agent` node (native and A2A through one invoker, with per-node model, effort, timeout and maxIterations). A2 `prompt` node. A3 structured JSON output plus `outputSchema`. A4 path interpolation (`${nodes.x.output.a.b}`, `${loop.*}`). | `skill` node |
| **Loop** | L1 sequential `loop` (body sub-DAG, required `maxIterations` with a hard cap of 50, `until`/`stopWhen`, per-iteration checkpoints). L2 per-iteration context (`loop.prev`, capped `loop.history`). | L3 `forEach` fan-out with `maxConcurrency` |
| **Control and reliability** | C1 safe `when:` expressions (no `eval`) and the `skipped` status. R1 retries (agent, prompt, job and read-only tool nodes; job attempt ids become `-<n>`). R2 timeouts for every node type plus a run deadline. R3 a `policies` block that can only narrow, never widen. | S1 parallel DAG scheduling. R4 `continueOnError`. R5 operator retry, skip or rewind of a node. |
| **Authoring** | D1 discovery by name (`.agav/workflows`, `~/.agav/workflows`). D2 YAML. D3 typed `inputs` with defaults. | D4 workflow `outputs`. D5 a per-run artifacts directory. T2 `dry-run`. |
| **Background** | B1 a detached runner job. B2 an approval and consent inbox. B3 mailbox notifications. B4 run history with pruning. | B5 `events.jsonl` trace and logs (a minimal version ships in P0 for the TUI). B6 schedules. |
| **UX** | U1 the Workflows TUI. U2 live run detail. U3 human-readable output, with `--json` for scripts. U4 short run ids. | |
| **Quality** | T1 a workflow test suite (none exists today). | |

### 2.3 Dropped or deferred

- **Dropped:**
  - the `reduce` node (a `prompt` node with several dependencies does the same job)
  - the explicit `parallel` node (covered by S1 and L3)
  - provider switching and routing
  - arbitrary cycles
  - automatic replay of mutating tools
  - an in-TUI graph editor
- **Deferred to P2:**
  - the `test` assertion node
  - token and cost budgets
  - evals
  - `${shell:}` quoting
  - splitting checkpoint files per node

---

## 3. Architecture: background execution (summary)

The full design is in `workflow-background-and-tui-design.md`, Part A.

- **Runner = one supervised `/job` per run.** `coordinator.start` launches `node <cli> --internal-workflow-runner <runId>` with `requestId = wf-run-<runId>-<attempt>`. This reuses the supervisor's detach, process-group stop, liveness checks, logs, mailbox and capacity handling.
  - A dedicated workflow daemon and plain `spawn(detached)` were considered and rejected.
- **The engine stays host-agnostic.** `executeRun` is unchanged at its core. Only the injected host differs:
  - **BackgroundHost** (the default): gates become inbox decisions.
  - **ForegroundHost** (`--foreground`, used for debugging and tests): behaves as today.
- **Single writer.** The runner holds the run lock for its whole life and is the only writer of `run.json`. Other sessions talk to it only through create-once side files:
  - `<runId>.cancel`, as today.
  - `<runId>/decisions/<id>.decided.json`, written with `createExclusive`, so exactly one decision wins.
- **Parking.** When nothing is runnable because a gate is pending, the runner saves `waiting_approval`, posts a mailbox event and **exits**, freeing its job slot. Deciding the gate relaunches the runner with `attempt+1`. If the runner is still live, it applies the decision in-process.
- **Run states:** pending → queued → running → passed | failed | timed_out | waiting_approval | cancelling → cancelled | interrupted. `RunStatus` becomes its own type, separate from `NodeStatus`.
- **Crash recovery (reconcile).** A reconcile check runs on App startup, when the TUI opens, on status or list, and before a relaunch. It checks the runner job by `requestId`. If the run says `running` but its runner is dead:
  - The run is marked `interrupted` and relaunched automatically, at most 3 times.
  - Job nodes reattach.
  - Agent and prompt nodes re-run, unless the node sets `retrySafe:false`.
  - An interrupted mutating tool becomes an `uncertain_tool` inbox decision.
  - An `unknown` runner is never relaunched automatically.
- **Authorization (gap G1).** A new grant action, `workflow-run`, is bound to `hash(definition, cwd, permissionMode, declared capabilities)`.
  - You see **one** interactive prompt on the first background launch.
  - The runner's headless session approves `start`/`stop` only for literal job commands covered by the grant.
  - A CLI launch without a grant fails clearly and never infers consent.
- **Capacity (gap G7).** A separate `maxConcurrentWorkflowRuns` pool (default 2) means runner processes don't use up the child-job pool (`maxConcurrentJobs`, 4). A full pool leaves the run `queued`, never failed.
- **Cancel.** The cancel marker plus `coordinator.stop(runner)`. The runner traps SIGTERM, stops its child jobs and checkpoints `cancelled` within 4 s, inside the supervisor's 5 s grace period.

---

## 4. TUI design (summary)

The full design is in `workflow-background-and-tui-design.md`, Part B.

- Built on **`ResourceManager` + adapters**, the same as JobsTUI and SkillsTUI. `ResourceKind` gains `"workflows"`. `/workflows` with no arguments opens the TUI.
- **Tabs (switched with `Tab`):**
  - **Workflows:** discovered definitions. Details show inputs, nodes, loops and grant status. `R` runs (with an input form generated from the typed inputs), `v` validates, `g` revokes the grant, `n` scaffolds from a template, `e` opens `$EDITOR`.
  - **Runs:** history, newest first, with status icons (✓ ✗ ● ◐ ⊘ ⏱ … !) and short ids. The **live detail** shows the node tree with loop iteration progress and the event tail, refreshed every 1 s. Keys: `x` cancel, `a`/`D` approve or deny, `l` logs, `R` re-run, `u` resume, `d` delete.
  - **Inbox (n):** pending approval, tool-consent, job-start and uncertain-tool decisions, showing the full resolved input. Approve and deny use the shared `y: Approve · n/ESC: Deny` confirmation. The App status bar shows `workflows: 1 running · 2 need approval`.
- Custom keys avoid ResourceManager's reserved keys (`↑↓ ←→ Enter/i s r n e t d b ESC`).
- Slash and CLI output becomes concise summaries and trees. `agav workflows status --json` keeps the old output. `WorkflowToolConfirm` is kept only for `--foreground`, restyled to the shared confirmation layout.
- **Generic change:** ResourceManager gets an optional `refreshIntervalMs`, which JobsTUI can also use.

---

## 5. Phased milestones

The order follows the dependencies, not the list in the request. Agent and loop behave differently in the background because consent becomes inbox decisions. The plan therefore lands the engine refactor first, then the runner, then agent and loop on top of the runner, then the TUI. The TUI's read-only Runs view can start in parallel with Phase 3.

```
Phase 0 ──► Phase 1 ──► Phase 2 ──┬──► Phase 3 ──► Phase 4 ──┐
(engine     (background (inbox +   │   (agent/     (loop +    ├──► Phase 6 (P1 follow-ups)
 prep +      runner)     notify)   │    prompt)     control)  │
 tests)                            └──► Phase 5 (TUI) ────────┘
```

### Phase 0: Engine preparation and test harness 

- Add a `RunStatus` type, the `skipped` node status, `run.host`, a widened `output: unknown` with a size cap and artifact overflow (A3 storage only), and job attempt ids `-<n>`.
- Extract the node dispatch in `executeRun` into a `NodeExecutor` registry: `tool`, `approval`, `job`. Loops and new node types plug in here. Behavior must not change.
- Workflow loader: discovery by name and YAML (D1, D2), and typed inputs (D3).
- Create `source/__tests__/workflows.*.test.ts`. It locks in today's behavior (validation, resume, approval, cancel, job reattach with a fake coordinator) *before* the refactor lands.
- **Exit criteria:** the existing manual scenarios in `test-scenario.md` Part A still pass, the new suite is green, and `tsc --noEmit` is clean.

### Phase 1: Background runner (depends on Phase 0)

- Add the `--internal-workflow-runner <runId>` flag (registered in `INTERNAL_FLAGS`, exits before Ink renders), the runner launch and reattach via `coordinator.start` and `findByRequestId`, and the `queued`/`interrupted` states.
- Add `maxConcurrentWorkflowRuns` (G7) and the `workflow-run` grant action (G1), plus the one-time interactive consent prompt.
- Reconcile on startup, status and list. SIGTERM shutdown that stops child jobs and checkpoints `cancelled`.
- CLI: `run` defaults to background, `--wait` attaches (Ctrl+C detaches), `--foreground` keeps today's behavior. Slash `run` returns immediately.
- Minimal `events.jsonl` (node started and completed, run status).
- **Exit criteria**, checked against a real supervisor, not just a fake coordinator:
  - A run started from the TUI keeps running after the TUI is killed with `kill -9` and finishes.
  - Cancel from a new session stops the runner and its child job.
  - Killing the runner mid-node, then reconcile, reattaches the job node without starting a second job.
  - A full runner pool queues and later starts the run.

### Phase 2: Inbox and notifications (depends on Phase 1)

- Decision files (`createExclusive`), the BackgroundHost turning approvals and tool consent into decisions, parking and exiting, relaunch on decision, `approvalTimeoutSeconds`, and the `uncertain_tool` decision.
- Change `decideApproval` to write a decision file instead of mutating the checkpoint. Structured decision records: `decidedAt`, `decidedBy`, `note`.
- Mailbox completion and attention events (B3). Wire the App to present each one once (G2).
- **Exit criteria:**
  - An approval gate parks the run and the runner exits.
  - Approving from a different session resumes the run automatically.
  - Two concurrent approvers yield exactly one decision.
  - Tool consent approves exactly the resolved input it showed. A changed input asks again.

### Phase 3: Agent and prompt nodes (depends on Phase 2)

- An `AgentInvoker` interface over `executeNativeAgent` and `executeA2AAgent`, with an injectable mock. The runner builds the provider from `loadConfig()`.
- `agent` and `prompt` nodes (A1, A2): isolated context (only the interpolated task), per-node model, effort, maxIterations and timeoutSeconds, and narrowed `allowedTools` for prompt nodes.
- Agent sub-tool confirmations become `agent_tool_consent` decisions in background mode.
- Structured output with `outputSchema` validation (A3), and path interpolation (A4).
- Agent transcript goes to an artifact. Usage is recorded on the node.
- **Exit criteria:**
  - A native and an A2A agent node both run through the same invoker, in the background.
  - A schema-invalid output fails the node.
  - The conversation history never reaches the node, which is asserted in tests.

### Phase 4: Loop and control flow (depends on Phase 3)

- The `loop` node (L1) as a recursive sub-DAG executor with per-iteration checkpoints (`iterations[i].nodes`). Resume mid-iteration follows the normal rules. The hard caps are 50 iterations, nesting depth 2, and 500 node executions per run.
- Per-iteration context (L2), the `when` expression language shared with `until` (C1), retries (R1), timeouts for every node type plus the run deadline (R2), and policies (R3).
- Job-node timeout: a runtime-driven explicit stop when the timeout fires, until G3 (supervisor `maxRuntimeMs`) lands.
- **Exit criteria:**
  - "Fix until tests pass" stops on success and on `maxIterations`.
  - Killing the runner during iteration 2 resumes in iteration 2 without re-running passed body nodes.
  - `when:false` gives `skipped`.
  - A retried job uses a new attempt id.
  - A timed-out agent node is aborted and recorded as `timed_out`.

### Phase 5: Workflows TUI and output (Runs/Inbox can start after Phase 2, live loop rendering needs Phase 4)

- `resources/workflow-adapters.ts` (Workflows, Runs and Inbox adapters), `components/workflows-tui.tsx`, `workflows/format.ts`, `ResourceKind "workflows"`, ResourceManager `refreshIntervalMs`, the status-bar badge, short ids (U4), and human-readable CLI and slash output with `--json` (U3).
- Restyle `WorkflowToolConfirm` for `--foreground` only.
- **Exit criteria:**
  - Every action in the design's key tables works.
  - No custom key collides with a reserved ResourceManager key.
  - The live detail updates while a loop runs.
  - Approve and deny from the Inbox resume the run.
  - Manual walkthrough on an 80×24 terminal.

### Phase 6: P1 follow-ups (scheduled after release)

- S1 parallel scheduling, then L3 `forEach`.
- R4 and R5 operator actions.
- D4 outputs, D5 artifacts browser.
- B6 schedules on the `/job` schedule engine.
- T2 dry-run.
- `skill` node.
- G11 run retention pruning.


---

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Credentials in the runner.** `/job` passes a minimal environment, so providers configured only through env vars fail in the background. | Agent nodes fail only when run in the background | Prefer stored credentials (`loadConfig`). Add derived `envInherit` names to the runner spec and grant hash. Test in Phase 1 with a provider configured only through env vars. |
| **Changes to background-jobs shared types** (new `GrantAction`, pool, `maxRuntimeMs`) need the owner's sign-off | Schedule slip | Batch G1, G3 and G7 in a single review early in Phase 1. Fall back to workflow-local extension types. |
| **Agent nodes re-run after a crash** cause duplicate side effects (an agent's mutating sub-tools) | Duplicate writes | Agent sub-tool consent still applies in the background. `retrySafe:false` on a node turns re-run into an `uncertain` decision. Document it. |
| **Background consent fatigue** (every mutating tool becomes an inbox item) | Users turn on auto-accept broadly | A scoped `workflow-run` grant with a static capability list. `allowedTools` patterns. Show the capability list in the TUI. |
| **Stale run lock after a hard kill** (gap G5 not yet in `/job`) | A run cannot be resumed | Report the dead owner with a manual unlock command. Prioritize G5 in Phase 1 if it's cheap. |
| **Runner pool starvation**: parked runs exit and free their slots, but long agent runs hold them | Queue latency | Pool size is configurable. FIFO admission. The TUI shows `queued` with its position. |
| **Loop blow-up** (cost, time) | Runaway token spend | Hard caps (50 iterations, 500 executions), a run deadline, and a per-node timeout. B7 budgets in P2. |
| **Hard links unavailable** on network filesystems (`createExclusive` fails closed) | No decisions possible | Detect this at `workflowsEnabled` time and warn. Document that the agav dir must be on a local filesystem. |
| **Windows**: background jobs report `nativeHelperAvailable:false`; workflows now use an unsandboxed fallback | No guaranteed Job Object ownership or descendant cleanup | Warn explicitly; preserve consent and `sandboxRequired`. Docker can sandbox explicit `run_command` calls only, not runners or job nodes. No user-facing `--foreground` is implemented. |
| **ResourceManager rendering limits** (plain-text titles, a single detail text block) | The live tree has to be text | The design already renders the tree as text. Revisit a richer detail renderer only if needed. |

---

## 7. Open questions

1. **Default mode.** Should `/workflows run` default to background (proposed) or foreground, with background being opt-in? Background is what you asked for, but it adds the one-time grant prompt.
Ans - it should only run in the background 
2. **Grant scope.** One `workflow-run` grant per definition hash (proposed), or per node? Should a grant also cover agent sub-tools, or always ask per invocation?
Ans = grant is asked per inocation and passed down to the nodes
3. **Agent re-run after a crash.** Re-run by default (proposed, `retrySafe:true`) or treat it as uncertain by default?
Ans- use retrySafe:true
4. **Env-only provider credentials.** Should the runner inherit them automatically (and include them in the consent hash), or ask the user to store credentials?
Ans - at the time of invocation, user can choose which env is passed down (select all, disselect all and list of env vars with checkbox in front of them)
5. **Approval timeouts.** Should a headless approval wait forever (proposed default) or expire?
Ans - wait forever
6. **Retention.** Prune finished runs after `completedLogRetentionDays` (7), shared with `/job`, or use a separate setting?
Ans - use similar to /job
7. **Editing workflows.** Is `$EDITOR` plus templates enough, or do you want an in-TUI field editor for simple workflows?
Ans - in-TUI editor will be better, but if to complex, we can park that.
8. **Mutating tools in a loop.** Should each iteration's tool consent be asked again (safe, but noisy), or should one approval cover identical resolved inputs across iterations?
Ans - cover identical calls
---

## 8. Definition of done (P0 release)

- [ ] A workflow with an `agent` node inside a bounded `loop` runs to completion in the background after the user closes the TUI.
- [ ] Approval and consent gates appear in the Inbox in a new session. Approving resumes the run without typing `resume`.
- [ ] Cancel, reconcile after a runner crash, and job reattach have been verified against a real supervisor.
- [ ] The Workflows TUI (Workflows, Runs and Inbox tabs) matches the ResourceManager theme. No raw JSON appears in the transcript.
- [ ] The workflow test suite covers validation, resume, approval, the inbox race, agent invoker isolation, loop caps and resume, retries, timeouts, and runner reattach. `tsc --noEmit` is clean.
- [ ] Docs: `docs/docs/reference/workflows.md` is updated for the new nodes, background mode and the TUI.
