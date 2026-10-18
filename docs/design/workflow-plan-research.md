# Workflow plan research notes

Notes from step 1, used as input for `docs/workflow-plan.md`. They come from reading the code in `/home/pranav/cli/agav/source`.

## Current engine (`source/workflows/`)

| File | Role | What matters for the plan |
|---|---|---|
| `definition.ts` | JSON schema and validation, via Ajv | Node types are only `tool`, `approval` and `job`. `additionalProperties:false` everywhere. The tool allowlist is `WORKFLOW_TOOLS`. The DAG cycle check is a DFS. |
| `runtime.ts` | `createRun`, `executeRun` | Execution is sequential, one ready node at a time. The run lock covers the whole execution. The cancel marker is polled every 100 ms. Interpolation only handles scalar `${inputs.x}` and `${nodes.id.output}`. Tool nodes are never replayed. A running job node is reattached. |
| `store.ts` | `WorkflowStore` | One `~/.agav/workflow-runs/<uuid>.json` per run, plus `.cancel` and `locks/`. Writes are atomic and fsynced. `read()` checks a long list of invariants. Run status reuses `NodeStatus`. `jobRequestId` is fixed to attempt `-1`. |
| `control.ts` | `decideApproval`, `cancelRun` | Approve and deny only record the decision; resume is a separate step. Cancel writes intent, waits for the lock, and stops job nodes. |
| `gated-tools.ts` | `gatedToolExecute` | Checks deny-writes, `allowedTools`, auto-accept, and destructive commands. Asks for confirmation through `host.confirmTool`. With no host it fails headless. |
| `job-node.ts` | Adapter to the background-jobs coordinator | Starts with an idempotent `requestId`, then a poll loop, explicit stop, and fail-closed handling of uncertain states. Isolation is `none`. |

## Why a run dies with the terminal

- `agav workflows run|resume` (`cli/workflows-cli.ts`) and `/workflows run` (`commands/workflows.ts` → `app.tsx` `runWorkflow`) both call `executeRun` **in the current process**. That process holds the run lock, the AbortController and the SIGINT/SIGTERM handlers.
- When the process exits, nothing keeps running. A `running` tool node is then "uncertain" and is refused on resume. Only `job` nodes survive, and only because the background-jobs supervisor owns them.
- Approval nodes park the run as `waiting_approval`. Someone then has to run `resume` by hand.
- The App holds foreground ownership (`workflowAbortRef`) and queues other prompts until the workflow settles. That is the "CLI must stay open" experience.

## Background-jobs subsystem (reuse candidate)

- `coordinator.start()` accepts `invocation: { mode: "direct", executable, args }`. That means it can launch `node <cli> workflows __run --run-id <id>` as a supervised job.
- It already provides: a supervisor per job, process-group stop, liveness with PID-reuse protection, segmented stdout/stderr logs, a mailbox with completion events, a schedule engine (cron, timezone, occurrence reservation), host daemon and `agav job tick`, and grants with headless gating (`headlessApprovedActions`).
- `findByRequestId` exists, so a runner job with `requestId = wf-run-<runId>` can be deduplicated and reattached.
- Known gaps from earlier audits (`docs/workflows-on-job-implementation.md` §4):
  - G1: headless consent, a "workflow-run" grant.
  - G2: mailbox delivery into the UI.
  - G3: per-job timeout.
  - G7: capacity pool sharing. A runner occupies one slot and its children compete for the rest.
  - G12: startup reconcile.

## Agent execution available for an `agent` node

- `agents/loader.ts`: `loadAgents(cwd)` and `loadAgent(dir, origin)`.
- `agents/executor.ts`: `executeNativeAgent(agent, task, { provider, config, signal, confirmTool, permissionMode, iterationsBudget, onProgressUpdate })` returns `Promise<string>`. It already resolves per-agent model and effort (`config.json` > manifest > session) and starts per-agent MCP servers lazily. `executeA2AAgent(agent, task)` covers external agents.
- So an `agent` node can wrap both behind one abstraction, as the design requires. A background runner needs a provider in the runner process; credentials come from `loadConfig()`.

## TUI conventions (agents / skills / jobs / memory)

- These screens are built on `components/resource-manager.tsx` (`ResourceManager`) plus a `ResourceAdapter` (`resources/types.ts`). The adapter provides `title`, `list`, `get`, and optionally `create`, `update`, `remove`, `setEnabled`, `notice`, and remove-wording overrides.
- `ResourceItem` fields: `id`, `title`, `description`, `detail`, `searchText`, `enabled`, `removable`, `stoppable`, `values`.
- Views are list, detail, create, edit and delete. The list has search and filtering (`filterResources`) and paging (`resourcePage`).
- `ResourceAction` fields: `key`, `label`, `when(item)`, `inDetail`, `confirm` text, and `run` returning a string or `{detail}`.
- `Tab` switches the sub-view. Examples: `SkillsTUI` Installed ⇄ Marketplace, and `JobsTUI` Jobs ⇄ Schedules.
- Confirmation follows `JobsTUI`: a parent-held pending promise, `prompt` / `promptDetails` with the controls line `y: Approve · n/ESC: Deny`, and the manager stays busy until the user answers.
- Screens are opened via `showResourceTUI(kind)` or a dedicated `show*TUI` in `app.tsx`. `ResourceKind` currently lists agents, skills, memory, schedule, history, search-history and jobs. There is **no `workflows` kind**.
- `agents-tui.tsx` (552 lines) is the richest example. It has list, inspect, create, search and marketplace sub-screens.

## Current workflow UX problems

- `/workflows run|status` prints the **raw run JSON** into the transcript (`commands/workflows.ts:48,65`).
- The only workflow UI is `WorkflowToolConfirm`, a yellow Y/N box. It doesn't use `ResourceManager` or the shared confirmation styling.
- There's no list of workflows or runs, no live progress, and no node detail or log view. Users have to copy full UUIDs by hand.
- Approvals have no UI. Users must type `/workflows approve <uuid> <node>` and then `/workflows resume <uuid>`.
- A foreground run blocks the input prompt (queued requests) until it settles.
