
# Manual testing guide: workflows on `/job`

Tags: **[auto]** means the earlier real-supervisor smoke or harness verified it. **[manual]** means it needs a TTY or a human, so it is expected but not yet observed.

## 0. Setup

**Isolated HOME and scratch workspace.** Part A and Part C (except C1/C2/C4) need no provider. Don't use `/tmp`: a cwd under `/tmp` breaks the production bubblewrap sandbox.

```bash
mkdir -p ~/wf-test/home/.agav ~/wf-test/work
cat > ~/wf-test/home/.agav/config.json <<'EOF'
{"backgroundJobsEnabled":true,"workflowsEnabled":true,"permissionMode":"ask"}
EOF

# Run from source (build/ is stale and has no workflow code). Use the repo's tsx directly.
agav()  { HOME=$HOME_T /home/pranav/cli/agav/node_modules/.bin/tsx /home/pranav/cli/agav/source/cli.tsx "$@"; }
export HOME_T=~/wf-test/home
cd ~/wf-test/work
```
Note that `agav` here is a shell function that sets `HOME` only for the workflow command. Resume must run from the same directory as the original run: `Resume must use the original working directory: <cwd>`.

**Handy helpers:**
```bash
newrun() { agav "$@" 2>&1 >/dev/null | sed -n 's/^Workflow run: //p'; }  # prints run uuid
RUNDIR=$HOME_T/.agav/workflow-runs      # <uuid>.json, <uuid>.cancel, locks/
JOBDIR=$HOME_T/.agav/background-jobs    # jobs/, grants/, ...
```

**Sample workflows** (all `version: 1`; ids must start with a letter):
```bash
cat > wf-basic.json <<'EOF'
{"version":1,"name":"basic","nodes":[
 {"id":"a","type":"tool","tool":"list_directory","input":{"path":"."}},
 {"id":"gate","type":"approval","prompt":"ok to continue?","dependsOn":["a"]},
 {"id":"b","type":"tool","tool":"read_file","input":{"path":"wf-basic.json"},"dependsOn":["gate"]}]}
EOF
cat > wf-write.json <<'EOF'
{"version":1,"name":"write","nodes":[
 {"id":"w","type":"tool","tool":"write_file","input":{"path":"out.txt","content":"hi"}}]}
EOF
cat > wf-job.json <<'EOF'
{"version":1,"name":"job","nodes":[
 {"id":"gate","type":"approval","prompt":"start the job?"},
 {"id":"j","type":"job","command":"echo hello-from-job","dependsOn":["gate"]},
 {"id":"w","type":"tool","tool":"write_file","input":{"path":"job-out.txt","content":"GOT:${nodes.j.output}"},"dependsOn":["j"]}]}
EOF
cat > wf-long.json <<'EOF'
{"version":1,"name":"long","nodes":[
 {"id":"j","type":"job","command":"sleep 300"},
 {"id":"after","type":"tool","tool":"list_directory","input":{"path":"."},"dependsOn":["j"]}]}
EOF
cat > wf-reattach.json <<'EOF'
{"version":1,"name":"reattach","nodes":[
 {"id":"j","type":"job","command":"sleep 40; echo reattach-DONE"},
 {"id":"w","type":"tool","tool":"write_file","input":{"path":"re-out.txt","content":"GOT:${nodes.j.output}"},"dependsOn":["j"]}]}
EOF
cat > wf-two-jobs.json <<'EOF'
{"version":1,"name":"two","nodes":[
 {"id":"j1","type":"job","command":"echo first"},
 {"id":"j2","type":"job","command":"echo second","dependsOn":["j1"]}]}
EOF
# Bad files, one per rule
w(){ echo "$2" > "$1"; }
w bad-interp.json  '{"version":1,"name":"x","nodes":[{"id":"j","type":"job","command":"echo ${inputs.x}"}]}'
w bad-timeout.json '{"version":1,"name":"x","nodes":[{"id":"j","type":"job","command":"echo hi","timeoutSeconds":5}]}'
w bad-type.json    '{"version":1,"name":"x","nodes":[{"id":"j","type":"agent"}]}'
w bad-cycle.json   '{"version":1,"name":"x","nodes":[{"id":"a","type":"approval","prompt":"p","dependsOn":["b"]},{"id":"b","type":"approval","prompt":"p","dependsOn":["a"]}]}'
w bad-dep.json     '{"version":1,"name":"x","nodes":[{"id":"a","type":"approval","prompt":"p","dependsOn":["nope"]}]}'
w bad-id.json      '{"version":1,"name":"x","nodes":[{"id":"../x","type":"approval","prompt":"p"}]}'
w bad-tool.json    '{"version":1,"name":"x","nodes":[{"id":"t","type":"tool","tool":"run_background_job","input":{}}]}'
```

---

## Part A: headless CLI (no provider needed)

**A1. Help and gate [manual].**
- `agav workflows help` prints the usage text and exits 0.
- Temporarily remove `workflowsEnabled` from `$HOME_T/.agav/config.json`, then run `agav workflows validate wf-basic.json`. Expect `error: Workflows require backgroundJobsEnabled=true AND workflowsEnabled=true.` and exit 1. Restore the key.

**A2. Validation [manual].** `agav workflows validate wf-basic.json` prints `Workflow valid (foreground tool/approval/job subset).` Then run it on each bad file, expecting exit 1 and:

| file | expected `error:` contains |
|---|---|
| bad-interp | `Shell interpolation is not supported; use a literal command.` |
| bad-timeout | `Job nodes do not support timeoutSeconds: j` |
| bad-type | `Invalid workflow (supported nodes: tool, approval, job)` |
| bad-cycle | `Dependency cycle at` |
| bad-dep | `Unknown dependency: nope` |
| bad-id | `Invalid workflow` (id pattern) |
| bad-tool | `Unsupported workflow tool: run_background_job` |

**A3. A → approval → B, resume, no re-run [auto for the runtime, manual for the CLI strings].**
```bash
RUN=$(newrun workflows run wf-basic.json)   # run JSON on stdout, exit 0
echo $RUN
agav workflows status $RUN                  # status: waiting_approval; a passed, gate waiting_approval, b pending
agav workflows resume $RUN                  # still waiting_approval; a is NOT re-run
agav workflows approve $RUN gate            # gate passed, output "approved"
agav workflows resume $RUN                  # status passed; b has file contents as output
```
Checks: the run id must be the full UUID, and `approve` does not resume on its own. Inspect the checkpoint with `cat $RUNDIR/$RUN.json | head -60`. Node `a` keeps its original `endedAt` after resume.

**A4. Deny [manual].** Make a new run, then `agav workflows deny $RUN gate`. Expect gate `failed` with output `denied`, error `Approval denied.`, run `failed`, and exit 1.

**A5. Permission gate [auto].**
- `agav workflows run wf-write.json` exits 1 with `Tool 'write_file' requires confirmation but no confirmation handler is available (headless mode).` and no `out.txt`.
- `agav --auto-accept workflows run wf-write.json` writes `out.txt`. Global flags must come before `workflows`.
- `agav --deny-writes workflows run wf-write.json` fails with `Write operations are denied (--deny-writes mode).`

**A6. Headless job denial [auto].**
```bash
RUN=$(newrun workflows run wf-job.json); agav workflows approve $RUN gate
agav workflows resume $RUN; echo "exit=$?"            # 1
ls $JOBDIR 2>/dev/null; ls $JOBDIR/grants 2>/dev/null # no jobs, no grants
```
Expect node `j` to fail with `Job start failed: Headless execution requires an explicit applicable grant; none is present.`, node `w` pending, and no job created. Repeat with `agav --auto-accept workflows ...`. The result must be identical, because the headless gate runs before auto-accept.

**A7. sandboxRequired [auto, programmatic only].** Run `agav --sandbox-required workflows run wf-job.json`, then approve and resume. Expect node `j` to fail with `Job nodes are refused while sandboxRequired is enabled: background jobs run outside the OS sandbox.` and no job. The earlier smoke passed this flag programmatically, not through the CLI flag, so the flag path is [manual].

**A8. Corrupt checkpoint [manual].** Edit any field in `$RUNDIR/$RUN.json` and run `status`. Expect `Corrupt workflow checkpoint; refusing execution.`

---

## Part B: interactive TUI (needs a provider)

Use your real HOME and a scratch project directory. Add one key to `~/.agav/config.json`: `"workflowsEnabled": true`. Your file already has `backgroundJobsEnabled: true`. Revert by removing that key. Start with:
```bash
cd ~/wf-test/work && /home/pranav/cli/agav/node_modules/.bin/tsx /home/pranav/cli/agav/source/cli.tsx
```
Give the workflow files absolute paths if you use the real HOME, or copy them to `~/wf-test/work`.

**Prompt caching warning.** Every interactive "yes" mints an exact-spec grant, so re-running the same job command skips the start prompt. Stop grants work the same way. To see prompts again, change the command text, for example `sleep 301`. Using a different command is easier than clearing grants.

**B1. Help/validate [manual].** `/workflows` (usage) and `/workflows validate ~/wf-test/work/wf-basic.json`.

**B2. Tool consent [manual].** `/workflows run ~/wf-test/work/wf-write.json`. Expect `Allow workflow tool write_file?` with the full resolved input, directory, and `Single invocation only. Workflow approvals grant no tool permissions.` Try `y` (file written), `n` (node fails, no file), and Esc (denies the prompt and cancels the workflow).

**B3. Approval flow [manual].** Run `wf-basic.json` and expect status `waiting_approval`. There is no prompt for approval nodes. Run `/workflows approve <uuid> gate`, then `/workflows resume <uuid>`.

**B4. Job start and output passing [auto programmatically, manual UI].** Edit `wf-job.json` to a fresh command such as `echo hello-$RANDOM`, run it, approve the gate, then resume. Expect a `Start job?` prompt showing Command, Directory and `Isolation: NONE…`, with footer `[Y]es / [N]o`. After `y`, `job-out.txt` contains `GOT:<output>`. Run `/job list` to see exactly one job.

**B5. "Always" doesn't suppress job prompts [manual].** Run `wf-two-jobs.json`. Press `a` on the `j1` prompt. It should act as one "yes", and `j2` must prompt again.

**B6. Stop prompt on abort [auto programmatically, manual UI].** Run `wf-long.json` and approve the start. With the job running, press Ctrl+C or Esc.
- Expect `Stop running job?` with Job, ID and Parent lines.
- Answer `y`: the run ends `cancelled`, `/job list` shows the job interrupted, and `pgrep -f "sleep 300"` finds nothing.

**B7. Denied stop [auto programmatically, manual UI].** Repeat B6 with a new command (`sleep 302`, say), but answer `n` to the stop prompt. Expect "cancellation incomplete" and the job still alive. The run stays `running`. `/workflows resume <uuid>` reattaches. Clean up with `/job stop <id>`.

**B8. B4 fix: decline another run's stop prompt [manual, new].**
1. Start run X (`wf-long.json` variant, `sleep 303`) in a TUI. Quit with `kill -9` (see C1) so its job stays live.
2. Start a second TUI and run workflow Y, a long tool such as `wf-long-tool.json` under auto-accept or a long job.
3. In Y's session, type `/workflows cancel <X's uuid>`. A `Stop running job?` prompt appears.
4. Press Esc. Expect only that prompt to be declined and Y to keep running. A second Esc then aborts Y.

**B9. B3 fix: Esc doesn't answer an unseen prompt [manual, best-effort].** This needs two stacked confirmations. For example, while a workflow shows a job-start prompt, type `/workflows cancel <live run>` so a second stop prompt queues behind it. Esc should deny only the displayed prompt, and the queued one should appear still unanswered. If you can't produce two stacked prompts, mark this "not reproduced".

**B10. Misc keys [manual].**
- Ctrl+R while a workflow runs: nothing happens (retry is refused).
- Idle Ctrl+C exits.
- `/exit` during a running workflow waits for settlement, then exits.
- Quit the TUI while a job runs: the job stays alive (`/job list` in a new session).

---

## Part C: resilience

**C1. Reattach after a kill [auto programmatically].** Headless can't start jobs, so start the job from the TUI.
1. TUI: run `wf-reattach.json`, approve `Start job?`, wait until the job is running.
2. From another terminal: `pkill -9 -f "tsx.*cli.tsx"` (check with `pgrep -af cli.tsx` first so you only kill the test session). Run `reset` in the dead terminal.
3. `RUN=$(ls -t $HOME/.agav/workflow-runs/*.json | head -1 | xargs basename | sed 's/.json//')` (use `$RUNDIR` if you used the isolated HOME), then run `agav --auto-accept workflows resume $RUN`.
4. Expect the same `jobId` in the checkpoint, exactly one job, a pass after the sleep ends, and `re-out.txt` with `GOT:reattach-DONE`. Reattach needs no grant.

**C2. Uncertain state [auto programmatically].** Repeat C1 step 1 and kill the runner. Then find the leftover processes with `ps aux | grep -E "supervisor|sleep"` and `kill -9` the job and its supervisor. Resume. Expect `uncertain: job <id> is in state "unknown"; outcome unknown, not retried.`, one job, and the downstream node pending.

**C3. Headless cancel limits [auto].** With a live job and no runner, run `agav workflows cancel $RUN`. Expect exit 1 with `cancellation incomplete: … headless execution requires an explicit applicable grant for "stop"; none is present`. The run and job stay running.

**C4. SIGINT/SIGTERM on a headless run [auto].** Run `agav --auto-accept workflows run ~/cli/agav/wf-long-tool.json` (this is the stray `sleep 30` file). Press Ctrl+C. Expect run `cancelled`, exit 1, and node `after` pending. Repeat with `pkill -TERM -f "workflows run"` from another terminal.

---

## Part D: cleanup

- Stop leftover jobs: `/job stop <id>`, or `pkill -9 -f "sleep 30"` for stragglers.
- Supervisors idle about 5 minutes after a job finishes and ignore SIGTERM. Use `kill -9` only on test ones (`ps aux | grep -i supervisor`).
- `rm -rf ~/wf-test`.
- Remove `workflowsEnabled` from your real config if you added it.

## Part E: known issues (don't file these as new bugs)

- **High, open:** if `start()` throws and the `requestId` lookup also fails, the node becomes `failed` while a job may still be live. Cancel and resume then can't reconcile it.
- **High, open:** three failed polls, or an `unknown` job state, fail the node and run terminally without stopping the job.
- **Sticky cancel marker:** after a failed headless cancel, a later headless resume tries to stop the job again.
- **Grants:** each interactive "yes" mints an exact-spec grant, so identical re-runs skip prompts.
- **Docs error:** `docs/docs/reference/workflows.md:100` says `cancelRun` without job support "changes nothing". It writes the cancel marker first.
- **Not supported:** job timeouts, interpolation in job commands, detach, schedules, workflow-run grants, retries, parallel nodes.
- **Cosmetic:** `node.job.state` is a snapshot at admission.
- **Unverified:** the TUI prompt rendering and key order, large-output truncation, `callDeadlineMs` against a real wedged coordinator, and Windows.
- **Unconfirmed in the fact sheet:** the exact refusal text for `run_command` tool nodes under `sandboxRequired`, and whether project config can set `backgroundJobsEnabled`.

## Summary checklist

| ID | What | Tag |
|---|---|---|
| A1–A2 | gates, validation messages | manual |
| A3–A4 | approval, resume, no re-run, deny | auto + manual |
| A5 | headless permission gate | auto |
| A6 | headless job denial, no grants | auto |
| A7 | `--sandbox-required` | auto (programmatic) |
| B2–B3 | tool consent, approval via slash | manual |
| B4–B7 | job start, output, stop prompts | auto + manual UI |
| B5 | "Always" ignored for jobs | manual |
| B8–B9 | B4/B3 Esc fixes | manual, new |
| B10 | Ctrl+R, idle Ctrl+C, `/exit`, quit with live job | manual |
| C1–C2 | reattach, uncertain | auto |
| C3–C4 | headless cancel limits, SIGINT/SIGTERM | auto |

If you want, I can have a subagent save this as `docs/workflow-manual-testing-guide.md`. Say so and I'll do that.