# Workflow feature roadmap

This roadmap is the input to `docs/workflow-plan.md`. It is based on the code facts in `docs/workflow-plan-research.md`.

**Scale:** Value runs **H**igh, **M**edium or **L**ow. Effort runs **S** (under 2 days), **M** (about a week) or **L** (more than a week). Priority **P0** must be in the next release, **P1** comes next, **P2** later, and **Drop** means don't build it.

## 1. Keep (validated; build on these, don't rewrite)

| Feature | Keep as-is? | Notes |
|---|---|---|
| JSON definition + Ajv validation, `additionalProperties:false`, DAG cycle/unknown-dependency checks | Yes | Extend the schema per node type. Keep fail-closed validation. |
| `tool` node + `gatedToolExecute` permission gate | Yes | Still the only route to tools. In background mode, tool confirmations go to the approval inbox (see §4). |
| `approval` node | Keep, **upgrade** | Record a structured decision (`decision`, `decidedAt`, `decidedBy`, `note`). Approving queues an automatic resume. |
| `job` node (child background job, idempotent requestId, reattach, explicit stop, fail-closed uncertain states) | Yes | The reattach logic becomes the model for every node that runs out of process. |
| Atomic checkpoints, run lock, durable cancel marker, cwd pinning, corrupt-checkpoint refusal | Yes | The single `run.json` is split into run plus per-node files only if size requires it (P2). |
| Never auto-replay an interrupted *tool* node | Yes | Deliberate safety divergence from the design. Keep it, and offer an explicit "retry node" action (§2, R5). |
| Two feature gates (`backgroundJobsEnabled` + `workflowsEnabled`) | Yes | Background execution needs the background-jobs subsystem anyway. |

## 2. New and changed features, ranked

### Core: agent and loop (P0)

| ID | Feature | Value | Effort | Priority | Scope / acceptance |
|---|---|---|---|---|---|
| A1 | **`agent` node** | H | M | P0 | `agent: <name>` and `task: <template>`. Resolution uses `loadAgents(cwd)`. Native agents go to `executeNativeAgent`, A2A agents to `executeA2AAgent`, behind one `AgentInvoker` interface that can be injected for tests. Per-node `model`, `effort`, `maxIterations` and `timeoutSeconds` override the agent's own config. Node context is isolated: the agent receives only the interpolated task and never the conversation. Agent sub-tool confirmations go to the host's `confirmTool`, or to the approval inbox when running in the background. |
| A2 | **`prompt` node** (agent loop with no named agent) | H | S | P0 | Reuses the same invoker with a synthetic agent: `prompt`, plus `allowedTools` narrowed to a subset of `WORKFLOW_TOOLS`. Covers summarize and transform steps cheaply. |
| A3 | **Structured outputs** | H | M | P0 | Agent and prompt nodes may declare `output: "text" \| "json"` and an `outputSchema`, validated with Ajv. A schema failure fails the node. `NodeCheckpoint.output` widens to `unknown` and is size-capped; anything over the cap goes to an artifact file. This prerequisite is what makes loops useful. |
| A4 | **Path interpolation** | H | S | P0 | `${nodes.id.output.a.b}`, `${inputs.x}`, `${loop.index}`, `${loop.item}`, `${loop.prev.output}`. Objects are JSON-encoded when placed inside a string. Templates feeding shell input stay forbidden, as now. |
| L1 | **`loop` node, sequential** | H | M | P0 | A `body` holds a sub-DAG of nodes. `maxIterations` is required, with a hard cap of 50. The loop exits on `until` (an expression, see C1) or on `stopWhen: { node, status }`, which is the design's form. Each iteration is checkpointed separately: `nodes[loopId].iterations[i].nodes[...]`. A loop resumed mid-iteration reuses the checkpoint rules: passed body nodes are skipped, and an interrupted tool is uncertain. Exhausting the loop gives `failed` (`onExhausted: fail`) or `passed` (`onExhausted: continue`). |
| L2 | **Per-iteration context** | H | S | P0 | Iteration *i* can see `${loop.prev.<node>.output}` and an accumulated `${loop.history}`, capped to the last N summaries. This is how "fix until tests pass" works without passing the whole transcript along. |
| L3 | **`forEach` fan-out loop** | M | M | P1 | `items: ${nodes.x.output.list}`, with `maxConcurrency` (default 1). It depends on the parallel scheduler (S1). An item cap is required, default 100. |

### Control flow and reliability

| ID | Feature | Value | Effort | Priority | Scope / acceptance |
|---|---|---|---|---|---|
| C1 | **Conditions (`when:`)** on any node | H | S | P0 | A small, safe expression language. **No `eval`.** It supports comparisons, `&&`, `\|\|`, `!`, `in`, and access to inputs and node output and status. A false condition gives `skipped`, which adds that status. Downstream `dependsOn` treats `skipped` as satisfied only with `allowSkipped: true`. Shared by `loop.until`. |
| R1 | **Retries per node** | H | S | P0 | `retry: { max, backoffSeconds }` covers agent, prompt and job nodes, plus tool nodes that are read-only (`SAFE` set). A retried job uses a new requestId attempt `-<n>`, which removes the hard-coded `-1`. Mutating tools are not retried automatically. |
| R2 | **Timeouts everywhere** | H | M | P0 | Node `timeoutSeconds` covers agent and prompt nodes (abort signal) and job nodes (currently rejected; needs gap G3, supervisor `maxRuntimeMs`, or a runtime-driven explicit stop when it fires). Run-level `policies.maxRuntimeSeconds` gives a run status of `timed_out`. |
| R3 | **Run policies block** | M | S | P0 | `policies: { maxRuntimeSeconds, maxConcurrency, stopOnFailure, permissionMode }`. Resolution order: node, then workflow, then session. `permissionMode` can only *narrow* the session's mode, never widen it. |
| S1 | **Parallel DAG scheduling** | M | M | P1 | Independent ready nodes run concurrently up to `maxConcurrency`. This needs a "multiple running nodes" invariant in `store.read` and per-node locking of saves (one writer, serialized through the runner). Approvals and confirmations still serialize. |
| R4 | `continueOnError` per node | M | S | P1 | A failed node doesn't stop the run. Dependents see `status: failed` and can branch with `when`. |
| R5 | **Retry, skip or rewind a node** (operator actions) | H | S | P1 | Recovery is explicit: for an uncertain or failed node, the operator chooses retry or mark-skipped, then resume. This replaces "start a new run". |

### Inputs, outputs, discovery

| ID | Feature | Value | Effort | Priority | Notes |
|---|---|---|---|---|---|
| D1 | **Workflow discovery by name** | H | S | P0 | Searches `.agav/workflows/*.{json,yaml}` (project) and `~/.agav/workflows/` (user), with project shadowing user. The TUI and `run <name>` need this. |
| D2 | **YAML authoring** | M | S | P0 | Uses the existing `yaml` dependency and is normalized to JSON before validation. The hash is taken over the normalized JSON. |
| D3 | **Typed `inputs` with defaults** | H | S | P0 | `inputs: { name: { type, default, required, description } }`, validated at run time. The TUI renders an input form from it, reusing the ResourceManager create view. |
| D4 | Workflow-level `outputs` | M | S | P1 | `outputs: { report: ${nodes.final.output} }`, stored on the run. Shown in run detail and in completion notifications. |
| D5 | Artifacts directory per run | M | S | P1 | `workflow-runs/<id>/artifacts/`. Holds oversized outputs and agent transcripts (as logs). |

### Background, scheduling, operations

Detailed in step 3. Ranked here for completeness.

| ID | Feature | Value | Effort | Priority | Notes |
|---|---|---|---|---|---|
| B1 | **Detached run (runner job)**: a run survives when the CLI or TUI exits | H | L | P0 | Required by the user. The run becomes a supervised background job. |
| B2 | **Approval and confirmation inbox**: decide from any session; approving auto-resumes | H | M | P0 | Without it, detached runs dead-end at the first gate. |
| B3 | **Completion and attention notifications** (via mailbox) | H | M | P0 | "Run X waiting for approval" / "Run X passed". |
| B4 | **Run history, list, filter and prune** | H | S | P0 | Feeds the TUI. Retention follows `completedLogRetentionDays`. That setting is only declared in `background-jobs/types.ts` today and nothing enforces it (gap G11), so pruning has to be built. |
| B5 | Trace events and per-node logs | M | M | P1 | An append-only `events.jsonl` per run, which drives live progress in the TUI. |
| B6 | **Schedules** (cron to workflow) via the `/job` schedule engine | M | M | P1 | Reuses `ScheduleRecord`. Needs the workflow-run grant (G1). |
| B7 | Token and cost budget per run | M | S | P2 | Usage comes from agent events. Exceeding the budget stops the run with `failed: budget`. |

### UX

Detailed in step 3.

| ID | Feature | Value | Effort | Priority |
|---|---|---|---|---|
| U1 | **Workflows TUI** on ResourceManager (Workflows / Runs / Inbox tabs) | H | M | P0 |
| U2 | Live run detail (node tree, loop iteration progress, logs) | H | M | P0 |
| U3 | Replace raw-JSON transcript output with concise summaries and an `--json` flag in the CLI | H | S | P0 |
| U4 | Short run ids (prefix matching, like git) | M | S | P0 |

### Testing and authoring

| ID | Feature | Value | Effort | Priority | Notes |
|---|---|---|---|---|---|
| T1 | **Unit and integration test suite** in `source/__tests__/workflows.*.test.ts` | H | M | P0 | None exists today. Covers validation, resume, approval, loop caps, the agent invoker mock, and runner reattach. |
| T2 | `dry-run` (validate, plan order, show resolved templates; skip mutating, agent and job nodes) | M | S | P1 | |
| T3 | Eval fixtures with node mocks | L | M | P2 | Keep the design's file layout compatible. |

## 3. Drop or defer

| Item | Decision | Reason |
|---|---|---|
| `reduce` node type | **Drop** | It's a `prompt` node with several `dependsOn`. A separate type adds schema surface for no new capability. |
| `parallel` node type (explicit children) | **Drop** | Covered by DAG parallelism (S1) and `forEach` (L3). |
| `test` node with assertion types | **Defer (P2)** | Mostly covered by `run_command` tool nodes plus `when` and `outputSchema`. Revisit if authors ask. |
| `skill` node | **Defer (P1-late)** | Low effort once the agent invoker exists (skills executor), but not core. |
| Per-node `provider` switching / dynamic routing | **Drop for now** | Parse-and-store only if cheap. Routing is a separate PR, as the design says. |
| Arbitrary graph cycles | **Drop** | Bounded `loop` only. |
| Interpolation into shell commands (`job.command`, `run_command`) | **Keep forbidden** | Revisit only with a `${shell:...}` quoting form (P2). |
| Visual graph editor / cloud control plane | **Drop** | Out of scope. |
| Auto-replay of interrupted mutating tool nodes | **Drop** | Replaced by operator retry (R5). |

## 4. Cross-cutting decisions that the ranking depends on

1. **Agent and loop require structured state.** A3 and A4 come before L1/L2. Loop exit conditions are written against JSON output.
2. **Background mode forces non-interactive consent.** Any confirmation that would have been an interactive prompt (tool consent, agent sub-tool consent, job start) becomes a **pending decision** in the run's inbox (B2). The node shows `waiting_approval` with `reason: tool_consent`, and the runner either parks or keeps executing independent branches. Workflow approvals still never grant tool permission. A user who wants unattended mutating runs grants a scoped **workflow-run grant** (G1), bound to the definition hash plus the node/tool list.
3. **Loop bodies reuse the node executor recursively.** The body is a sub-DAG. A body may contain `agent`, `prompt`, `tool`, `job`, `approval` and `when` nodes. Nested loops are allowed up to depth 2, and the total node executions per run are capped (default 500).
4. **Status model additions:** `skipped` (node) and `paused` (run, operator detach without cancel). The run status gets its own type instead of reusing `NodeStatus`.

## 5. Priority summary

- **P0 (next release):** A1 agent, A2 prompt, A3 structured outputs, A4 path interpolation, L1 loop, L2 iteration context, C1 conditions, R1 retries, R2 timeouts, R3 policies, D1 discovery, D2 YAML, D3 typed inputs, B1 detached runner, B2 inbox, B3 notifications, B4 run history, U1–U4 TUI and output, T1 tests.
- **P1:** L3 forEach, S1 parallel scheduling, R4 continueOnError, R5 operator retry/skip, D4 outputs, D5 artifacts, B5 events/logs, B6 schedules, T2 dry-run, skill node.
- **P2:** B7 budgets, T3 evals, test-assertion node, `${shell:}` quoting, split per-node checkpoint files.
