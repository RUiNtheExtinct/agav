# Design: background workflow execution and the Workflows TUI

This document is the input to `docs/workflow-plan.md`. It builds on `workflow-plan-research.md` (the code facts) and `workflow-roadmap.md` (the feature IDs).

---

## Part A: Background execution

### A.1 Problem

Today `executeRun` runs inside the process that called it: `agav workflows run`, or the App's `runWorkflow`. That process holds the run lock, the abort controller and the signal handlers. If the process exits, the run stops.
- A `running` tool node becomes *uncertain*, and resume refuses it.
- An approval node parks the run until someone types `resume`.

The user wants runs to continue when no terminal is open.

### A.2 Options considered

| Option | How it works | Pros | Cons | Verdict |
|---|---|---|---|---|
| **1. A runner process per run, as a `/job`** | `coordinator.start({ requestId: "wf-run-<runId>", invocation: { mode: "direct", executable: process.execPath, args: [cli, "--internal-workflow-runner", runId] } })` | Reuses the supervisor: detach, process-group stop, liveness with PID-reuse protection, log capture, completion events in the mailbox, and capacity limits. `requestId` gives idempotent start and reattach. It matches the existing `--internal-background-jobs-*` re-exec pattern in `packaging/manifest.ts`. | A runner takes a job slot (G7). Headless authorization needs a grant (G1). The runner needs provider credentials. | **Chosen** |
| 2. A long-lived workflow daemon that executes every run | One `agav workflows daemon` process, with an IPC socket | One process for N runs. Approvals could be pushed over IPC. | A second supervisor/daemon stack: liveness, locks, upgrades and crash recovery all duplicate `/job`. If the daemon crashes, every run dies. | Rejected |
| 3. Keep foreground, add `--detach` via `nohup`/`spawn(detached)` | What PR #413 did | Simple | Already rejected in `workflows-on-job-implementation.md`: no liveness checks, no stop, no logs, a PID-check bug. | Rejected |

### A.3 Architecture

```
 TUI / slash / CLI (any session, may exit)                Runner (one per run, supervised /job)
 ─────────────────────────────────────────                ─────────────────────────────────────
 /workflows run X  ──createRun()──►  run.json (pending)
                   ──coordinator.start(runner spec)──►   supervisor ─► node cli --internal-workflow-runner <runId>
                                                                         │ store.lock(runId)        (one writer)
 TUI polls run.json + events.jsonl  ◄──── writes ───────────────────────┤ executeRun(store, id, …, host=BackgroundHost)
                                                                         │   agent/prompt/tool: in-process
 Inbox: <runId>/decisions/<id>.decided.json ─► runner watches ─────────►│   job nodes: child /jobs (unchanged adapter)
                                                                         │   approval/consent ⇒ park + decision record
 Mailbox event "waiting"/"passed"/"failed" ◄─── runner posts ───────────┘ exits when run is terminal or parked
 /workflows cancel ─► cancel marker + coordinator.stop(runner)  (SIGTERM ⇒ RunController abort ⇒ checkpoint)
```

**Key rule:** the engine (`executeRun`, the node executors and the store) stays **host-agnostic**. Only the `WorkflowExecutionHost` and `JobNodeDeps` passed in change.

| Host | `confirmTool` | Approval node | Job start authorization | Lifetime |
|---|---|---|---|---|
| **BackgroundHost** (the new default) | Creates a decision record. The node parks as `waiting_approval` with `reason: "tool_consent"` | Creates a decision record and parks | `headless: true`, plus the `workflow-run` grant (G1) | The runner process exits when the run is terminal or parked with nothing runnable |
| **ForegroundHost** (`--foreground`, kept for debugging and tests) | Uses today's in-App prompt | Behaves as today | Behaves as today, with the interactive `/job` confirm | Ends with the App process |

### A.4 Run lifecycle and state

New and changed run states. `RunStatus` becomes its own type, separate from `NodeStatus`.

```
pending ─launch─► queued ─runner admitted─► running ─┬─► passed | failed | timed_out
                     ▲                               ├─► waiting_approval ─(decision)─► queued (auto-relaunch)
                     └─────────── resume ────────────┤
                                                     ├─► cancelling ─► cancelled
                                                     └─► interrupted (runner died; reconcile decides)
```

- `queued` means a runner job has been requested but has not taken the lock yet. It covers capacity waits.
- `interrupted` is set by reconcile, never by the runner itself (see A.7).
- `run.host = { kind: "job", requestId, jobId?, attempt }` links the run to its runner. The attempt increments on each relaunch, which happens after a park or an interrupt: `requestId = wf-run-<runId>-<attempt>`.

**Storage.** This extends `~/.agav/workflow-runs/`, keeping the same atomic `writeAtomic` and lock primitives:

```
workflow-runs/
  <runId>.json            # unchanged checkpoint (+ host, outputs, iterations)
  <runId>.cancel          # unchanged cancel intent
  <runId>/events.jsonl    # NEW append-only trace (B5): node_started, node_completed, loop_iteration, decision_requested…
  <runId>/decisions/<decisionId>.json           # NEW pending request (written by the runner)
  <runId>/decisions/<decisionId>.decided.json   # NEW decision (createExclusive, by any session)
  <runId>/artifacts/      # NEW oversized outputs, agent transcripts
  locks/                  # unchanged
```

`run.json` remains the source of truth. `events.jsonl` is for display only, and a torn last line is ignored on read.

### A.5 Launch, attach and detach

| Action | Behavior |
|---|---|
| `run <name>` (CLI, slash or TUI) | `createRun`, then launch the runner. It returns immediately with the run id. The slash command shows a one-line summary and offers to open the run in the TUI. |
| `run <name> --wait` (CLI) | Launches the runner, then *attaches*: it tails `events.jsonl` and polls `run.json` until the run is terminal or parked. Ctrl+C **detaches**; it does not cancel. Exit codes stay as today. |
| `run <name> --foreground` | Today's in-process behavior. |
| Attach (TUI run detail, `workflows logs -f`) | Read-only tail. Any number of sessions can attach at once. |
| Detach | Close the view. The run is unaffected. |

### A.6 Approvals and consent inbox (B2)

A decision record looks like this:

```json
{ "id": "dec_…", "runId": "…", "nodeId": "deploy", "iteration": [2],
  "kind": "approval" | "tool_consent" | "agent_tool_consent" | "job_start",
  "prompt": "…", "details": { "tool": "write_file", "input": { … }, "directory": "…" },
  "status": "pending" | "approved" | "denied" | "expired",
  "requestedAt": "…", "decidedAt": "…", "decidedBy": "local-user@session-…", "note": "…" }
```

1. The runner reaches a gate. It writes the decision as `pending`, checkpoints the node as `waiting_approval` with `decisionId`, appends an event, and posts a mailbox event ("Workflow X needs approval").
2. The runner keeps executing other independent ready nodes (after S1). When nothing is runnable, it saves the run as `waiting_approval` and **exits**, freeing its job slot.
3. Any session can decide the record: the TUI Inbox tab, `/workflows approve <run> [node]`, or the CLI. The decider does **not** take the run lock, because a live runner holds it for its whole life. Instead it writes `<runId>/decisions/<decisionId>.decided.json` with `createExclusive` (`background-jobs/storage/atomic-file.ts`). Don't use `writeAtomic`, which renames over an existing file and would let a second decision silently replace the first. `createExclusive` publishes the file with `link()` and returns `false` if the file already exists. A second decider therefore gets `false` and is told the decision was already made, so there is exactly one decision. On filesystems without hard links it fails closed with `storage-unavailable`. Then:
   - If the runner is still live, it polls `decisions/` (on the same 100 ms timer as the cancel marker) and applies the decision in-process.
   - If the runner has exited (the run is parked), the decider **relaunches the runner** with `attempt+1`. `requestId` idempotency means two racing deciders launch the same job. This replaces today's separate `resume` step. The manual `resume` stays available.

   The runner is the only writer of `run.json`. `decideApproval` changes from mutating the checkpoint to writing the decision file.
4. On relaunch, the runner applies decisions:
   - Approval: approved means `passed`; denied means `failed`.
   - Tool consent: approved means **run that single invocation now**. Consent is bound to the decision's resolved input hash, and a changed input requires a new decision.
5. Optional `approvalTimeoutSeconds`: once it passes, the decision becomes `expired` and the node fails.

Invariant kept: **a workflow approval never grants tool permission.** Tool consent is a separate decision kind. A user can avoid repeated tool-consent decisions only by:
- running with `permissionMode: auto-accept` from an interactive launch, which is recorded in the grant; or
- a matching `allowedTools` grant.

### A.7 Crash recovery and reconcile

This follows the job node's reattach model. Reconcile runs on these triggers: App startup (cheap, non-blocking, alongside the existing `reconcileOnStartup`), TUI open, `workflows status|list`, and before any relaunch.

| Observed | Action |
|---|---|
| Run is `running` or `queued`, and its runner job is live (poll by `requestId`) | Nothing to do. |
| Run is `running`, and the runner job is terminal or not found | Mark the run `interrupted`. If the only running nodes are job nodes or agent/prompt nodes, auto-relaunch (attempt+1, bounded at 3). Job nodes reattach. Agent/prompt nodes are **re-run**: they're idempotent enough given isolated context, and this is configurable per node with `retrySafe: false`. A `running` **mutating tool** node is still `uncertain`. Park it with an inbox decision of kind `uncertain_tool` (retry / mark-failed / mark-skipped, roadmap R5). |
| Runner job is `unknown` / `recovery-required` | Mark `interrupted`, don't relaunch, and surface it in the TUI with a "Reconcile" action. Never start a second runner while the first might be alive. Idempotency via `requestId` makes a duplicate launch return the same job anyway. |
| Run is `waiting_approval` with no pending decision (crash between writes) | Recreate the decision from the node's checkpoint. |
| A stale lock with a dead owner | Depends on gap G5 (stale-lock recovery) in `/job`. Until that exists, report "lock held by dead process" with a manual unlock command. |

**Cancellation:** `cancelRun` writes the cancel marker. If the runner is live, it then calls `coordinator.stop(runnerJobId)`. The runner traps SIGTERM, aborts its RunController, stops its child jobs (existing `stopJobNode`), and checkpoints `cancelled` within a grace period (4 s, under the supervisor's 5 s SIGKILL). If the run is parked, it marks the run `cancelled` directly, as today. This needs a `stop` grant: an interactive cancel prompts as `/job` does today, and a headless cancel requires the workflow-run grant to include `stop`.

### A.8 Authorization (G1: workflow-run grant)

Problem: a headless runner can't start child jobs or run mutating tools today, because `headlessApprovedActions: []`. The headless gate runs before auto-accept (`authorization/service.ts`).

- New `GrantAction` value: `"workflow-run"`. The grant is bound to `hash(normalizedDefinition, cwd, permissionMode, declaredCapabilities)`. Inputs are excluded, so re-runs with different inputs reuse the grant. Changing the definition invalidates it.
- **One** interactive prompt the first time a workflow is launched from an interactive session. It reads: "Run workflow X in the background. It may: run agents [list], run job commands [literal list], use tools [list] under permission mode M." The lists are derived statically from the definition.
- The runner's session snapshot gets `headlessApprovedActions: ["start", "stop"]` **only** for child specs whose launch is covered by the grant: job commands are literal, so they can be matched exactly.
- A CLI launch without an existing grant fails with a clear message. It never prompts and never infers consent.
- A grant can be revoked from the TUI (Workflows → item → "Revoke background grant").

### A.9 Concurrency and capacity (G7)

- `maxConcurrentWorkflowRuns` (default 2, configurable) is a separate pool for runner jobs. Child job nodes use the existing `maxConcurrentJobs` (4).
- When the runner pool is full, the run stays `queued`. Launches are retried by:
  - the next reconcile trigger, and
  - the existing schedule ticker or `agav job tick`.

  The admission order is FIFO by `createdAt`.
- Inside a run: `policies.maxConcurrency` (S1/L3). If child job admission returns `capacity-exceeded`, the node stays pending and is retried with backoff. Never fail on capacity.
- Agent and prompt nodes run inside the runner process, so they don't consume job slots. A global cap on concurrent LLM calls per run equals `maxConcurrency`.

### A.10 Runner process details

- Entry point: a new private flag `--internal-workflow-runner <runId>`, added to `INTERNAL_FLAGS`. It exits before Ink renders, like the tick flag.
- The environment is minimal (`/job`). The runner loads config and credentials through `loadConfig()`, which decrypts stored credentials. A provider configured only through environment variables needs `envInherit` names in the runner spec, and those become part of the grant hash. That is an open question (see the plan).
- Logs: the runner's stdout/stderr are captured by `/job` (supervisor logs). The runner writes structured events to `events.jsonl` and human-readable progress to stdout.
- The runner holds `store.lock(runId)` for its whole life, which preserves today's single-writer invariant. While a runner is live, other sessions never take the run lock. They communicate only through create-once side files: `<runId>.cancel` (already the case today) and `<runId>/decisions/<decisionId>.decided.json` (A.6). `cancelRun` keeps its existing wait-for-lock behavior, which succeeds once the runner exits after SIGTERM.
- Notifications (B3): the runner posts `CompletionEventRecord`s for `waiting_approval`, `passed`, `failed`, `timed_out` and `cancelled` through the mailbox. App wiring (G2) displays them once across sessions.

### A.11 Schedules (B6, P1)

A workflow schedule is a `/job` `ScheduleRecord` whose launch template is the runner invocation with a fresh `runId` per occurrence. The schedule engine reserves occurrences, which gives dedup across instances. Consent is the workflow-run grant plus the schedule-create grant.

---

## Part B: Workflows TUI refactor

### B.1 Principles (from the existing screens)

- **Build it on `ResourceManager` + `ResourceAdapter`**, like JobsTUI/SkillsTUI. Don't add a bespoke Ink layout. This gives for free:
  - the header `Title · List/Inspect`
  - the search bar, paging and wheel scrolling
  - detail scrolling
  - the yellow status line
  - the dim key hints
  - the `y: Approve · n/ESC: Deny` confirmation via `prompt` / `promptDetails`
- Add a `"workflows"` `ResourceKind` and open the screen with `/workflows` (no args) or `showResourceTUI("workflows")`, the same way `/job` opens JobsTUI.
- `Tab` cycles sub-views (the JobsTUI pattern): **Workflows → Runs → Inbox**.
- Reserved ResourceManager keys must not be reused for custom actions: ↑↓ ←→ Enter/i s r n e t d b ESC. Custom action keys: `R` run, `x` cancel/stop, `a` approve, `D` deny, `l` logs, `g` revoke grant, `u` resume/relaunch, `v` validate, `y`/`n` only inside prompts.
- Colors: follow ResourceManager (cyan selection and header, yellow status and prompts, dim hints). Status glyphs are added to item titles because the manager renders titles as plain text: `●` running (shown as a text prefix), `◐` waiting, `✓` passed, `✗` failed, `⊘` cancelled, `⏱` timed out, `…` queued, `!` interrupted.

### B.2 Sub-views

**1. Workflows tab** (adapter `createWorkflowsAdapter`, source: discovery D1)

| Field | Content |
|---|---|
| title | `review-and-fix  [project]` (the origin is project or user; shadowed entries are marked) |
| description | `description`, node count, `last run ✓ 2h ago` |
| detail | inputs table (name/type/default), node list in topological order with types (agent nodes show agent and model; loops show maxIterations and their body), policies, grant status, the last 5 runs |
| actions | `R` Run: opens the input form via `fields` built from typed inputs (D3), launches in the background and switches to the Runs tab with the new run selected. `v` Validate. `g` Revoke background grant (when one is granted). |
| create/edit | `n`: scaffold a workflow from a template (agent-loop, review-then-write, job-then-notify) into `.agav/workflows/`. `e`: show the file path. Editing happens in `$EDITOR` through the existing `suspendTerminal`. No in-TUI graph editor (dropped). |

**2. Runs tab** (adapter `createWorkflowRunsAdapter`, source: `workflow-runs/*.json`, newest first)

| Field | Content |
|---|---|
| title | `✓ review-and-fix  a1b2c3d4` (short id, U4) |
| description | `passed · 3m12s · 7/7 nodes · started 10:42` or `◐ waiting approval: deploy` or `● running: fix (loop 2/5)` |
| detail | **Live run detail.** It refreshes every 1 s while the run is non-terminal, using a polling adapter (`get()` re-read plus a refresh timer in the TUI wrapper). See B.3. |
| actions | `x` Cancel (confirm text, `when` non-terminal). `a`/`D` Approve/Deny (when a pending decision exists). `l` Logs (detail = tail of `events.jsonl` plus node output). `R` Re-run with the same inputs. `u` Resume/Relaunch (when `interrupted` or `waiting` with decided gates). `d` Delete (`removable` when terminal). |
| filter | the search bar matches workflow name, status and id |

**3. Inbox tab** (adapter `createWorkflowInboxAdapter`, source: pending decision files across runs)

| Field | Content |
|---|---|
| title | `◐ deploy · review-and-fix a1b2c3d4` |
| description | kind (`approval` / `tool consent` / `job start` / `uncertain tool`) and age |
| detail | the full prompt, resolved tool input (scrollable, the same content as today's WorkflowToolConfirm), directory, sandbox backend, and the note "Approval grants no tool permissions" |
| actions | `a` Approve and `D` Deny. Both go through `promptDetails` confirmation, then the runner relaunches automatically. An optional note uses a single-field form. |
| empty state | `No pending decisions.` |
| badge | The Tab label shows a count: `Inbox (2)`. The App status bar shows `workflows: 1 running · 2 need approval` while any exist. Data comes from the mailbox or polling. |

### B.3 Live run detail layout (text rendered into `ResourceItem.detail`)

```
review-and-fix  a1b2c3d4-…   ● running   3m12s   attempt 1
inputs: issue=ENG-42   cwd: ~/proj
──────────────────────────────────────────────────────────
✓ fetch        tool  read_file              0.2s
✓ plan         agent planner · cheap/low    14.1s  → {"steps":3}
● fix          loop  2/5  until tests_pass
   ✓ iter 1    run_tests ✗ failed · fix_failures ✓   41s
   ● iter 2    run_tests ● running
◐ deploy       approval  waiting (a: approve, D: deny)
· notify       tool  write_file             pending
──────────────────────────────────────────────────────────
last events:
10:45:02 loop_iteration fix #2 started
10:45:03 node_started run_tests
```

- The tree is rendered from `run.json` (node and iteration checkpoints). The tail comes from `events.jsonl`, limited to the last N lines.
- Long outputs are truncated to one line. The full output is under `l` Logs.
- Errors are shown in a final line: `✗ fix: Unresolved workflow reference: nodes.plan.output.steps`.

### B.4 Replacing raw-JSON output (U3)

| Command | Today | New |
|---|---|---|
| `/workflows` (no args) | usage text | opens the Workflows TUI (usage remains available through `/workflows help`) |
| `/workflows run X` | blocks, then dumps run JSON | `Started review-and-fix (a1b2c3d4) in background · /workflows to watch` |
| `/workflows status <id>` | full JSON | a compact tree (B.3 without events) |
| `agav workflows status` | JSON | a human-readable tree. `--json` keeps today's full checkpoint output for scripts and tests. |
| Tool consent | modal `WorkflowToolConfirm` blocks the App | background mode puts consent in the Inbox. `WorkflowToolConfirm` is kept only for `--foreground`, restyled to the shared confirmation lines (`backgroundConfirmationLines` style, controls line `y: Approve · n/ESC: Deny`). |

### B.5 Component and file plan

- `source/resources/workflow-adapters.ts`: the three adapters, formatters (`formatRunTree`, `formatRunSummary`, status glyphs) and actions (`launchRun`, `cancelRunAction`, `decide`).
- `source/components/workflows-tui.tsx`: modeled on `jobs-tui.tsx`. It holds Tab state, a pending-confirmation promise, and a refresh interval while the visible item is live.
- `ResourceKind` gains `"workflows"`. In `app.tsx`, the `showResourceTUI` branch mounts `WorkflowsTUI`.
- `source/workflows/format.ts`: shared text rendering used by the TUI detail, `/workflows status` and CLI status.
- Possible ResourceManager change: an optional `refreshIntervalMs` prop, so the list and detail can re-fetch while a run is live. This is generic and also useful for JobsTUI. Otherwise the wrapper remounts with a `key` tick, which loses scroll position, so the prop is preferred.
