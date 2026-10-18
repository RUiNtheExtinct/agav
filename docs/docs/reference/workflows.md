# Foreground workflows (experimental)

Enable `backgroundJobsEnabled: true` **and** `workflowsEnabled: true` in `~/.agav/config.json`. `workflowsEnabled` is global-only and defaults off. No provider credentials are required.

```json
{
  "version": 1,
  "name": "review-copy",
  "nodes": [
    {"id": "A", "type": "tool", "tool": "read_file", "input": {"path": "README.md"}},
    {"id": "review", "type": "approval", "dependsOn": ["A"], "prompt": "Copy the reviewed content?"},
    {"id": "B", "type": "tool", "dependsOn": ["review"], "tool": "write_file", "input": {"path": "reviewed.txt", "content": "${nodes.A.output}"}}
  ]
}
```

```sh
agav workflows validate workflow.json
agav --auto-accept workflows run workflow.json
agav workflows status <full-run-uuid>
agav workflows approve <full-run-uuid> review
agav --auto-accept workflows resume <full-run-uuid>
# Alternatively:
agav workflows deny <full-run-uuid> review
agav workflows cancel <full-run-uuid>
```

Put global flags (`--cwd`, `--auto-accept`, `--deny-writes`, `--sandbox-required`) **before** `workflows`. `run` additionally accepts `--input-json '{"key":"value"}'`. Tool input strings may reference scalar `${inputs.key}` and `${nodes.ID.output}` values. Output is the existing tool's formatted text, not necessarily raw file contents or parsed JSON. `status` prints the full checkpoint, including the approval prompt, outputs, and errors. Run/status/resume/approve return exit 0 for success or waiting approval; failed/cancelled/timed-out states return 1. Denying or cancelling therefore returns 1 after recording the decision.

## Job nodes

A `job` node runs one literal shell command as a background job on the shared background-jobs coordinator and waits for it **in the foreground**: the workflow run does not return until the job is terminal or the run is cancelled. It is not detached.

```json
{
  "version": 1,
  "name": "build-then-save",
  "nodes": [
    {"id": "build", "type": "job", "command": "npm run build"},
    {"id": "save", "type": "tool", "dependsOn": ["build"], "tool": "write_file", "input": {"path": "build.log", "content": "${nodes.build.output}"}}
  ]
}
```

Downstream tool nodes can reference `${nodes.build.output}` because interpolation reads any passed node's stored `output` (read in `runtime.ts`; not separately exercised with a job node).

### Definition rules

A job node accepts only `id`, `type: "job"`, a non-empty `command` string and optional `dependsOn`. `validate` (and every checkpoint read) rejects:

- a missing or blank `command`;
- `${` anywhere in `command` (`Shell interpolation is not supported; use a literal command.`), so `${inputs.*}` and `${nodes.*.output}` cannot reach a job command;
- `tool`, `input` or `prompt` on a job node;
- `timeoutSeconds` on a job node (`Job nodes do not support timeoutSeconds`). The supervisor has no runtime-timeout support, so **there is no job timeout**;
- `command` on a tool or approval node.

Job nodes are not tool nodes. They do not use `WORKFLOW_TOOLS`, `allowedTools` or the workflow tool-consent prompt, and tool nodes still cannot call `run_background_job`.

### Execution

For a fresh node, in order:

1. If the host supplied no job support, the node is saved `failed` with `Job nodes unavailable: … no job was launched.` and nothing is started. Both the headless CLI and the interactive App supply it.
2. The checkpoint is saved with the node `running` and `job: {requestId}` **before** any start. `requestId` is deterministic: `wf-<runId>-<nodeId>-1`.
3. If the run is already aborted, the node becomes `cancelled` and nothing starts.
4. With `sandboxRequired` enabled the start is refused and the node fails (`Job nodes are refused while sandboxRequired is enabled: background jobs run outside the OS sandbox.`).
5. `coordinator.start` receives a `shell` invocation (`posix-sh`, or `cmd` on win32), the run's original canonical `cwd`, isolation backend `none`, and the host's `headless` flag. Normal coordinator `start` authorization applies (see below).
6. If `start` throws, the adapter looks the job up by `requestId`. A job found is adopted. A lookup error, or a coordinator with no lookup, gives an `uncertain:` failure. Only a successful lookup that finds nothing gives a plain `Job start failed: …`.
7. Right after admission the `jobId` and state are saved to `node.job`, then the node is observed.

**Observation** is a cancellation-aware poll loop (default 250 ms), not `coordinator.wait`: `wait` spins on uncertain states and aborting it does not stop a job. Three consecutive poll failures fail the node as `uncertain:` without retry.

| Job state | Node result |
| --- | --- |
| `completed`, exit code 0 | `passed`; `output` is the stdout tail |
| `completed` with exit code not 0 (or absent), or `failed` | `failed`; `error` holds the state, exit code and stderr tail |
| `interrupted` | `cancelled` |
| `unknown`, `recovery-required`, or any unrecognised state | `failed`, `uncertain: … outcome unknown, not retried` (fails closed) |
| job does not belong to the requestId | `failed`, `uncertain:` |

Output bounds: stdout is read as at most the last **64 KiB** (65536 bytes) and stored as `output`; `node.job.outputTruncated` records the coordinator's truncation flag. On failure only the last **8 KiB** of stderr is appended to `error`. If logs cannot be read, the job's terminal identity is kept and the node fails (`Output error: … stdout could not be read` or `(stderr unavailable: …)`). A log error never reruns the job.

### Checkpoint metadata and invariants

`node.job` holds `requestId` and, when known, `jobId`, `state`, `exitCode` and `outputTruncated`; `status` prints it. Reading a checkpoint fails closed unless: `job` appears only on job nodes; `requestId` equals `wf-<runId>-<nodeId>-1`; there are no extra keys; `state` is a known lifecycle state; a `running` or `passed` job node has `job`; and a job node is never `waiting_approval`.

### Resume and reattach

A `running` job node is the one kind of interrupted node that `resume` accepts; an interrupted tool node is still refused as uncertain. The job is **never started again**: the adapter polls the stored `jobId` (checking its `requestId`), falls back to lookup by `requestId`, and otherwise fails with `uncertain: cannot verify job … refusing to start a second workload.` Resuming with no job support throws and leaves the checkpoint `running`, so a later resume can still reattach. If a cancel marker exists at resume, the job is reattached first and then stopped as below.

### Cancellation and stop

When the run is aborted (Ctrl+C/Esc, SIGINT/SIGTERM, or a cancel marker) while a job is live, the adapter issues an **explicit authorized `stop`** and reports only what it observes. Aborting the poll alone never stops a job. `/workflows cancel` and `agav workflows cancel` use the same stop for a `running` job node while holding the run lock.

- The stop call uses a fresh, non-aborted signal (the run's aborted signal would be denied immediately), a 120 s deadline for the call, then up to 15 s of polling for a terminal state.
- A job that finished before the stop is reported with its real outcome (`completed`/`failed`), not as cancelled.
- Anything else is **cancellation incomplete**: coordinator unavailable, job not found or not matching the requestId, uncertain or non-live state, stop denied or thrown, deadline exceeded, still live after the settle wait, or poll failure. The node stays `running` with its job linkage and the reason in `error`.
- `executeRun` and `cancelRun` then throw `JobCancellationIncompleteError`: the run is left `running` (not terminal) and the lock is released, so `resume` or `cancel` can retry. The CLI prints the error and exits 1.
- When the stop is confirmed, an `interrupted` job makes the node `cancelled`. `cancelRun` marks the run `cancelled` only after every running job node has settled.
- `cancelRun` with no job support fails (`Cancellation requested, but node … has a running job … not claiming it stopped`) and changes nothing.

### Authorization by host

Job start/stop authorization is the background-jobs coordinator's (the same as `/job`). It is never a workflow approval node or a tool confirmation, and there are no workflow-run grants. The adapter passes `headlessApprovedActions: []`. Per `authorization/service.ts` (source-read): an existing exact-spec grant or `auto-accept` allows without a prompt, `deny-writes` blocks `start`, and `ask` mode prompts.

- **Headless CLI (`agav workflows run|resume|cancel`)**: jobs are passed `headless: true`, so the coordinator's headless gate **denies a fresh start**, even with `--auto-accept`, and the node fails with `Job start failed: …` carrying the denial reason. In practice job nodes are usable only from the interactive App. The adapter enforces the same gate for `stop`: a live job cannot be stopped from the CLI, so `cancel` reports cancellation incomplete, keeps the run recoverable and exits 1. Reattaching to or observing an existing job needs no grant.
- **Interactive App (`/workflows …`)**: start and stop each raise the exact-spec `/job` confirmation (`run_background_job`) through the App's confirmation queue. A generic “Always” is downgraded to a single yes, and an “Always” on another prompt does not resolve or auto-accept queued background prompts.
  - A **start** prompt is withdrawn (denied) when the run aborts, through the abort signal accepted by `ConfirmationQueue.enqueue`.
  - A **stop** prompt is deliberately not withdrawn when the run aborts, because the stop is the cancellation. It is denied by shutdown (`/exit`, external unmount) and by Esc/Ctrl+C pressed while it is pending, and after shutdown begins any new prompt is denied at once. A denied stop is reported as cancellation incomplete.
  - Source-read, not exercised against a real keypress: the stop prompt created by the first Esc/Ctrl+C appears after that keypress's denial sweep, so a second Esc/Ctrl+C is needed to deny it.

## Interactive foreground commands

Inside Agav, use `/workflows` (or `/help workflows`) for usage:

```text
/workflows validate workflow.json
/workflows run workflow.json --input-json {"key":"value"}
/workflows status <full-run-uuid>
/workflows approve <full-run-uuid> review
/workflows resume <full-run-uuid>
/workflows cancel <full-run-uuid>
```

Double-quote paths containing spaces. Unlike a shell, slash-command input JSON must **not** be wrapped in single quotes. JSON string whitespace is preserved. The same two feature gates are required. These commands use a restricted built-in registry, never loaded extensions, and do not invoke the process CLI.

Execution stays in the foreground. Normal prompts and unsafe slash commands queue until it settles; `/workflows status`, `/workflows cancel`, `/help` and `/exit` remain reachable. Ctrl+C or Esc aborts active workflow execution, including while tool consent is displayed. `/exit` aborts and waits for the executor to checkpoint settlement before exiting Ink. External unmount aborts and rejects pending consent; React cleanup cannot await settlement. A non-cooperative tool can delay completion/exit; cancellation intent is not proof that its effects stopped.

In ask mode, mutating tools without an existing matching grant show an App-owned, single-invocation Y/N prompt with the full resolved input in a scrollable viewport. Enter and “always” do not grant consent. This does not change permission mode or create grants for future nodes, workflows, background jobs or schedules. Workflow approval nodes still pause the run: inspect their prompt in status, record approve/deny explicitly, then resume separately. They never approve a tool.

## Permissions and execution

Supported node types are `tool`, `approval` and `job` (see [Job nodes](#job-nodes)). Tools available to `tool` nodes: `read_file`, `write_file`, `edit_file`, `run_command`, `grep_search`, `find_files`, `list_directory`, `overview`. The `run_background_job` tool, tests, agents, skills, network tools and arbitrary registry extensions are not available to tool nodes. Unknown definition/node fields and unsupported node types are rejected rather than silently ignored.

The CLI is headless: read-only tools run without confirmation; other tools require the existing `auto-accept` permission mode or a matching `allowedTools` grant. An explicit allowlist restricts mutating tools even under auto-accept. `deny-writes` blocks mutating tools. Destructive commands are refused. An approval node is a workflow decision, **not** a tool-permission grant. `run_command` uses Agav's existing shell sandbox and `sandboxRequired` policy; auto-accept is not sandboxing. Read/write tools retain their ordinary filesystem permissions, including absolute paths. Workflow checkpoint identifiers cannot contain paths.

Commands must be literal: `${...}` substitution anywhere inside `run_command` input is rejected, avoiding unquoted output-to-shell interpolation. Shell input `timeout_ms` retains its existing maximum of 120 seconds. Tool nodes may additionally specify `timeoutSeconds` (positive, at most 86400). Timeout/cancel aborts the node signal and **awaits tool settlement** before publishing the terminal result. Non-cooperative tools may delay shutdown indefinitely; this is not OS-level confinement or proof that escaped descendants are dead.

## Host integration (internal)

`executeRun(store, id, registry, config, signal?, host?, jobDeps?)` accepts an optional trusted `WorkflowExecutionHost` from `source/workflows/gated-tools.ts`:

- `confirmTool(name, resolvedInput, signal): Promise<boolean>` supplies single-invocation tool consent after allowlist/deny-writes/destructive checks.
- Optional `executeTool(registry, name, resolvedInput, context): Promise<ToolResult>` supplies trusted execution after that gate. Without it the restricted registry executes the tool. Neither callback comes from workflow JSON.
- `CommandContext.runWorkflow(task)` gives the slash handler an App-owned signal/host and holds foreground ownership until `task(signal, host)` settles.
- Shared `decideApproval(store, id, nodeId, approve, registry)` and `cancelRun(store, id, registry, signal?, jobDeps?)` implement durable decisions/cancellation without process CLI I/O.

Job nodes are driven by an optional trusted 7th argument, `jobDeps?: JobNodeDeps` (`source/workflows/job-node.ts`), also accepted by `cancelRun(store, id, registry, signal?, jobDeps?)`; it never comes from workflow JSON. `JobNodeDeps` holds:

- `getCoordinator()` (both hosts pass `getSharedCoordinator`), used for `start`, `poll`, `log`, `stop` and `findByRequestId`;
- `session`, a `SessionPolicySnapshot` (or a function returning one) with `headlessApprovedActions: []`, plus `confirmBackgroundAction` in the App;
- `sandboxRequired` and a required boolean `headless` (a start request sends `headless` unless it is explicitly `false`);
- optional `pollIntervalMs` (250), `stopDeadlineMs` (120000), `stopSettleMs` (15000) and `callDeadlineMs` (30000: a per-call wait bound for stop/observe calls; late results are ignored, but the underlying call is not cancelled).

Without `jobDeps`, a fresh job node fails as unavailable and a `running` job node cannot be reattached or stopped. `CommandContext.runWorkflow(task)` calls `task(signal, host, jobDeps)`; the App builds `jobDeps` per run. Job dispatch does not go through `executeTool` and does not widen the tool allowlist.

## Checkpoints and limits

Runs execute sequentially in dependency order, even when nodes are listed out of order. Independent branches may execute while another branch awaits approval. A denied/failed node stops the run. Approve records the decision only; invoke resume separately. Completed nodes never rerun. Resume requires the original canonical working directory and uses the stored definition, not a newly edited file. Job nodes follow the same rules but are reattached rather than rerun (see [Resume and reattach](#resume-and-reattach)).

Checkpoints are atomic, fsynced JSON snapshots under `~/.agav/workflow-runs/`. A per-run, identity-aware exclusive lock spans execution and shutdown. Status can read the last complete snapshot while a run is active. Cancel writes a separate durable intent, then waits to obtain the run lock; a live runner polls that intent. SIGINT/SIGTERM abort foreground execution and wait for settlement. Never use SIGKILL expecting a clean checkpoint: a leftover running *tool* node has an **uncertain outcome** and resume refuses to replay it (a running *job* node is reattached instead). After inspecting external effects, start a new run if appropriate. Corrupt checkpoints fail closed. Terminal runs cannot be retried or rewound.

This is a compatible subset of the planned workflow language (`version`, `name`, `description`, `nodes`, `dependsOn`, tool `input`, approval `prompt`, job `command`, tool-node `timeoutSeconds`). Foreground `job` nodes exist, but these are **not implemented**: detach/detached launcher, schedules, workflow-run grants, job timeouts, `${…}` interpolation in job commands, retries, parallelism/concurrency, and labels or mailbox/notifications for jobs. Also absent: YAML/discovery, input declarations/defaults, policies, conditions, output schemas, evals, metrics, attempt history and retention cleanup. Checkpoint storage is trusted local user state, not a hostile/multi-tenant filesystem boundary.
