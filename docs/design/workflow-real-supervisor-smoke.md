# Workflow `job` nodes: real coordinator/supervisor smoke

Branch `feat/workflows`. Verification only: no source or test file was edited. This document is the only file written in the repo. The scratch directory has been deleted.

## Setup

- **Compiled output:** the repo's `build/` is stale. It has no `workflows/` directory and `grep -rl workflowsEnabled build` matched nothing, so it was not used.
- **What was used instead:** `./node_modules/.bin/tsc -p . --outDir <scratch>/emit --declaration false --declarationMap false --sourceMap false` exited 0. `tsc -p . --noEmit` also exited 0.
- **Extra files the emitted tree needs** (the same things `pnpm build` copies):
  - `source/cli.tsx` copied to `emit/cli.js`. `main.js` alone prints nothing, because `cli.js` is the real entry point.
  - `package.json` one directory above `emit/`. `version.js` imports it.
  - `source/agents/bundled`, `source/skills/bundled` and `source/agents/sandbox-exec.mjs`.
- **Supervisor asset:** `resolveSupervisorEntryPath()` is relative to the compiled module. The emit tree must therefore contain `background-jobs/supervisor/entry.js`, and it does. The existing background-jobs tests that import compiled modules have the same requirement: a full `tsc` emit is needed, not just the workflow files.
- **Environment:**
  - The repo was writable only at `/home/pranav/cli/agav` itself.
  - `/tmp` was writable, but the production bubblewrap sandbox mounts a fresh tmpfs over it. Because of the known cwd-mount ordering problem, the scratch directory lived at `/home/pranav/cli/agav/.agav-worktrees/smoke-real`. That path is git-ignored.
  - A first attempt at `.agav-worktrees/sa-4/.smoke` vanished between commands, so it was abandoned.
  - Shell commands run under bubblewrap with `--die-with-parent`. The sandbox was not weakened.
- **Isolation:** `HOME=<scratch>/home` with `~/.agav/config.json` = `{"backgroundJobsEnabled":true,"workflowsEnabled":true,"permissionMode":"ask"}`. The real `~/.agav` was not touched (its timestamps predate the session). No network, provider or secrets were involved.
- **Check 1** used the real CLI: `node <emit>/cli.js [global flags] workflows ...`.
- **Checks 2-7** used a Node harness that imports the emitted modules. It uses `WorkflowStore`, `createRun`, `executeRun`, `cancelRun`, `decideApproval` and the real `getSharedCoordinator()`, which spawns real detached supervisors.
  - It builds `jobDeps = {getCoordinator: getSharedCoordinator, session: {permissionMode:"ask", headlessApprovedActions:[], confirmBackgroundAction}, sandboxRequired, headless:false}`. `confirmBackgroundAction` auto-answers true, or false for `stop` in the denied-stop scenarios.
  - There is no fake coordinator.
  - Check 4 used separate child `node` processes, one per runner.

## Results

| # | Check | Result |
|---|-------|--------|
| 1 | Headless CLI denial, with and without `--auto-accept` | **PASS** |
| 2 | Real launch with consent: approval -> job -> tool using `${nodes.j.output}` | **PASS** |
| 3a | Real stop on abort (job plus grandchild gone) | **PASS** |
| 3b | Stop denied: node stays running; `cancelRun` with approval finishes it | **PASS** |
| 3c | Stop denied, then resume with an approving session | **PASS** |
| 4a | SIGKILL runner during a live job, resume reattaches | **PASS** |
| 4b | SIGKILL runner, job finishes meanwhile, resume | **PASS** |
| 4c | Headless CLI resume and cancel against a surviving job | **PASS** (see observation 3) |
| 5 | Same `requestId` gives the same job | **PASS** |
| 6 | `sandboxRequired` refuses the job | **PASS** (programmatic; see limits) |
| 7 | Uncertain handling (supervisor and job SIGKILLed) | **PASS** |

## Evidence

### 1. Headless CLI denial

A fresh isolated HOME was used, with `wf1.json` = `gate` (approval) -> `j` (job `echo hello-from-job`) -> `rd` (tool `read_file README.md`).

```
agav workflows run wf1.json                    exit=0  (waiting_approval, run id printed on stderr)
agav workflows approve <id> gate               exit=0
agav workflows resume <id>                     exit=1
  run failed; gate passed;
  j failed: "Job start failed: Headless execution requires an explicit applicable grant; none is present.
             (no job found for wf-<id>-j-1)."
  j.job = {requestId: wf-<id>-j-1} only (no jobId);  rd pending
agav workflows status <id>                     exit=1
```

The same sequence with `--auto-accept` as the first argument (`agav --auto-accept workflows run|approve|resume|status`) gave identical results: resume exit 1, the same denial message, `rd` still pending. This was repeated in two separate HOMEs.

- **No job process:** the isolated `~/.agav/background-jobs/` contained only `VERSION`. There was no `jobs/`, `specs/` or `grants/` directory, and no supervisor process.
- **No grant minted:** `grants/` was never created.
- **Why:** the headless gate runs before `permissionMode`, so auto-accept cannot bypass it.

### 2. Real launch with consent

`wf2.json`: `gate` -> `j` = `echo hello-from-job; echo err-line 1>&2; exit 0` -> `w` = `write_file {path: "job-out.txt", content: "GOT:${nodes.j.output}"}`.

- The first `executeRun` ended `waiting_approval`. After `decideApproval`, the second `executeRun` (with `jobDeps` and a tool host) ended `passed`.
- Prompts seen: exactly `[{action:"start", command:"echo hello-from-job; ...", signalAborted:false}]`.
- Node `j`: `status: passed`, `output: "hello-from-job\n"` (stderr is not included).
- Checkpoint `j.job`: `{requestId: "wf-939c2342-…-j-1", jobId: "ec8bd11b-…", state: "completed", exitCode: 0, outputTruncated: false}`.
- Coordinator: `list()` had exactly 1 job, `findByRequestId` returned that same jobId, and `log(stdout)` was `"hello-from-job\n"`.
- Downstream: `job-out.txt` contained `"GOT:hello-from-job\n"`, so output passing works.
- One exact-spec `start` grant was minted by the interactive approval.

### 3. Real stop

`wf3.json` runs `node long.cjs`, which spawns a `sleep 600` grandchild, writes both pids, and idles for 600 s.

- **3a (approved stop):**
  - Before abort, the job pid and grandchild were both alive and the coordinator said `running`.
  - After `abort()`, `executeRun` returned run `cancelled`; node `j` was `cancelled` with state `interrupted` and `exitCode: null`.
  - The `jobId` linkage was kept in the checkpoint.
  - Prompts: `start`, then `stop`. The stop prompt arrived with `signalAborted:false`, so a fresh signal was used.
  - After 500 ms, `kill -0` on both the grandchild and the job process showed they were gone, and the coordinator said `interrupted`.
- **3b (denied stop, using a distinct command `node long.cjs b`):**
  - `executeRun` threw `JobCancellationIncompleteError`: `cancellation incomplete: stop request failed (Background action rejected, cancelled, or changed.); job 5c4125ac-… is still "running" (…)`.
  - The run stayed `running` and node `j` stayed `running` with its `jobId` linkage.
  - Both processes were still alive, and the coordinator said `running`.
  - `cancelRun(..., approvingDeps)` then prompted for `stop` and set the node `cancelled` and the run `cancelled`. Both processes were gone afterwards.
- **3c (denied stop, then resume with an approving session):**
  - After the denial the run stayed non-terminal.
  - `executeRun` with an approving session reattached: node `running`, same jobId, processes alive, still exactly 1 job for the requestId.
  - After a second abort the run became `cancelled` and the job `interrupted`. Processes were gone.
- The denied-stop result is only observable when no exact-spec `stop` grant exists; see observation 1.

### 4. Reattach after kill

`wf4.json`: `j` = `sleep 6; echo reattach-output-DONE`, then a `write_file` tool node using `${nodes.j.output}`. The runner was a separate `node r4.mjs` child, killed with SIGKILL once `node.job.jobId` was in the checkpoint.

- **4a (resume while the job was still running):**
  - After SIGKILL the on-disk run was `running` and node `j` was `running`.
  - The coordinator still said `running`, so the supervisor survived.
  - The new process resumed and took about 5.7 s, waiting for the surviving job.
  - Result: `passed`, with the same jobId (`a8b54df9-…`). `jobs for requestId: 1`.
  - No prompts were shown, because reattach needs no grant.
  - Output `reattach-output-DONE\n` was passed on: `reattach-out.txt` = `"GOT:reattach-output-DONE\n"`.
- **4b (resume after the job had already finished):** the job was `completed` with exit 0 before the resume. Resume took 369 ms and ended `passed`. Same jobId, 1 job for the requestId, same downstream file content.
- **4c (the real headless CLI):**
  - After SIGKILL of the runner, `agav workflows cancel <id>` exited 1: `cancellation incomplete: job … is still running and was not stopped: headless execution requires an explicit applicable grant for "stop"; none is present (node j; …)`.
  - The run stayed `running`, the node stayed `running`, and the job stayed `running`.
  - In a fresh scenario without a prior cancel, `agav --auto-accept workflows resume <id>` exited 0. It reattached to the same jobId, ended `passed`, and the downstream node passed. There was still 1 job.

### 5. `requestId` idempotency

`coordinator.start()` was called twice with the same `requestId` (`wf-smoke-idem-1`). Both calls returned the same `jobId`, and `list()` showed 1 job for that requestId.

### 6. `sandboxRequired`

A run with `deps.sandboxRequired = true` ended `failed`. Node `j` was `failed` with `Job nodes are refused while sandboxRequired is enabled: background jobs run outside the OS sandbox.`, and `j.job` held only the `requestId`. The coordinator job count was unchanged (11 before and after, 0 for that run). No prompt was shown.

### 7. Uncertain handling

Reproduced cheaply by SIGKILLing the runner, the supervisor and the job process while the job was `running`. The resume ended `failed` with `uncertain: job 927d6012-… is in state "unknown"; outcome unknown, not retried.`. The node kept `jobId` and `state: unknown`, there was still 1 job for the requestId, and the downstream node stayed `pending`. The job was not restarted.

## Observations

1. **Grants are minted on every interactive "yes" in `ask` mode.** `recordExplicitApproval` persists an exact-spec grant, one for `start` and one for `stop`. My first 3a/3b run used the same command for both scenarios. In 3b the `stop` was then authorized with no prompt and the denial was never exercised, because 3a's `stop` grant covered the identical spec. This is the coordinator's `/job` behavior, and the workflow docs say the same ("no workflow-run grants", the coordinator's grants apply). It does mean that re-running a workflow with an identical job command skips both prompts. 8 grants were minted across the whole interactive session.
2. **Supervisors outlive finished jobs.** After a job is terminal, its supervisor idles for `SUPERVISOR_IDLE_EXIT_MS` (5 min) before exiting. Supervisors ignore SIGTERM and SIGINT by design (`supervisor/entry.ts:30-36`). I had to SIGKILL the leftover scratch supervisors during cleanup; all of them belonged to the scratch HOME and none had a live job.
3. **Cancel marker sticks after a headless cancel failure.**
   - After the headless `cancel` failure in 4c (`DO_CANCEL=1` variant), a later `agav --auto-accept workflows resume <id>` also exited 1 with the same headless-stop denial. The durable cancel marker made the resume abort and try to stop the job.
   - The job then completed on its own; its state was `completed` after an 8 s wait.
   - This matches the documented behavior ("If a cancel marker exists at resume, the job is reattached first and then stopped"). It is not a bug, but a headless-only user cannot clear it while the job is live.
   - I did not run a further resume after completion, so what happens then is untested.
4. **Checkpoint `node.job.state` is a snapshot at admission.** It said `starting` in 3a while the coordinator already said `running`, and `running` in 4a. The final state is recorded on completion. This is cosmetic.

## Bugs found

None. No source defect was observed in `source/workflows/*`, `source/cli/workflows-cli.ts` or the coordinator integration.

## Not covered / limits

- **No TTY or PTY.** The interactive `/workflows` host and the real confirmation queue UI were not driven. Consent was supplied programmatically through `confirmBackgroundAction`. Check 2 therefore proves the workflow-to-coordinator-to-supervisor path, not the App's prompt rendering.
- **Check 6** passed `sandboxRequired: true` directly in `jobDeps`. undefined
- **Large output:** stdout truncation at 64 KiB, stderr tail bounds and `outputTruncated: true` were not exercised against real large output.
- **Not tested:**
  - `callDeadlineMs` timeouts against a wedged real coordinator.
  - Three consecutive poll failures.
  - Windows `cmd`.
  - The real-terminal Esc/Ctrl+C ordering for stop prompts.
  - A resume after a headless cancel failure once the job has finished (observation 3).
- **Environment limits:** the repo path was the only writable repo location, `/tmp` is hidden by the production sandbox, and `build/` was stale, so a scratch `tsc` emit was used.
- **Cleanup:** the scratch directory was removed. `ps` shows no remaining supervisor, `node long.cjs`, `sleep 600/6` or runner processes. The only repo change is this document (untracked).
