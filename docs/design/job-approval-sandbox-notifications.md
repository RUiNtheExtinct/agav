# Design: approval modes, sandboxing and notifications for background workflows and chains

**Status:** draft design (step 3).

**Builds on:**
- `docs/design/job-dependency-model.md`: chains, the evaluator, ticker hosts.

**Decisions taken from the user:**
1. **Safe mode:** if a step needs approval, the workflow stops at that point. The user opens Agav, sees the status, and approves. Windows needs its own handling.
2. **Auto mode:** every tool call is auto-approved. Strong sandboxing guarantees that nothing outside the working folder is affected.
3. **Sounds:** a sound plays when a workflow needs approval and when it completes.
4. **Upgrades:** well documented (covered in step 4).

**Terminology:**
- **Unattended run:** any workflow run or chain run that executes while no TUI session is attached. This covers detached runs, schedules and chain edges.
- **Working folder (WF):** the canonicalized (realpath) `cwd` approved for the run.

---

## 1. Principles

1. **The mode is chosen at consent time and bound to the grant.** `approvalMode` is part of the hashed terms of the `workflow-run` and `chain-create` grants. Switching a workflow from safe to auto is a material change and needs fresh, interactive consent. A project config file can never choose auto mode. This already holds today: `permissionMode` is in `PROJECT_CONFIG_DENY`.
2. **Fail closed.** If the sandbox auto mode requires is unavailable, auto-mode runs **refuse to start**. They don't fall back to unsandboxed, and they don't silently switch to safe mode. This matches the `/job` "isolation is never silently downgraded" invariant.
3. **Never block on a human in-process.** An unattended run never waits for a prompt that has no one to answer it. It checkpoints, records a durable *pending approval*, notifies, and exits or stops. Resuming starts again from the checkpoint.
4. **Notifications never affect outcomes.** Sound and desktop delivery are best effort. A run's result never depends on whether a sound played. This is `/job` invariant 11.
5. **Interactive runs keep today's behaviour.** A workflow started in the TUI without `--detach` still uses the normal permission prompts. Safe and auto modes apply only to unattended runs.

---

## 2. Mode definitions

| | **Safe mode** (default) | **Auto mode** (opt-in) |
|---|---|---|
| Tool calls that need confirmation today | Stop the run and create a pending approval | Auto-approved |
| Approval nodes (`type: approval`) | Stop the run and create a pending approval | **Still stop.** An explicit human checkpoint in the definition is honoured in every mode |
| Read-only tools (`SAFE_TOOLS` in `agent/loop.ts:94`) | Run | Run |
| Destructive commands (`isDestructiveCommand`) | Stop the run and create a pending approval | **Refused** (node fails) unless the workflow lists the pattern in `policies.allowDestructive`, which is part of the grant hash |
| Writes outside the WF | Stop the run and create a pending approval | **Refused** by the path guard and blocked by the OS sandbox |
| Network | Allowed (the same as interactive) | **Denied by default.** `policies.network: "allow"` is opt-in and part of the grant hash. Model API traffic always goes through Agav's own process (§4.6) |
| Sandbox required | No (the same as today) | **Yes.** A tier-1 backend (§4.4) or refuse |
| Child `/job`s (long shell nodes) | Need an existing per-spec grant, or stop and create a pending approval | Started sandboxed (isolation ≠ `none`) under the chain or workflow grant |
| Where it's allowed | All platforms | Linux (bubblewrap), macOS (seatbelt), and any OS with Docker. **Windows only with Docker or WSL2** (§4.4) |

A **third, implicit mode**, `deny-writes`, still applies. If the user's global `permissionMode` is `deny-writes`, or the global kill switch `backgroundAutomation: "paused"` is set (`job-dependency-model.md` §6.2), unattended dispatch doesn't happen at all.

---

## 3. Safe mode: pause, pending approval, approve later

### 3.1 What "needs approval" means

Inside an unattended run, an approval is needed in four situations:
- **(a)** A tool call for which `agent/loop.ts` would set `needsConfirm`. This covers non-safe tools that aren't allowed in `ask` mode, and destructive commands.
- **(b)** A workflow `approval` node.
- **(c)** Crash-retry approval from #412 (`requireApprovalBeforeRetry`).
- **(d)** A child `/job` whose exact spec has no `start` grant.

Today, cases (a) and (d) are refused when headless (`needsConfirm && !confirmTool`, line 502). Safe mode replaces that refusal with **suspend**.

### 3.2 The pending approval record

The record is owned by a new module, `source/background-jobs/approvals/`, with a grant-store-style directory. It is not added to `Repositories`.

```ts
export interface PendingApprovalRecord {
  schemaVersion: 1;
  approvalId: string;                       // uuid
  /** What is suspended. Exactly one of these. */
  subject:
    | { kind: "workflow-node"; runId: string; nodeId: string; attempt: number }
    | { kind: "chain-step"; chainRunId: string; stepKey: string };
  reason: "tool-call" | "approval-node" | "retry-after-crash" | "job-spec";
  /** Exactly what will run if approved: tool name + canonical input, or LaunchSpec, or approval prompt text. */
  request: {
    toolName?: string;
    toolInput?: unknown;                    // canonical JSON; secrets redacted for display only
    launchSpec?: Omit<LaunchSpec, "requestId" | "createdAt">;
    prompt?: string;
  };
  /** Hash of `request`; approval binds to it (same pattern as specHash). */
  requestHash: string;
  workingFolder: string;
  createdAt: string;
  expiresAt?: string;                       // policy.approvalTimeoutSeconds, optional
  status: "pending" | "approved" | "denied" | "expired" | "superseded";
  decidedAt?: string;
  decidedBy?: { clientId: string; via: "tui" | "cli" };
  /** If approved with scope "run": later identical requests in this run auto-approve. */
  scope?: "once" | "run";
}
```

- **Storage:** `~/.agav/background-jobs/approvals/<approvalId>.json`. Writes use `writeAtomic`. Decisions are made under `withApprovalLock(approvalId)`, and only a `pending` record can change status.
- **Idempotency:** `approvalId = sha256(subject | requestHash)`, created with exclusive create. If a run is resumed and hits the same request, it finds the existing record instead of creating a duplicate.

### 3.3 Flow

```
unattended runtime hits (a)-(d)
  1. checkpoint node as waiting_approval  (workflow store, #411)        | chain step → status "waiting-approval"
  2. create PendingApprovalRecord (exclusive)                            |
  3. post mailbox event { kind: "approval-needed", approvalId }          → sound + desktop notification (§5)
  4. runtime decides:
       - other ready branches with no dependency on this node? continue them (parallel progress)
       - nothing else runnable? checkpoint run as "waiting_approval", exit runner job with code 3
  ─────────────── user opens agav (any time later) ───────────────
  5. TUI startup: mailbox shows "N workflows waiting for approval"; /workflows pending, Jobs TUI "Approvals" tab
  6. user inspects exact request (tool + input / command + cwd / prompt), approves (once | run) or denies
  7. decision written under lock; requestHash re-checked against current definition (stale → "superseded")
  8. resume:
       - workflow: next ticker tick sees approved record for a waiting run → coordinator.start(runner job, same --run-id) → runtime resumes from checkpoint, consumes the decision
       - chain step: evaluator sees approved → dispatches step
     deny → node fails with error "denied by user"; normal failure edges / stopOnFailure apply
```

**Details:**
- **Exit code 3 = waiting for approval.** `job-dependency-model.md` §10, item 2, left this open; it is now settled. The runner exits 0 when the run passed, 1 when it failed or was cancelled, and 3 when it is waiting for approval. A chain step whose job exits 3 becomes `waiting-approval`, which fires no edges. `/job` still records the job as `failed` (exit ≠ 0), because `/job` stays unaware of workflows. The chain evaluator and the workflow host read the exit code together with `run.json`.
- **The run resumes in a new runner job.** Its `requestId` is `wf-<runId>-r<N>`, where N is the resume count. The workflow `runId` stays the same. This keeps `/job`'s one-request-one-job rule.
- **Decisions apply only to the exact request.** If the definition changed since the request was recorded, the recomputed request hash won't match and the record becomes `superseded`. A new approval request is then created on resume.
- **Scope "run"** approves later identical `(toolName, canonical input)` or `launchSpec` requests in the same run without asking again. It's stored as a run-scoped allow-list in `run.json`. It is never global and never persists past the run.
- **Expiry:** if `policies.approvalTimeoutSeconds` is set, an expired request becomes `expired`, and the node fails (or is skipped, per `policies.onApprovalTimeout: "fail" | "skip"`). By default requests never expire.
- **Who can decide:** only an interactive session or the CLI with a TTY (`agav workflows approve <approvalId>`). A decision never comes from the LLM: the `run_workflow` tool, if added later, has no approve action. This follows the existing rule that `confirmBackgroundAction` is "trusted interactive host callback; never populated from tool arguments".

### 3.4 Windows handling for safe mode

Windows weaknesses that matter here:
- **No graceful stop:** stopping a job is TerminateProcess.
- **Stopped shell jobs end `unknown`.**
- **No proper Job Object ownership.**

How safe mode avoids or handles them:

| Concern | Handling |
|---|---|
| **Suspending must not depend on being signalled.** | Suspension is **cooperative and initiated by the runtime itself**: checkpoint, then exit with code 3. Nothing has to send a signal, so the lack of graceful stop on Windows doesn't matter for the safe-mode pause. |
| Child `/job`s still running when the runner suspends | The runner doesn't stop them. It suspends only when nothing else can run, and child jobs are awaited before that. If a child job is running on an independent branch, the runner keeps waiting on it and doesn't exit until that branch is done or itself needs approval. |
| A user cancels while waiting for approval | No process is alive (the runner already exited with code 3), so cancelling only updates records: pending approvals are marked `superseded` and the run `cancelled`. No TerminateProcess, so no `unknown`. |
| A user cancels a run that's still running on Windows | The runner job is stopped with TerminateProcess and ends `unknown`. To avoid that, cancellation on Windows first writes `run.requestedStop = "cancel"` and gives the runner a 10 s grace period to notice it (the runtime polls `run.json` every 2 s while executing) and exit on its own. Only after that does it fall back to `coordinator.stop`. Applies to all OSes, but matters most on Windows. |
| Sound and notification delivery | PowerShell toast via `BurntToast` if present, then the WinRT `ToastNotificationManager` via `powershell -NoProfile`, then `[console]::beep` / `SystemSounds` as a sound-only fallback (§5.3). |
| Ticker host without a TUI | Task Scheduler entry created by `agav job tick --install` (step 4): run whether or not the user is logged on = **off**, so it runs in the user session and toasts and sounds work. "Run only when user is logged on" is the default. |
| Path canonicalization for the WF | `adapter.canonicalizePath` already resolves junctions. Approval records store the canonical path. Display shows the original. |

**Result:** safe mode works on Windows without native helpers. The one Windows-specific limitation is that stopping a running node hard-kills it. That is documented, and the node is marked `unknown`. Resuming then requires a manual resolve (`/job chain resolve`), or a retry if the node has `retrySafe`.

---

## 4. Auto mode: auto-approve inside a strong sandbox

### 4.1 Threat model and guarantee

**Guarantee:** an auto-mode run cannot create, modify or delete anything outside the WF and a private temp dir. It cannot read the user's credential stores, and it cannot reach the network unless the user explicitly allowed network access at consent time. This holds even if the model is fully adversarial, for example through prompt injection from repo contents.

**Not guaranteed:**
- Anything inside the WF may be destroyed. That's the trade the user is making. Mitigation: a mandatory git snapshot before the run (§4.7).
- CPU, memory and disk exhaustion inside the WF. Best-effort limits are in §4.5.
- Leaking data the model already received through the model API itself.

Because auto mode must hold against an adversarial model, **every way the run can affect the host must go through a confinement layer**. Today that's not true (findings §3). Auto mode therefore depends on six enforcement layers:

```
L1  Policy layer (in-process)     : auto-approve, but deny-list (destructive, out-of-WF paths, disallowed tools)
L2  Path guard (in-process)       : every file tool resolves realpath and must be inside WF (or private tmp)
L3  Process sandbox (OS)          : every spawned process (run_command, child /jobs, test runner, gh, hooks, MCP, LSP) runs inside the OS sandbox
L4  Runner sandbox (OS)           : the whole workflow runner process runs inside the same sandbox, so even in-process tools are confined
L5  Network policy                : network namespace / seatbelt deny / docker --network=none; model traffic via broker (§4.6)
L6  Env & secrets                 : minimal env, no credential dirs readable, provider credentials via broker only
```

**L4 is what makes this strong.** If the whole runner job runs inside the sandbox, in-process tools such as `write_file` and `edit_file`, and anything that would otherwise skip L3, are still confined by the OS. L1 and L2 then give early, readable errors instead of `EPERM`, and give protection in depth if the OS sandbox is misconfigured.

### 4.2 L1: the policy layer

There's a new `permissionMode` value **`"sandboxed-auto"`**. It is only used internally by unattended auto-mode runners and never offered as an interactive choice.

In `agent/loop.ts`, `sandboxed-auto` behaves like `auto-accept` except for these rules:
1. `isDestructive` calls are refused unless they match `policies.allowDestructive`. Refused means the tool returns an error and the model can adapt; the node does not fail outright.
2. Tools not in the **auto-mode allow-list** are refused. Default allow-list:
   - `SAFE_TOOLS`
   - `edit_file`, `write_file`, `edit_notebook`
   - `run_command`, `run_tests`
   - `subagent` (inherits the same mode)
   - `run_background_job` (start/poll/log/wait/stop only, sandboxed)

   Default deny: `fetch_url` and `web_search` unless network is allowed, `github`, MCP tools unless listed in `policies.allowedTools`, and `process`.
3. **Workflow `tool` nodes** go through the same gate (`gatedToolExecute`, from `workflows-on-job-implementation.md` §5.2). That fixes the #411 bypass.
4. `sandboxed-auto` is **refused at startup** unless the process detects it is running inside an L4 sandbox. The runner sets `AGAV_SANDBOX_ATTESTATION=<backend>:<nonce>` and the supervisor verifies it against the job's `isolation`. That stops a misconfigured launch from running auto mode unsandboxed.

### 4.3 L2: the path guard (also fixes a general bug)

There's a new `source/utils/workspace-guard.ts`:

```ts
export interface WorkspaceGuard {
  /** Resolve `p` against cwd, realpath the longest existing prefix, reject if outside roots. */
  checkWrite(p: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
  checkRead(p: string): Promise<...>;   // auto mode: WF + allow-listed system read roots; credential dirs always denied
}
export function createWorkspaceGuard(roots: { write: string[]; read?: string[]; denyRead: string[] }): WorkspaceGuard;
```

**Rules:**
- Compute `realpath` on the **longest existing prefix**, then append the remaining segments. This handles new files under symlinked folders and `..`.
- On Windows, normalize case and resolve junctions with `fs.realpath.native`.
- Reject UNC and device paths (`\\?\`, `\\.\`), NTFS alternate data streams (`file.txt:stream`) and 8.3 short names that resolve outside.
- Write roots in auto mode are `[WF, privateTmp]`. Read deny-list: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, the Agav config dir, and the `/job` storage root.
- **Time-of-check/time-of-use:** a symlink swapped in after the check is still possible in-process. L4 closes this gap, because the OS sandbox enforces at syscall time.

**Applied to:** `file-write.ts:30`, `file-edit.ts:36`, `notebook.ts:33,80` and `file-read.ts:180`, all of which currently do bare `resolve(String(input.path))`. In normal interactive modes the guard only *warns* in the confirmation prompt ("writes outside the project"). In `sandboxed-auto` it *refuses*. This is a separate, independently valuable fix and ships in phase 0 of step 4.

### 4.4 L3 and L4: per-OS sandbox mechanisms

There's a new shared module `source/sandbox/profiles.ts` that both `utils/sandbox.ts` and background jobs use, so there's one definition of each profile:

```ts
export interface ConfinementPolicy {
  writeRoots: string[];          // [WF, privateTmp]
  readDeny: string[];            // credential dirs, agav config, jobs root
  network: "deny" | "allow" | "broker-only";
  allowExecUnder?: string[];     // default: all (read-only root); optionally restrict
}
export function buildBwrapArgs(p: ConfinementPolicy, cmd: string[]): string[];
export function buildSeatbeltProfile(p: ConfinementPolicy): { profile: string; params: Record<string, string> };
export function buildDockerArgs(p: ConfinementPolicy, cmd: string[], image: string): string[];
```

**Tier 1: allowed for auto mode.**

| OS | Backend | Configuration (auto mode) | Notes |
|---|---|---|---|
| Linux | **bubblewrap** | `--ro-bind / /`, `--bind WF WF`, `--bind privTmp /tmp`, `--tmpfs` over `$HOME/{.ssh,.aws,.gnupg,.config,.kube,.docker}` and the Agav dirs, `--dev /dev`, `--proc /proc`, **`--unshare-net`** (when network is denied or broker-only), **`--unshare-pid --unshare-ipc --unshare-uts`**, `--new-session` (blocks TIOCSTI), `--die-with-parent`, `--chdir WF`, `--cap-drop ALL` | Extends today's shell profile (`sandbox.ts:329`) with network, pid and session isolation. Optional: Landlock rules when the kernel is ≥ 5.13, defence in depth with no extra dependency |
| macOS | **seatbelt** | Start from **`AGENT_SEATBELT_PROFILE`** (`agents/sandboxed-tool.ts:61`, `deny default`, writes only to WF and TMPDIR, `deny network*`). Add `HOME_*` read denies for the full deny-list, and `(allow network-outbound (remote unix-socket (path-literal BROKER)))` for broker-only. **Do not** use the shell profile `SEATBELT_PROFILE` (`sandbox.ts:136`, `allow default`), which is too loose | `sandbox-exec` is deprecated but still functional. Track Apple changes. Detect missing or blocked `sandbox-exec` and refuse |
| Any (incl. Windows) | **Docker** (or Podman) | `--network=none` (or an internal network to the broker), `--read-only`, `-v WF:/workspace:rw`, `--tmpfs /tmp`, `--cap-drop=ALL`, `--security-opt no-new-privileges`, `--pids-limit`, `--memory`, `--cpus`, uid:gid mapping (exists today), `--rm`, a **named container `agav-job-<jobId>`** so stopping can run `docker rm -f` (fixes the cleanup gap) | Image must contain the toolchain the workflow needs. Configurable `policies.sandboxImage`, default `node:22-slim` plus a git layer |
| Windows | **WSL2** (bubblewrap inside the distro) | Run the runner job via `wsl.exe -d <distro> -- agav …` with the WF mounted. bwrap applies inside WSL | WF on `/mnt/c` crosses the filesystem boundary, which is slow and gives weaker permission semantics. Recommend the WF inside the WSL filesystem |

**Tier 2: not allowed for auto mode.**
- **Windows native:** no AppContainer or restricted-token support exists today, and Job Objects only give ownership, not filesystem confinement (`types.ts:117` comment).
- **Auto mode on native Windows is therefore refused** with a clear message: "Auto mode on Windows requires Docker Desktop or WSL2. Use safe mode, or install one of these."
- A future native helper (AppContainer + Job Object + a low-integrity token with the WF ACL'd) is listed as an open question.

**Where the sandbox is applied:**
- **L4, the runner job:** `/job` launches the workflow runner with `isolation: { backend: <tier-1>, required: true }`.
  - This needs the `/job` change "implement isolation wrappers in the supervisor". Today `coordinator/service.ts:245` and `supervisor/lifecycle.ts:197` refuse any backend other than `none`.
  - The supervisor wraps `executable/args` with `buildBwrapArgs`, `buildSeatbeltProfile` or `buildDockerArgs`.
  - Process-group stop must still reach the workload. bwrap's `--die-with-parent` plus `--unshare-pid` means killing the bwrap process kills the tree. Docker stop uses `docker rm -f agav-job-<jobId>`.
- **L3, inside the runner:** every child spawn inherits the runner's confinement automatically, since it's a child process inside the sandbox. That includes the test runner, `gh`, hooks, MCP servers, LSP and `/watch`, so the "unsandboxed spawn paths" gap is closed **without** changing each call site. `run_command` inside the runner detects it is already confined (`AGAV_SANDBOX_ATTESTATION`) and uses backend `none` *inside* the outer sandbox, avoiding nested bwrap.
- **Child `/job`s started by the runner:** their supervisors are spawned from inside the runner's sandbox, so they inherit it on Linux and macOS. For Docker, child jobs run inside the same container (the coordinator and job storage root are mounted at a path inside it, §4.6).
- **Subagents:** `process.chdir`-based worktrees are unsafe in parallel (findings §3). In auto mode, subagent worktrees must live **inside the WF**, e.g. `.agav/worktrees/`, so writes stay confined. Replacing the process-wide `process.chdir` with a per-subagent cwd is tracked as a separate fix.

### 4.5 Command filtering (L1 detail)

- **`isDestructiveCommand`** (`utils/sandbox.ts`) remains a **hint**, not a boundary. In auto mode a match is refused, as described in §4.2. The real protection is L3/L4.
- **Extra auto-mode command refusals:** these are cheap, readable, and reduce how often the model wanders.
  - Commands that change privilege: `sudo`, `su`, `doas`, `pkexec`, `runas`.
  - Package-manager global installs: `npm -g`, `pip install --user` outside a venv, `brew install`, `apt`.
  - Commands that reach outside the sandbox: `docker`, `podman`, `wsl`.
  - Persistence: `crontab`, `systemctl`, `launchctl`, `schtasks`.
  - SSH/remote: `ssh`, `scp`, `rsync` with remote targets.

  These are matched on the parsed first token *and* after `sh -c` / `bash -c` / `env` unwrapping. Unwrapping is best effort, and that's acceptable because L3/L4 is the boundary.
- **Resource limits:**
  - Per command: the existing `run_command` timeout.
  - Per node: `timeoutSeconds`, enforced by the supervisor timeout (G3, step 4).
  - Per runner job: `--pids-limit`, `--memory` and `--cpus` with Docker.
  - On Linux bwrap: optionally `systemd-run --user --scope -p MemoryMax=… -p TasksMax=…` when available (the cgroup delegation is already detected by `platform/linux.ts`). Otherwise `ulimit -u/-v` via `prlimit`.

### 4.6 Model traffic, network and the provider broker

The runner needs model API access, but auto mode denies network. Two options:

**Option A: broker (recommended, and the default for auto mode).**
- A small **egress broker** runs *outside* the sandbox, as part of the runner's supervisor. The supervisor is already outside the sandbox: it spawns the wrapped workload.
- It exposes a Unix socket (named pipe or loopback on Docker) bound into the sandbox.
- The runner's provider client is configured to use `http+unix://` or `HTTPS_PROXY` pointed at the broker.
- The broker only forwards to the **configured provider host allow-list**, derived from the active provider config.
- The broker also **injects credentials**, so API keys never enter the sandbox. That closes the gap where "env-only provider keys would need to be passed in".

**Option B: network allowed.** `policies.network: "allow"`, which the user must opt into at consent. Simpler, but a prompt-injected model can exfiltrate WF contents anywhere.

`fetch_url` and `web_search` run inside the runner. In broker-only mode they are refused unless `policies.allowedHosts` lists targets, and the broker enforces that list.

### 4.7 Before-run snapshot and after-run review

- **Before an auto run,** if the WF is a git repo, the runner creates a **safety ref** `refs/agav/auto/<runId>`: `git stash create`, or a commit of the working tree onto a detached ref, which doesn't change the user's branch or index. The run record stores it.
- **If the WF is not a git repo,** auto mode requires `policies.allowNonGit: true` at consent. The consent prompt says plainly "no automatic rollback".
- **After the run,** the completion notification includes a change summary (`git diff --stat <safety-ref>`), and `/workflows rollback <runId>` restores the safety ref after confirmation.

### 4.8 Consent prompt for auto mode

Shown once per `workflow-run` or `chain-create` grant:

```
Run workflow "nightly-triage" UNATTENDED in AUTO mode?
  Working folder : /home/me/repo   (git: yes — safety snapshot will be taken)
  Sandbox        : bubblewrap  (writes: working folder + private /tmp; network: provider API only)
  Tools allowed  : read/edit/write files, run_command, run_tests, subagent
  Destructive    : refused (no exceptions listed)
  Schedule       : 0 2 * * * Asia/Kolkata
  Notifications  : sound + desktop on approval-needed / completion
This grant is bound to the workflow definition hash; any edit requires re-approval.
[y] approve  [n] cancel  [s] switch to SAFE mode
```

---

## 5. Notifications: sound and desktop

### 5.1 Events

| Event | Source | Default sound | Desktop toast |
|---|---|---|---|
| `approval-needed` | A pending approval is created (§3.3) | **Attention** (two-tone) | Yes: "Workflow X needs approval: <reason>" |
| `run-completed` (passed) | Workflow run or chain run reaches `passed` / `succeeded` | **Success** (single chime) | Yes, with a diff stat in auto mode |
| `run-failed` | `failed`, `timed_out`, or `cancelled` by policy | **Failure** (low tone) | Yes, with the failing node or step and the stderr tail (first line) |
| `run-blocked` | A chain is `blocked` (upstream `unknown`) | Attention | Yes: "needs manual resolve" |
| `auto-refused` | An auto run refused to start (no sandbox, grant invalid) | Failure | Yes |
| Standalone `/job` completion (optional) | Existing `CompletionEventRecord` | Off by default | Off by default |

Standalone jobs keep their current, silent behaviour unless the user turns on `notifications.jobs: true`. This preserves `/job`'s purpose.

### 5.2 Delivery architecture

```
producer (runtime / evaluator / supervisor)        consumer (whichever host is alive)
  └─ durable event → mailbox (events/ + new         ├─ TUI session: in-app banner + terminal bell/sound
     "workflow-events/" for non-job events)         ├─ agav job tick / daemon: desktop toast + sound
                                                    └─ next TUI start: shows anything not yet acknowledged
```

- **Exactly once across hosts:** whichever host is alive claims the event with `claimForPresentation(eventId, clientId)`, which already exists in `MailboxService`. It presents the event, then calls `acknowledge`. Another TUI or tick host sees the claim and skips it.
- **Persisting claims (a fix):** claims are currently in memory only. They are now stored as `acks/` plus a short-lived `claims/<eventId>.json` with a TTL, so two *processes* don't both play a sound. A TUI and a tick host are two processes.
- **The tick host presents even when no TUI is open.** That is the "Agav not running in a terminal" case. The tick runs every minute from the OS scheduler (`job-dependency-model.md` §6.2), so the delay is ≤ 60 s, or about 1 s with the completion nudge.
- **Producers for events that aren't job events** (approval-needed, chain blocked) write to `workflow-events/<eventId>.json`. This uses the same mailbox API, generalized to read both directories, so `CompletionEventRecord`'s shape doesn't change.
- **Storm guard:** reuse `dedupeEventsForDelivery` and add rate limiting. At most 1 sound per 10 s; anything beyond that is combined into "3 workflows need attention".
- **Quiet hours:** `notifications.quietHours: "22:00-07:00"` turns off sound and keeps toasts. When quiet hours end, the next tick plays one summary sound.

### 5.3 Cross-platform sound and toast options

The code is ported from #413's `utils/desktop-notify.ts` and bell sink, with fallbacks rearranged. Each sink is a `notifySubscribers` subscriber, so a failure in one is isolated and retried (`MailboxService.notifySubscribers`).

| OS | Toast | Sound | Fallbacks |
|---|---|---|---|
| macOS | `osascript -e 'display notification … sound name "Glass"'` (sound included) | `afplay /System/Library/Sounds/{Glass,Funk,Basso}.aiff` | `terminal-notifier` if installed; terminal bell |
| Linux | `notify-send -u {normal,critical} -a agav …` | `canberra-gtk-play -i {complete,dialog-warning,dialog-error}`, then `paplay`/`pw-play` with freedesktop sounds under `/usr/share/sounds/freedesktop/stereo/`, then `aplay` with a bundled WAV | `zenity --notification`; terminal bell. Headless or SSH with no `DBUS_SESSION_BUS_ADDRESS`: skip the toast, log it |
| Windows | PowerShell WinRT `ToastNotificationManager` (AUMID registered at install), then `BurntToast` if present, then a `NotifyIcon` balloon | `[System.Media.SoundPlayer]` with bundled WAVs, or `[System.Media.SystemSounds]::{Asterisk,Exclamation,Hand}.Play()` | `[console]::beep(freq,ms)`; terminal bell |
| TUI open (any OS) | In-app banner | `\x07` terminal bell (respects the terminal's own setting), plus the OS sound if `notifications.sound: "system"` | — |

**Assets:** three short WAVs (attention, success, failure) of about 20 KB each go in `assets/sounds/`, so sound works the same everywhere and the Linux and Windows paths don't depend on theme packs. Users can override them with `notifications.sounds.{attention,success,failure}: <path>`.

**Configuration** (user config only; project config can't change it):

```jsonc
"notifications": {
  "enabled": true,
  "sound": "system" | "bell" | "off",          // default "system"
  "desktop": true,
  "events": { "approval-needed": true, "run-completed": true, "run-failed": true, "run-blocked": true },
  "jobs": false,                                // standalone /job completions
  "quietHours": null,
  "sounds": { "attention": null, "success": null, "failure": null }
}
```

**Testing hook:** `agav notify test [attention|success|failure]` plays each sound and shows each toast, so users can check that sound works on their machine. This matters for Windows and Linux desktop variations.

---

## 6. How the modes plug into `/job` without changing its purpose

| `/job` element | Change | Standalone jobs affected? |
|---|---|---|
| `GrantAction` | Add `"workflow-run"`, `"chain-create"`, `"chain-resolve"`, `"approval-decide"` (additive, T01) | No |
| Grant terms hashed | For workflow and chain grants: `approvalMode`, `network`, `allowDestructive`, `allowedTools`, `sandboxBackend`, `allowNonGit` | No (job grants unchanged) |
| `headlessApprovedActions` | Still `[]` for every interactive and tool path. The chain evaluator and workflow host derive a scoped snapshot from the run's grant: `["start"]`, only for specs the grant covers | No |
| `IsolationPolicy` | Supervisor implements `bubblewrap`, `seatbelt` and `docker` wrappers. `required: true` for auto mode | Optional: users *may* now request isolation for standalone jobs. The default stays `none`, as today |
| `isolation-unavailable` refusals | Removed for implemented backends only. Still refused for `job-object` and for backends that are unavailable | Behaviour unchanged for `none` |
| Mailbox | Durable claims; second event directory for non-job events; sinks wired in | Standalone completions stay silent unless enabled |
| `run_background_job` / `/job` | Unchanged. New `/workflows pending\|approve\|deny`, `/job approvals` and a Jobs TUI "Approvals" tab are additive | No |

---

## 7. Open questions for step 4

1. **Windows native sandbox:** build an AppContainer + Job Object helper (signed binary, adds weight), or keep auto mode limited to Docker/WSL2 on Windows? This design proposes Docker/WSL2 only for v1.
2. **Broker scope:** should the broker also proxy package registries (npm, pip) for auto runs that need `pnpm install`? It could use a host allow-list per workflow. Otherwise those workflows need `network: allow`.
3. **Landlock on Linux:** add it as a second layer under bwrap in v1, or later?
4. **Approval in the TUI while a run is attached interactively:** should the TUI be able to "adopt" a detached run's pending approvals inline in the chat? Proposed: yes, as a banner with approve/deny keys.
5. **Snapshot retention:** delete `refs/agav/auto/*` after N days or N runs.
6. **The sandboxed runner needs the Agav install readable inside the sandbox.** That's true with read-only root on bwrap and seatbelt. For Docker, either mount the install read-only or use an `agav` image. The upgrade implications go in step 4.
