# Workflow manual test scenarios

A human checklist for the parts of the agav workflow feature that automation could not verify (real TTY, real agent, real terminal sessions). Tick each box as you go.

## Already verified automatically

Not repeated below as manual steps.

- Validate and discovery by name (JSON and YAML).
- A background run completes; a run survives `kill -9` of the launcher.
- Cancel from another process stops the runner and its child job.
- `kill -9` of the runner, then `status` reconciles, relaunches (attempt 2) and reattaches the same job, with no second job.
- An approval parks the run; `approve` from another process resumes it; `deny` fails it; two concurrent approvers give exactly one winner.
- Queueing with `maxConcurrentWorkflowRuns=1`, and automatic admission when the first runner exits.
- Loop `until` counter and loop exhaustion.
- A `job` node inside a `loop` runs on the real supervisor (re-verified after commit 6c20619e): request ids are `wf-<runId>-<node>-1_i0`, `_i1`, `_i2`, and the run passes. Cancelling such a run mid-iteration from another process removes the child job and the runner. `kill -9` of the runner mid-iteration, then `status`, relaunches (attempt 2) and reattaches the same job, with no second `sleep`.
- Denying an approval inside a loop when a body node depends on it (re-verified after commit 6c20619e): `status` prints the tree (no `Corrupt workflow checkpoint`), the run is `failed`, `workflows list` lists it, and the dependent stays `pending`.
- A `prompt` node without credentials fails cleanly.
- The secret env value is not written to disk.
- The TUI renders its 3 tabs at 80x24.
- Run, cancel and runner `kill -9` with reattach also verified with the compiled standalone binary (`dist/agav`) at e9ec5a97.

## Known issues found during smoke testing

- **FIXED in commit 6c20619e.** A `job` node inside a `loop` failed with `Invalid or unsafe identifier`. Job request ids in loops are now `wf-<uuid>-<node>-<attempt>_i<iteration>` (for example `wf-<uuid>-tick-1_i0`, `_i1`, `_i2`), which the background-jobs store accepts. Re-verified on the real supervisor with a 3-iteration loop that has a `job` node and a `tool` node: the run passes with those ids; a cancel mid-iteration stops the child job and the runner; `kill -9` of the runner mid-iteration is reconciled with attempt 2 reattaching the same job (no second `sleep`).
- **FIXED in commit 6c20619e.** Denying an approval inside a loop, when another node depends on it, corrupted the checkpoint. Now the dependent stays `pending` (it is not recorded as `skipped`) and the run is `failed`. Re-verified with the M10 workflow: `status` prints the tree, `workflows list` lists the run, `gate` is `failed` (`Approval denied by …`), `mark` is `pending`, and `m10-rounds.txt` is not created. See M10 step 7.

## Setup

- [ ] Which `agav` to run. The `agav` in this doc means any build of this branch at commit e9ec5a97 or later.
  - Compiled binary: rebuild first, then run `~/cli/agav/dist/agav`:

    ```sh
    cd ~/cli/agav && git pull && pnpm run build:binary   # runs `node scripts/build-binary.mjs native`; needs bun
    ```

  - Node build: `pnpm build`, then `node ~/cli/agav/build/cli.js`.
  - So the doc's commands work verbatim, add `alias agav=~/cli/agav/dist/agav` (or a shell function) in every terminal you use.
  - Binaries built before e9ec5a97 fail every background run with `unknown flag --internal-workflow-runner`.
  - Sanity check: `agav workflows run <any simple workflow> --wait` should pass. While a run is going, `pgrep -af internal-workflow-runner` shows `.../agav --internal-workflow-runner <uuid>`.
- [ ] Isolate the data dir. It is `~/.agav`, and on Linux/macOS `HOME` is the only isolation knob (on Windows use `USERPROFILE`, see Running on Windows):

  ```sh
  export HOME=/tmp/wf-testing/home
  mkdir -p $HOME/.agav
  cat > $HOME/.agav/config.json <<'EOF'
  {"backgroundJobsEnabled":true,"workflowsEnabled":true,"permissionMode":"ask"}
  EOF
  ```

  M5 and M6 need provider credentials in that HOME. Either add `provider`, `model` and the API key to this `config.json`, or run those two scenarios with your real HOME (then runs land in your real `~/.agav/workflow-runs`).
- [ ] Use a workflow cwd that is **not** under `/tmp`. The sandbox mounts a tmpfs on `/tmp`, which fails with `bwrap: Can't chdir`:

  ```sh
  mkdir -p /var/tmp/wf-testing/.agav/workflows && cd /var/tmp/wf-testing
  ```

  All workflow files below go into `/var/tmp/wf-testing/.agav/workflows/`. Run `agav` from `/var/tmp/wf-testing`.
- [ ] Two different `.agav` directories are involved. Config, runs and jobs live under `$HOME/.agav` (`HOME=/tmp/wf-testing/home`), so `config.json` with the two gates (`backgroundJobsEnabled`, `workflowsEnabled`) must be in `$HOME/.agav/`. Workflow files are discovered from `./.agav/workflows` of the current directory (`/var/tmp/wf-testing`), so a `.agav` directory inside `/var/tmp/wf-testing` is right for those. Export `HOME` in every terminal you use, including terminals 2 and 3 in M4.
- [ ] Run everything in a real terminal. `agav workflows run` and the TUI consent need a TTY (`workflow run requires interactive consent` otherwise).
- [ ] Supervisors idle for about 5 minutes after their jobs finish. To list the ones belonging to this test HOME:

  ```sh
  pgrep -af supervisor/entry | grep /tmp/wf-testing
  ```

  To stop only those:

  ```sh
  pgrep -af supervisor/entry | grep /tmp/wf-testing | awk '{print $1}' | xargs -r kill
  ```

  Do not use a bare `pkill -f supervisor/entry`. It would also kill supervisors of your real HOME.
- [ ] Check the baseline: `agav workflows list` prints `No workflow runs.`

Each scenario has a Cleanup step that deletes its runs from the TUI (`d` on a finished run). To wipe everything instead: `rm -rf /tmp/wf-testing/home/.agav/workflow-runs`.

## Running on Windows

The compiled Node smoke test (`source/__tests__/workflows.windows.test.ts`) passes on a real Windows host: a consented runner executes a cmd job and a `run_command` tool in an isolated profile with spaces and Unicode in its paths. Real TTY, TUI and standalone-binary checks below remain manual; the automated consent stream is not a real terminal pass.

> **What to expect on Windows today**
>
> - Background runs use the background-jobs Windows fallback even though `nativeHelperAvailable=false`. A warning explains that workflow runners and job nodes run **unsandboxed**.
> - Docker is the only supported Windows sandbox override for an explicit `run_command` call (`input: { command: echo hello, sandbox: docker }`); Docker must be installed and usable. It does **not** sandbox the workflow runner or job nodes. Without an override, Windows `run_command` defaults to no sandbox.
> - No native Job Object helper is bundled. Process-tree ownership and descendant cleanup are **not guaranteed**; cancellation is not proof that all descendants are dead.
> - Consent, permission checks, opt-in gates and `sandboxRequired` remain intact. With `sandboxRequired`, fresh job nodes are refused; `run_command` must use an available sandbox such as explicit Docker or it refuses.
> - CLI order: TTY check, resolve/load/validate, availability warning, consent, then creation and launch. Denying consent creates no run. No `--foreground` fallback is needed or available.
> - POSIX shell examples must be translated for cmd; shell portability is not a Windows workflow launch prohibition.

### Windows setup

Use **Windows Terminal** with PowerShell for the main pass; repeat W4 in legacy conhost. cmd variants are given where simple.

- [ ] Build or install agav (needs Node >= 22.13.0; the binary build also needs `bun.exe`):

  ```powershell
  cd C:\path\to\agav; git pull
  pnpm run build:binary          # runs `node scripts\build-binary.mjs native` -> dist\agav.exe
  # or: pnpm build               # then run `node build\cli.js` (automated Windows Node smoke verified)
  ```

  `scripts\install.ps1` installs `agav.exe` into `%LOCALAPPDATA%\agav` and adds it to the user PATH. Use a fresh build that includes current Windows workflow support, rather than an older installed binary.
- [ ] Make `agav` resolve in every terminal you use:

  ```powershell
  function agav { & C:\path\to\agav\dist\agav.exe @args }      # PowerShell (put it in $PROFILE or paste per window)
  ```

  ```bat
  doskey agav=C:\path\to\agav\dist\agav.exe $*
  ```

- [ ] Isolate the data dir. The data dir is `<home>\.agav`; there is no `AGAV_HOME`. On Windows Node's `os.homedir()` reads `USERPROFILE`, **not** `HOME`, so setting `HOME` does nothing. Set `USERPROFILE` **before** starting agav, in a **dedicated terminal window** (changing it can break git, npm and ssh in that shell):

  ```powershell
  New-Item -ItemType Directory -Force C:\wf-testing\home | Out-Null
  $env:USERPROFILE = 'C:\wf-testing\home'
  node -e "console.log(require('os').homedir())"       # must print C:\wf-testing\home
  ```

  ```bat
  mkdir C:\wf-testing\home
  set USERPROFILE=C:\wf-testing\home
  node -e "console.log(require('os').homedir())"
  ```

  If the one-liner prints your real profile, stop and fix that first.
- [ ] Create `%USERPROFILE%\.agav\config.json` **without a BOM**. Windows PowerShell 5.1 `Out-File -Encoding utf8` and `Set-Content -Encoding UTF8` write a BOM. `config.json` is read with `readFile(..., "utf-8")` + `JSON.parse` inside a `try/catch {}` and no BOM strip, so a BOM file is probably **silently ignored** and the gates look off (UNVERIFIED on Windows; inferred from `loadGlobalConfig`).

  ```powershell
  $d = Join-Path $env:USERPROFILE '.agav'; New-Item -ItemType Directory -Force $d | Out-Null
  $noBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText("$d\config.json", '{"backgroundJobsEnabled":true,"workflowsEnabled":true,"permissionMode":"ask"}', $noBom)
  ```

  ```bat
  mkdir %USERPROFILE%\.agav
  echo {"backgroundJobsEnabled":true,"workflowsEnabled":true,"permissionMode":"ask"}> %USERPROFILE%\.agav\config.json
  ```

- [ ] Create the workflow cwd (spaces and Unicode are supported; this simple path keeps manual commands short):

  ```powershell
  New-Item -ItemType Directory -Force C:\wf-testing\.agav\workflows | Out-Null; cd C:\wf-testing
  ```

  Workflow files go in `C:\wf-testing\.agav\workflows\`. Prefer YAML. If you write JSON, save it **without a BOM** (same `WriteAllText` call) and write backslashes as `\\` inside JSON strings.
- [ ] Baseline: `agav workflows list` prints `No workflow runs.` (it creates `%USERPROFILE%\.agav\background-jobs`; that is fine).

### Command translation (only commands this doc uses)

| Doc (Unix) | PowerShell | cmd |
| --- | --- | --- |
| `export X=1`, or `X=1 cmd` | `$env:X = '1'` (stays for the session; `Remove-Item Env:X` to unset) | `set X=1` |
| `cat f` | `Get-Content f` | `type f` |
| `rm -f f` / `rm -rf d` | `Remove-Item -Force f -ErrorAction SilentlyContinue` / `Remove-Item -Recurse -Force d` | `del /q f` / `rmdir /s /q d` |
| `ls d` | `Get-ChildItem d` (a missing dir is an error here: it means nothing was created) | `dir d` |
| `mkdir -p d` | `New-Item -ItemType Directory -Force d` | `mkdir d` |
| `cp a b`, `touch f` | `Copy-Item a b`, `New-Item f -ItemType File -Force` | `copy a b` |
| `diff a b` | `Compare-Object (Get-Content a) (Get-Content b)` (no output = same) | `fc a b` |
| `jq .consent.envNames f` | `(Get-Content f -Raw \| ConvertFrom-Json).consent.envNames` (or install jq) | install jq |
| `grep -r pat d` | `Get-ChildItem d -Recurse -File \| Select-String pat` | `findstr /s /i pat d\*` |
| `pgrep -af internal-workflow-runner` | `Get-CimInstance Win32_Process \| Where-Object CommandLine -like '*internal-workflow-runner*' \| Select-Object ProcessId,CommandLine` | n/a |
| `kill <pid>` / `kill -9` | `Stop-Process -Id <pid>` / `Stop-Process -Id <pid> -Force` | `taskkill /pid <pid> /f` |
| `echo $?`, `echo "exit=$?"` | `$LASTEXITCODE` | `echo %ERRORLEVEL%` |
| `echo y \| agav ...` | `'y' \| agav workflows run x; "exit=$LASTEXITCODE"` | `echo y \| agav workflows run x` |
| `agav ... \| cat` | `agav ... \| Out-String` | `agav ... \| more` |
| `sleep N` (shell command) | `Start-Sleep N` (inside a workflow `cmd` job: `powershell -NoProfile -Command Start-Sleep N`) | `powershell -NoProfile -Command Start-Sleep N` |
| `printenv X` | `$env:X` | `echo %X%` |
| `/proc/<pid>/environ` | no equivalent: the M13 process check is Linux-only | n/a |
| `script`, pty drivers | Linux-only | n/a |
| `$(...)`, `seq`, `&&`, `>>`, heredocs (in workflow commands) | rewrite as cmd commands or explicitly invoke PowerShell; no automatic shell translation | n/a |

### Windows companions for M1–M13

Keep the Linux/macOS examples below unchanged; use these replacements on Windows. Run PowerShell from `C:\wf-testing` with the isolated `USERPROFILE` set in **every** terminal. Workflow `command:` fields run through cmd, not your interactive PowerShell. Save copied YAML/JSON and helper scripts without a BOM:

```powershell
$noBom = New-Object System.Text.UTF8Encoding $false
$text = @'
PASTE FILE TEXT HERE
'@
[System.IO.File]::WriteAllText("$PWD\.agav\workflows\NAME.yaml", $text, $noBom)
```

Replace `NAME` and the placeholder before executing. The closing `'@` starts its own line. Single-quoted here-strings preserve `${inputs...}`, `${nodes...}`, `${loop.index}` and quotes literally; do not use an interpolating `@"` here-string. Use the same writer with a `.json` or helper-script path as appropriate.

#### M1–M4: inputs, cancellation, keys and app restart

- **M1:** replace the `greet` command with `command: echo hello & powershell -NoProfile -Command "Start-Sleep -Seconds 4"` (keep the inputs and `write` node). Set `$env:WF_SECRET_A = 'aaa'; $env:WF_SECRET_B = 'bbb'`. Consent must show the Windows cwd and replacement command, not the POSIX text. Check output with `Get-Content .\m1-out.txt`. Check selected names and scan for fake values:

  ```powershell
  $wr = Join-Path $env:USERPROFILE '.agav\workflow-runs'
  Get-ChildItem "$wr\*.json" | ForEach-Object { (Get-Content $_.FullName -Raw | ConvertFrom-Json).consent.envNames }
  Get-ChildItem $wr -Recurse -File | Select-String -Pattern 'aaa|bbb'
  ```

  The scan should print nothing. Cleanup: `Remove-Item .\m1-out.txt`; after the checklist tests, `Remove-Item Env:WF_SECRET_A,Env:WF_SECRET_B`.
- **M2:** in `m2-gate.json` use `"command": "powershell -NoProfile -Command Start-Sleep -Seconds 300"`. Approval JSON needs no command change. After cancel inspect test-owned processes using M11 below instead of `pgrep sleep`. A `cancelled` checkpoint does **not** guarantee descendant cleanup on Windows; record survivors separately. After deny, `Test-Path .\m2-out.txt` must be `False`; after approve, `Get-Content .\m2-out.txt` prints `shipped`.
- **M3:** save this complete Windows `m3-long.yaml` with the BOM-free writer:

  ```yaml
  version: 1
  name: m3-long
  nodes:
    - id: a
      type: job
      command: for /L %i in (1,1,80) do @echo line %i
    - id: b
      type: job
      dependsOn: [a]
      command: echo done-b
  ```

  Use **single `%i`**: this goes directly to `cmd /c`. `%%i` is only for a `.bat`/`.cmd` file and is wrong here. Logs must show `line 1` through `line 80`. Replace the two `sed` edits and `head -5` with:

  ```powershell
  $f = Join-Path $PWD '.agav\workflows\m1-inputs.yaml'
  $text = [System.IO.File]::ReadAllText($f)
  [System.IO.File]::WriteAllText($f, ($text -replace '(?m)^version: 1(?=\r?\n|\z)', 'version: 2'), $noBom)
  # Check invalid state, then restore:
  $text = [System.IO.File]::ReadAllText($f)
  [System.IO.File]::WriteAllText($f, ($text -replace '(?m)^version: 2(?=\r?\n|\z)', 'version: 1'), $noBom)
  Get-Content $f -TotalCount 5   # after TUI edit: verify comment and description
  ```

- **M4:** in `m4-wait.json` use `"command": "powershell -NoProfile -Command \"Start-Sleep -Seconds 40; Write-Output finished\""`. In each new terminal run `$env:USERPROFILE = 'C:\wf-testing\home'; Set-Location C:\wf-testing` before agav. Repeat close/reopen and one-time notification checks unchanged.

#### M5–M7: credentials and native argument quoting

M5/M6 need credentials in the isolated profile. M7 definitions need no shell changes; use `Get-Content` and `Get-ChildItem` for transcripts and retain A2A limitations.

**M5:** PowerShell 5.1 can strip JSON quotes from native arguments. Use stop-parsing `--%` with an **executable**, not the `agav` PowerShell function. Verify the actual native argument first:

```powershell
node --% -e "console.log(JSON.parse(process.argv[1]).city)" {\"city\":\"Tokyo\"}
# Must print Tokyo, not a JSON parse error.
C:\path\to\agav\dist\agav.exe --% workflows run m5-agent --input {\"city\":\"Tokyo\"} --wait
$LASTEXITCODE
Get-Content .\m5-out.txt   # Japan
Get-ChildItem "$env:USERPROFILE\.agav\workflow-runs\<full-run-id>\artifacts"
```

For Node use `node --% C:\path\to\agav\build\cli.js workflows run m5-agent --input {\"city\":\"Tokyo\"} --wait`. Keep each `--%` invocation on one line, without a trailing semicolon/pipe; check exit status on the next line. Variables do not expand after `--%`.

**M6:** keep `rm -rf /var/tmp/wf-testing-does-not-exist` **verbatim** in the prompt. It tests the destructive-command block **before shell execution**. Do not translate it to `Remove-Item`, `del` or `rmdir`: expect refusal without an inbox decision, not a cmd “command not found” error. Observe with `Get-ChildItem .\m6-*.txt` and `Get-Content .\m6-a.txt`. Cleanup only test files: `Remove-Item .\m6-*.txt -Force -ErrorAction SilentlyContinue`.

#### M8: executable checks and fix helpers

Create these scripts in the test cwd. The check explicitly exits `1` on missing/nonmatching content; printing a Boolean does **not** set a failing native exit code.

```powershell
$check = @'
param([string]$Path = 'm8-target.txt', [int]$DelaySeconds = 0)
$ErrorActionPreference = 'Stop'
try {
    if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { exit 1 }
    if ([System.IO.File]::ReadAllText((Join-Path $PWD $Path)) -notmatch 'ok') { exit 1 }
    exit 0
} catch { [Console]::Error.WriteLine($_); exit 1 }
'@
$fix = @'
$ErrorActionPreference = 'Stop'
try {
    $n = 0
    if (Test-Path -LiteralPath 'm8-count') { $n = [int][System.IO.File]::ReadAllText("$PWD\m8-count") }
    $n++
    $encoding = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText("$PWD\m8-count", [string]$n, $encoding)
    $value = if ($n -ge 2) { 'ok' } else { 'bad' }
    [System.IO.File]::WriteAllText("$PWD\m8-target.txt", $value, $encoding)
    exit 0
} catch { [Console]::Error.WriteLine($_); exit 1 }
'@
[System.IO.File]::WriteAllText("$PWD\m8-check.ps1", $check, $noBom)
[System.IO.File]::WriteAllText("$PWD\m8-fix.ps1", $fix, $noBom)
Remove-Item .\m8-count,.\m8-target.txt,.\m8-attempt.txt,.\m8-never.txt -Force -ErrorAction SilentlyContinue
```

Apply these exact YAML replacements, retaining indentation, dependencies, `when`, loop settings and `continueOnError`:

| File / node | Replacement YAML line |
| --- | --- |
| `m8-fix-until-pass` / `test.input` | `command: powershell -NoProfile -ExecutionPolicy Bypass -File .\m8-check.ps1 -Path m8-target.txt -DelaySeconds 20` |
| `m8-fix-until-pass` / `fix.input` | `command: powershell -NoProfile -ExecutionPolicy Bypass -File .\m8-fix.ps1` |
| `m8-unfixable` / `test.input` | `command: powershell -NoProfile -ExecutionPolicy Bypass -File .\m8-check.ps1 -Path m8-never.txt` |
| `m8-fix-agent` / `test.input` | `command: powershell -NoProfile -ExecutionPolicy Bypass -File .\m8-check.ps1 -Path m8-target.txt` |
| `m8-fix-job` / job `test` | `command: powershell -NoProfile -ExecutionPolicy Bypass -File .\m8-check.ps1 -Path m8-target.txt` |
| `m8-fix-job` / `fix.input` | `command: powershell -NoProfile -ExecutionPolicy Bypass -File .\m8-fix.ps1` |

`Bypass` applies only to these helper processes; organizational policy may still block it. Preflight: `powershell -NoProfile -ExecutionPolicy Bypass -File .\m8-check.ps1` must return `$LASTEXITCODE` = `1`. Invoke `powershell -NoProfile -ExecutionPolicy Bypass -File .\m8-fix.ps1` twice, then the check: exit `0`, count `2`. **Reset** count/target/attempt before the main run and again before the job variant; remove only target before the agent variant. Keep `m8-never.txt` missing. Agent prompt and unfixable `write_file` need no changes.

Observe with `Get-Content .\m8-count`, `Get-Content .\m8-target.txt`, `Get-Content .\m8-attempt.txt`. List specs with `Get-ChildItem "$env:USERPROFILE\.agav\background-jobs\specs" | Where-Object Name -match 'test-1_i'`. A pure tool variant need not have a child-job supervisor: use status for continued execution and M11 for process checks. Cleanup also removes `m8-check.ps1` and `m8-fix.ps1`.

#### M9–M10: checkpoint edit and line counts

**M9 step 2:** close the TUI; wait until `arm` is parked **and its runner has exited**. Never edit an active checkpoint. This PowerShell-invoked Node edit avoids PowerShell JSON depth/type conversion and uses BOM-free UTF-8, a same-directory temp file and rename. Replace `ID8`:

```powershell
$wr = Join-Path $env:USERPROFILE '.agav\workflow-runs'
$files = @(Get-ChildItem "$wr\ID8*.json")
if ($files.Count -ne 1) { throw 'Expected exactly one checkpoint' }
$f = $files[0].FullName
$edit = @'
const fs = require('node:fs');
const f = process.argv[2], tmp = f + '.tmp';
const run = JSON.parse(fs.readFileSync(f, 'utf8'));
if (run.status !== 'waiting_approval') throw Error('Run must be parked');
console.log('before', JSON.stringify(run.consent.capabilities));
run.consent.capabilities.tools = [];
fs.writeFileSync(tmp, JSON.stringify(run), {encoding: 'utf8', flag: 'wx'});
fs.renameSync(tmp, f);
console.log('after', JSON.stringify(run.consent.capabilities));
'@
$edit | node - $f
if ($LASTEXITCODE -ne 0) { throw 'Edit failed; inspect checkpoint/temp file before approving' }
Test-Path "$f.tmp"   # False
agav workflows status ID8
```

Only approve `arm` after status still prints the tree. Keep hashes, cwd, other consent fields and definition untouched. At the end `(Get-ChildItem "$wr\<full-run-id>\decisions" -File | Where-Object Name -match 'decided').Count` must be `5`.

**M10:** `echo round >> m10-rounds.txt` works in cmd; keep it. Replace `wc -l` with `@(Get-Content .\m10-rounds.txt).Count` (expect `1`, then `2`, then `3`). Before starting and after deny, `Test-Path .\m10-rounds.txt` must be `False`; reset with `Remove-Item .\m10-rounds.txt -ErrorAction SilentlyContinue`.

#### M11: delays and safe process observations

Use `command: powershell -NoProfile -Command "Start-Sleep -Seconds 30"` for `m11-tool-timeout`, and `command: powershell -NoProfile -Command "Start-Sleep -Seconds 300"` for `m11-job-timeout` and `m11-deadline`. Leave approval definitions alone, including the invalid one. Exit checks: `agav workflows validate m11-approval-timeout; "exit=$LASTEXITCODE"` (similarly for `run`).

Capture a baseline before M2/M11/M13, then compare in the same observation terminal:

```powershell
$beforePids = @(Get-CimInstance Win32_Process | Select-Object -ExpandProperty ProcessId)
# During the test, and again after cancellation/timeout:
Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -notin $beforePids -and
    ($_.CommandLine -like '*Start-Sleep*' -or $_.CommandLine -like '*internal-workflow-runner*')
} | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine
```

This is a **candidate list, not proof of ownership**. Cross-check runner UUID, child job id/PID from status and `/job list`, creation time and parent chain. Never kill all PowerShell/Node/agav processes or all `Start-Sleep` matches. Stop a surviving test job with `/job stop <jobId>` first; if needed recheck PID/creation time before `Stop-Process -Id <verified-test-pid>`. No Job Object descendant-cleanup guarantee exists. Record survivors as a Windows limitation, not proof cleanup is safe; timeout states and approval validation must still match M11. OS-specific error suffixes may differ. Read the deadline event with `Get-Content "$env:USERPROFILE\.agav\workflow-runs\<full-run-id>\events.jsonl" -Tail 1`.

#### M12: retention from PowerShell

Use only the isolated profile, close the TUI, and age only finished runs or a fully parked run whose runner has exited. YAML needs no changes. Set `$A`, `$C`, `$P` to the **full UUIDs** from M12 step 2:

```powershell
$wr = Join-Path $env:USERPROFILE '.agav\workflow-runs'
function Age-WorkflowCheckpoint {
    param([string]$Path, [double]$Days)
    $js = @'
const fs = require('node:fs');
const f = process.argv[2], days = Number(process.argv[3]), tmp = f + '.tmp';
if (!Number.isFinite(days)) throw Error('Invalid age');
const text = fs.readFileSync(f, 'utf8');
const aged = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
  s => new Date(Date.parse(s) - days * 86400000).toISOString());
JSON.parse(aged);
fs.writeFileSync(tmp, aged, {encoding: 'utf8', flag: 'wx'});
fs.renameSync(tmp, f);
'@
    $js | node - $Path $Days
    if ($LASTEXITCODE -ne 0) { throw 'Aging failed; inspect checkpoint/temp file before continuing' }
}
New-Item -ItemType File "$wr\$A.cancel" -Force | Out-Null
$notification = @(Get-ChildItem "$wr\_mailbox\*.json" | Where-Object {
    [System.IO.File]::ReadAllText($_.FullName).Contains($A)
} | Select-Object -First 1)
if ($notification.Count -ne 1) { throw 'No notification for A' }
$seen = [System.IO.Path]::ChangeExtension($notification[0].FullName, '.seen')
New-Item -ItemType File $seen -Force | Out-Null
Get-ChildItem $wr,"$wr\_mailbox"
Age-WorkflowCheckpoint "$wr\$A.json" 10
Age-WorkflowCheckpoint "$wr\$C.json" 6
Age-WorkflowCheckpoint "$wr\$P.json" 10
(Get-Content "$wr\$A.json" -Raw | ConvertFrom-Json) | Select-Object createdAt,updatedAt
agav workflows status ($A.Substring(0,8))   # still passed; does not prune
agav workflows list                       # only C and P; no reconcile warning
Test-Path "$wr\$A.json"; Test-Path "$wr\$A"; Test-Path "$wr\$A.cancel"; Test-Path $seen
# All four False; no matching notification:
Get-ChildItem "$wr\_mailbox\*.json" | Select-String -SimpleMatch $A
Test-Path "$wr\$C.json"; Test-Path "$wr\$C"; Test-Path "$wr\$P.json"; Test-Path "$wr\$P"
# All four True; P's inbox decision remains:
agav workflows inbox
agav workflows status ($P.Substring(0,8))
Age-WorkflowCheckpoint "$wr\$C.json" 2
agav workflows list                       # only P remains
Test-Path "$wr\$C.json"; Test-Path "$wr\$C"   # both False
Get-ChildItem "$wr\_mailbox\*.json" | Select-String -SimpleMatch $C   # no matches
Get-ChildItem "$wr\*.tmp"                  # no leftovers
```

Confirm P's checkpoint, directory and inbox remain after the boundary check. Cleanup: `agav workflows deny ($P.Substring(0,8)) gate`, delete the finished run in the TUI, then `Remove-Item Function:Age-WorkflowCheckpoint; Remove-Variable A,C,P,wr,notification,seen`. Never age while another writer is active.

#### M13: selected environment names

Set `$env:FAKE_SECRET = 's3cr3t-m13'` (cmd: `set FAKE_SECRET=s3cr3t-m13`). Replace **both** `printenv ...` commands with:

```yaml
      command: if defined FAKE_SECRET (echo %FAKE_SECRET%) else (echo absent)
```

For `tool-env` keep this under `input:`; for `job-env` indent at the job's `command:` level. For `hold` use `command: powershell -NoProfile -Command "Start-Sleep -Seconds 90"`. An absent cmd variable can otherwise print literally as `%FAKE_SECRET%`; `if defined` makes observations unambiguous. Record actual tool/job outputs with the selected name and again with `none`; do not infer inheritance from the launching shell. `/proc` runner/hold environment inspection remains **Linux-only**, not verified on Windows.

Scan with `Get-ChildItem "$env:USERPROFILE\.agav" -Recurse -File | Select-String -SimpleMatch 's3cr3t-m13'`. If a node inherits and prints it, outputs/artifacts may persist it: record that result/leak rather than assuming a clean scan. Cancel, inspect only test-owned descendants as in M11, delete runs, then `Remove-Item Env:FAKE_SECRET` (cmd: `set FAKE_SECRET=`).

### Scenario matrix

| Scenario | Windows | What to do |
| --- | --- | --- |
| M1 | Run with adaptations | Use `echo hello` for the job; check inputs, consent and output. |
| M2 | Run with adaptations | Use a PowerShell delay; inspect test-owned processes after cancel (no descendant-cleanup guarantee). |
| M3 | Run with adaptations | Replace the POSIX loop with a cmd `for /L` loop; validate, edit, logs and re-run are available. |
| M4 | Run with adaptations | Use a PowerShell delay; set the same test `USERPROFILE` in both terminals. |
| M5, M6 | Run with credentials | Configure credentials in the isolated profile; translate shell commands. |
| M7 | Run | Validate and run; retain the documented A2A limitation. |
| M8-M11 | Run with adaptations | Translate POSIX commands; do not assume Job Object ownership during recovery/cancel. |
| M12 | Run | Create finished runs first, then test retention. |
| M13 | Partial | Translate env commands; `/proc` environment inspection remains Linux-only. |
| M14 | **Run W1 instead** | Missing-helper refusal now applies only to non-Windows hosts. |
| M15 | **Run W2** | Gates and no-TTY refusal remain unchanged. |

### W1. Consented background execution (Windows replacement for M14)

**Goal:** CLI, slash command and TUI launch a consented background workflow, warn honestly, and respect denial of consent.

**Prerequisites:** setup above with `sandboxRequired` unset or false. Save `.agav/workflows/m14-any.yaml` without a BOM:

```yaml
version: 1
name: m14-any
nodes:
  - id: job
    type: job
    command: echo windows-job-ok
  - id: shell
    type: tool
    dependsOn: [job]
    tool: run_command
    input:
      command: echo windows-shell-ok
```

**Steps:**

1. - [ ] `agav workflows validate m14-any` prints `Workflow valid.`
2. - [ ] In a real terminal: `agav workflows run m14-any --wait`. Before consent, stderr warns that runners and job nodes are unsandboxed, Docker applies only to `run_command`, and Job Object ownership/descendant cleanup are not guaranteed. It must not print a Windows missing-helper refusal.
3. - [ ] Select `none` for env names and answer `y`. A run id is printed; both `job` and `shell` reach `passed`; `$LASTEXITCODE` is `0`. `agav workflows status <id8>` includes `windows-job-ok` and `windows-shell-ok` in node outputs.
4. - [ ] Repeat, but answer `n` at final consent. Exit code is `1`; `workflows list` has no new run. A warning alone is not consent.
5. - [ ] Slash command: start `agav`, type `/workflows run m14-any`. The consent checklist opens; approve it and confirm the run passes in `/workflows status <id8>`.
6. - [ ] TUI: select `m14-any`, press `R`, approve consent, and watch Runs reach `passed` without manual refresh. Repeat with `n`/ESC at consent and confirm no new run. The warning goes to stderr; check its visibility within the interactive layout manually.
7. - [ ] Repeat in a test cwd/profile with spaces and Unicode. Confirm checkpoints and output are readable. Record Node build versus standalone binary separately.
8. - [ ] Policy check: enable `sandboxRequired` in the test config and launch again with consent. The job node must refuse, not silently run unsandboxed. In a separate tool-only workflow, a default `run_command` must refuse; an explicit `sandbox: docker` call may pass only with usable Docker. Restore the config afterwards. Docker does not protect job nodes or the runner.

**Expected:** consented execution succeeds with the warning; denial creates nothing; required sandboxing fails closed. Automated Node smoke coverage does not verify the real TUI or Docker.

**Failure signal:** missing-helper refusal on Windows; execution without consent; missing warning; false sandbox/Job Object guarantees; `sandboxRequired` bypassed; failed nodes reported as passed.

**Cleanup:** delete finished runs from the TUI. Cancel only test-owned active runs and inspect their processes before removing the test profile; descendant cleanup is not guaranteed.

### W2. Gates and no-TTY (M15 on Windows)

**Goal:** the two gates and the no-TTY refusal behave as in M15; nothing is started.

**Prerequisites:** setup above, `.agav\workflows\m15-ok.yaml` (as in M15, `command: echo m15`, written without a BOM), and a copy of the good config: `Copy-Item $env:USERPROFILE\.agav\config.json $env:USERPROFILE\.agav\config.json.good`.

**Steps:**

1. - [ ] `workflowsEnabled:false` (write the config with the `WriteAllText` snippet, no BOM): `agav workflows list`, `run m15-ok` and `validate m15-ok` each print `error: Workflows require backgroundJobsEnabled=true AND workflowsEnabled=true.` and exit `1`.
2. - [ ] `backgroundJobsEnabled:false`: the same message.
3. - [ ] Restore with `Copy-Item ...config.json.good ...config.json`; `agav workflows list` works again.
4. - [ ] `Get-ChildItem $env:USERPROFILE\.agav\workflow-runs -ErrorAction SilentlyContinue > C:\wf-testing\before.txt`, then `'y' | agav workflows run m15-ok; "exit=$LASTEXITCODE"` prints `error: workflow run requires interactive consent` and `exit=1`. (The TTY check still comes before availability and consent.)
5. - [ ] `agav workflows run m15-ok | Out-String` prints the same error and nothing on stdout.
6. - [ ] Repeat the `Get-ChildItem` into `after.txt`; `Compare-Object (Get-Content C:\wf-testing\before.txt) (Get-Content C:\wf-testing\after.txt)` prints nothing. No new test-owned `internal-workflow-runner` process (use the process query in Command translation and compare with the baseline).
7. - [ ] `'y' | agav workflows run x` prints the same `requires interactive consent` error.

**Expected / Failure signal:** as M15. A gate that seems ignored with a BOM config: check the BOM first (setup).

**Cleanup:** `Remove-Item C:\wf-testing\before.txt,C:\wf-testing\after.txt,$env:USERPROFILE\.agav\config.json.good`; make sure both gates are `true` again.

### W3. Validate and discovery, including BOM and CRLF

**Goal:** `workflows validate` works without a runner, and the BOM/CRLF behaviour is recorded.

**Prerequisites:** setup above. Create four files in `.agav\workflows`:

```powershell
$bom = New-Object System.Text.UTF8Encoding $true
$yaml = "version: 1`r`nname: w3-bom-yaml`r`nnodes:`r`n  - id: hello`r`n    type: tool`r`n    tool: run_command`r`n    input:`r`n      command: echo hello`r`n"
$json = '{"version":1,"name":"w3-bom-json","nodes":[{"id":"hello","type":"tool","tool":"run_command","input":{"command":"echo hello"}}]}' + "`r`n"
[System.IO.File]::WriteAllText("$PWD\.agav\workflows\w3-bom-yaml.yaml", $yaml, $bom)
[System.IO.File]::WriteAllText("$PWD\.agav\workflows\w3-bom-json.json", $json, $bom)
[System.IO.File]::WriteAllText("$PWD\.agav\workflows\w3-bad.yaml", "version: 1`nname: w3-bad`nnodes:`n  - id: x`n    type: bogus`n", (New-Object System.Text.UTF8Encoding $false))
```

**Steps:**

1. - [ ] `agav workflows validate m14-any` prints `Workflow valid.`
2. - [ ] `agav workflows validate w3-bad` prints an `error:` line naming the problem (the unknown node type) and exits `1`; never `Workflow valid.`
3. - [ ] `agav workflows validate w3-bom-yaml` prints `Workflow valid.` (BOM + CRLF YAML is accepted).
4. - [ ] `agav workflows validate w3-bom-json` fails with a JSON parse error and exit `1`. This is the **current behaviour**, not the wanted one: `loadDefinition` does not strip a BOM (listed under follow-ups). The exact message text is UNVERIFIED on Windows. A CRLF-only JSON file (no BOM) is expected to pass; the definition hash is the same as with LF.
5. - [ ] In the TUI Workflows tab all valid definitions are listed; press `v` on one: it validates.

**Expected:** steps 1, 3 pass; 2 and 4 fail with a clear message.

**Failure signal:** a stack trace; `w3-bom-json` validates (then the BOM was fixed: update this doc); `w3-bad` validates.

**Cleanup:** `Remove-Item .\.agav\workflows\w3-*`.

### W4. TUI rendering at 80x24

**Goal:** the TUI is usable at 80x24 in Windows Terminal and in legacy conhost (`conhost.exe`, e.g. `cmd` opened from Win+R).

**Steps:**

1. - [ ] Resize to 80x24 (conhost: Properties > Layout; Windows Terminal: drag until the size is shown). Start `agav`, open the workflows view. Three tabs render (Workflows, Runs, Inbox) and Tab switches between them.
2. - [ ] The Workflows tab lists `m14-any`. The Runs tab shows W1 runs, or its empty state if they were deleted. The Inbox shows `No pending decisions.`
3. - [ ] Footers wrap or truncate without overlapping the list.
4. - [ ] Glyphs: `✓ ✗ ● ◐ ⊘ ⏱ ↷ …` and the `│` separator are legible. They have no ASCII fallback. Windows Terminal is expected to be fine; `⏱` and `⊘` may render as boxes or `?` in conhost (UNVERIFIED). Record the font and host.

**Expected:** a usable layout in Windows Terminal. In conhost, bad glyphs are a known gap (follow-ups), not a test failure; record them.

**Failure signal:** overlapped or garbled layout, a crash on resize, keys not working.

### W5. Empty store, list, status, inbox, Ctrl+C

**Steps:**

1. - [ ] After deleting finished test runs so the store is empty: `agav workflows list` prints `No workflow runs.`; `agav workflows inbox` prints `No pending workflow decisions.` and exits `0`; `agav workflows status 00000000` fails with an `error:` line (the exact text is UNVERIFIED) and no stack trace.
2. - [ ] `Test-Path $env:USERPROFILE\.agav\background-jobs` is `True` after `list` (it creates the dir; fine). Reconcile problems may print as warnings only.
3. - [ ] Ctrl+C in the open TUI exits it cleanly: the prompt returns, the cursor is visible and the console is not left in raw mode (typed characters echo again). `Get-CimInstance Win32_Process | Where-Object CommandLine -like '*agav*'` shows no leftover `agav` started by this test (UNVERIFIED on Windows).

**Expected:** clean empty states and a clean exit.

**Failure signal:** a stack trace, a hung terminal, an orphan process, no echo after exit.

### Windows follow-ups (code)

- Native Job Object ownership and reliable descendant cleanup remain unavailable; inspect test-owned processes after cancellation or forced termination.
- Probable bug: `loadDefinition` does not strip a UTF-8 BOM, so JSON workflows saved by PowerShell 5.1 fail to parse (YAML is fine). Strip `\uFEFF` before `JSON.parse`. The same holds for `config.json` (silently ignored).
- The example workflows in this doc are POSIX shell (`seq`, `$(...)`, `sleep`, `&&`, `>>`, `printenv`); run_command nodes use `cmd.exe /d /s /c` on win32 and `job` nodes with `command` default to `cmd`. Translate these commands before running the examples on Windows.
- Windows has no default OS sandbox. Explicit Docker can sandbox `run_command` only; `sandboxRequired` still refuses unsandboxed calls and fresh job starts.
- `createExclusive` uses `fs.link` with no `EPERM` retry (unlike `writeAtomic`): it fails closed with storage-unavailable on FAT/exFAT, some ReFS setups and network shares (UNVERIFIED).
- Checkpoints pin the cwd with strict `!==` after `realpath`; no drive-letter or case normalisation (UNVERIFIED how `realpath` cases on NTFS).
- Status glyphs have no ASCII fallback (`format.ts`).
- The data dir has no override (`AGAV_HOME`) and reads `homedir()` at module load, which forces the `USERPROFILE` trick above.

## M1. TUI run flow

**Goal:** Run a workflow with typed inputs from the TUI, through the input form and the consent screen, and watch it finish.

**Prerequisites:** `.agav/workflows/m1-inputs.yaml`

```yaml
# m1-inputs.yaml: comments here must survive M3 edits
version: 1
name: m1-inputs
description: Typed inputs demo
inputs:
  who: { type: string, required: true, description: Who to greet }
  times: { type: number, default: 2 }
nodes:
  - id: greet
    type: job
    command: echo "hello"; sleep 4
  - id: write
    type: tool
    dependsOn: [greet]
    tool: write_file
    input: { path: m1-out.txt, content: "hi ${inputs.who} x${inputs.times}" }
```

Also export a few env vars so the checklist has entries: `export WF_SECRET_A=aaa WF_SECRET_B=bbb`.

**Steps:**

1. - [ ] Start `agav` in `/var/tmp/wf-testing`, type `/workflows`, Enter. The tab bar reads `Workflows │ Runs │ Inbox`; `m1-inputs  [project]` is listed.
2. - [ ] Select `m1-inputs`, press `R`. The `Run m1-inputs · Inputs` form shows `who` (hint `string · required · Who to greet`) and `times` (hint `number · default 2`).
3. - [ ] Press Enter with `who` empty. The form stays and shows `who is required.`
4. - [ ] Type `bob`. Press Tab to go to `times`, type `abc`, press Enter. It shows `times must be a number.` Clear it (Backspace) so it is empty (the default applies).
5. - [ ] Press Enter. The consent screen shows: `Run workflow "m1-inputs" in the background?`, `Directory: /var/tmp/wf-testing`, `Permission mode: ask`, `Tools: write_file`, `$ echo "hello"; sleep 4`, and the env checklist `(0/N selected; names only, values are never stored)`.
6. - [ ] Checklist keys: `↓` moves the `❯` cursor; Space toggles `[x]` on `WF_SECRET_A` only (`1/N`); `a` selects all (`N/N`); `x` deselects all (`0/N`); Space on `WF_SECRET_B` only gives `1/N`.
7. - [ ] Press Enter (or `y`). The view switches to the Runs tab with a notice `Workflow run <uuid> (m1-inputs) started · status: /workflows status <id> · cancel: /workflows cancel <id>`.
8. - [ ] Watch the new run (top row). The status text updates by itself about once per second: `running · started Ns ago · 0/2 nodes`, then `passed · Ns · 2/2 nodes`. Do not press `r`.
9. - [ ] In a second shell: `cat /var/tmp/wf-testing/m1-out.txt` prints `hi bob x2`.
10. - [ ] Repeat steps 2-5, then at the consent screen press `n` (or ESC). The Workflows tab shows `Workflow run not approved.` and no new run exists.
11. - [ ] Verify only the chosen names were stored: `jq .consent.envNames $HOME/.agav/workflow-runs/*.json` lists exactly the names you selected, and `grep -r "aaa\|bbb" $HOME/.agav/workflow-runs` prints nothing.

**Expected:** every screen text matches above; the run reaches `passed` without a manual refresh; `m1-out.txt` holds `hi bob x2`.

**Failure signal:** the form accepts an empty required field or a non-number; selection counts differ from the key pressed; the Runs row stays at `running` until you press `r`; secret values appear anywhere under `$HOME/.agav`.

**Cleanup:** on the Runs tab select the finished run, press `d`, then `y`. `rm /var/tmp/wf-testing/m1-out.txt`.

## M2. TUI cancel, deny and the status bar badge

**Goal:** Cancel a running run, and approve or deny parked approvals from the Runs tab and the Inbox tab; check the status bar badge.

**Prerequisites:** `.agav/workflows/m2-gate.json`

```json
{
  "version": 1,
  "name": "m2-gate",
  "description": "Long job, or approval gates",
  "nodes": [
    { "id": "slow", "type": "job", "command": "sleep 300" }
  ]
}
```

and `.agav/workflows/m2-approve.json`

```json
{
  "version": 1,
  "name": "m2-approve",
  "nodes": [
    { "id": "gate", "type": "approval", "prompt": "Ship it?" },
    { "id": "after", "type": "tool", "dependsOn": ["gate"], "tool": "write_file", "input": { "path": "m2-out.txt", "content": "shipped" } }
  ]
}
```

**Steps:**

1. - [ ] Cancel. In `agav` run `/workflows`, `R` on `m2-gate`, Enter at consent (no env). On the Runs tab select the run (`running`) and press `x`. The confirm line reads `Cancel "<title>"? The run's runner and jobs are stopped. y: Confirm · n/ESC: Cancel`. Press `n`: nothing changes. Press `x` then `y`: the status line shows `Cancel done.` or `Workflow run <id>: cancelled`, and within a few seconds the row shows `cancelled`.
2. - [ ] `pgrep -af "sleep 300"` prints nothing (the job is gone).
3. - [ ] Park an approval. Start `m2-approve` (`R`, Enter). Within a few seconds the Runs row shows `waiting_approval · … · ◐ waiting: gate`. The tab label shows `Inbox (1)`.
4. - [ ] Badge. Leave the TUI (ESC) so the main prompt shows. Within about 5 s the status bar shows `workflows: 1 need approval` (while a run is running it reads `workflows: 1 running · 1 need approval`). A one-time notification `Run <id8> waiting for approval: gate` is shown.
5. - [ ] Deny from Runs. Back in `/workflows`, Runs tab, select the parked run, press `D`. A confirm screen shows `Deny approval on gate (run <id8>)? y: Approve · n/ESC: Deny` plus the decision details (`Run:`, `Directory:`, `Permission mode:`, `Decision:`, `Ship it?`). The footer wording is shared with approve: here `y` confirms the **deny**, and `n`/ESC leaves the decision pending (status line `Not decided.`). Press `n` first and check the run is still `waiting_approval`. Press `D`, then `y`: the status line reads `approval on gate denied (…)`, the run ends `failed`, and `ls m2-out.txt` fails.

   > Note: `y` means "go ahead with the action you chose" (deny for `D`, approve for `a`). `n`/ESC aborts and leaves the decision pending.
6. - [ ] Approve from Runs. Start `m2-approve` again, wait for `waiting_approval`, select it, press `a`, `y`. The status line shows `approval on gate approved (…); runner running (attempt 2)` or similar. The run becomes `passed`; `cat m2-out.txt` prints `shipped`. `rm m2-out.txt`.
7. - [ ] Inbox approve. Start `m2-approve` again. Switch with Tab until the tab bar's active tab is `Inbox`. The item `◐ gate · m2-approve <id8>` is listed; Enter shows the full detail. Press `a` then `y`. The item disappears (`No pending decisions.`), and the run is `passed` on the Runs tab.
8. - [ ] Inbox deny. Start `m2-approve` again, go to Inbox, press `D` then `y`. The item disappears; the run is `failed`.
9. - [ ] Badge update. With one parked run left (start another and leave it), the badge shows `workflows: 1 need approval`. Decide it; within about 5 s the badge disappears (no workflow text) once nothing runs or waits.

**Expected:** all texts as above; badge changes within about 5 s; denied runs fail, approved runs pass; a run is never decided twice.

**Failure signal:** `x` cancels without a confirm; the `sleep 300` process survives; the badge stays stale for more than about 10 s; the Inbox item stays after a decision; `m2-out.txt` exists after a deny.

**Cleanup:** delete finished runs with `d`, `y`. Cancel any leftover run with `x`, `y`.

## M3. Other TUI keys

**Goal:** `v`, `e`, `l`, `R`, `u`, `d`, detail scrolling, Tab order and footers.

**Prerequisites:** the `m1-inputs.yaml` file from M1 (unchanged), and `.agav/workflows/m3-long.yaml`:

```yaml
version: 1
name: m3-long
nodes:
  - id: a
    type: job
    command: for i in $(seq 1 80); do echo "line $i"; done
  - id: b
    type: job
    dependsOn: [a]
    command: echo done-b
```

**Steps:**

1. - [ ] Tab order. In `/workflows` press Tab three times. The tabs cycle Workflows → Runs → Inbox → Workflows. The footer's Tab hint names the next tab (`Tab: Runs` on Workflows, `Tab: Inbox` on Runs, `Tab: Workflows` on Inbox).
2. - [ ] Validate. On Workflows select `m1-inputs`, press `v`. The status line reads `Workflow m1-inputs is valid.` Then in another shell break the file: `sed -i 's/^version: 1/version: 2/' .agav/workflows/m1-inputs.yaml`. Press `r`. The item shows `(invalid)`. `R` is not offered for it. Press `v`: the error text mentions `version`. Restore with `sed -i 's/^version: 2/version: 1/' .agav/workflows/m1-inputs.yaml` and press `r`.
3. - [ ] Edit. Select `m1-inputs`, press `e`. The form shows `Name`, `Description` and `Inputs (JSON object, empty for none)`. Tab moves between fields. Change the description to `Edited in TUI`, press Enter. The status reads `Saved. Edit (e) changes name, description and inputs only.`
4. - [ ] Check the file: `head -5 .agav/workflows/m1-inputs.yaml` still starts with the `# m1-inputs.yaml: comments here must survive M3 edits` comment and has `description: Edited in TUI`. `agav workflows validate m1-inputs` prints a valid result.
5. - [ ] Edit error. Press `e`, clear `Name`, Enter: `Name is required.` and the file is unchanged. Press `e`, set Inputs to `[1]`, Enter: `Inputs must be a JSON object.`. ESC leaves the form.
6. - [ ] Edit back: `e`, set the description back to `Typed inputs demo`, Enter.
7. - [ ] Run `m3-long` (`R`, Enter). When it is `passed`, select it on Runs and press Enter. The detail shows the run header, node tree, inputs, and events. `↑`/`↓` scroll it; `b` or ESC returns to the list.
8. - [ ] Logs. On the same row press `l` (list view). A report with `Logs for m3-long <id>`, an `── events ──` section and `── a (passed) ──` with `line 1` … `line 80` appears. `↑`/`↓` scroll it; `b`/ESC goes back. In the logs view `d` and `x` are not offered.
9. - [ ] Re-run. Back on the list press `R` on the finished run. The consent screen appears again (consent is never remembered). Press Enter. A new run appears with the same inputs. For `m1-inputs`, `R` re-runs without showing the inputs form (inputs are reused).
10. - [ ] Resume. Start `m2-approve` (from M2), wait for `waiting_approval`, select the run and press `u`. The status shows `… attached` or `queued` with no error. (It stays `waiting_approval` until decided.) On a `passed` run `u` is not in the footer.
11. - [ ] Delete. Select a `running` or `waiting_approval` run: `d` is not offered (cancel it first with `x`). Select a finished run: `d` shows `Delete "<title>"? This permanently removes the run's checkpoint, events, decisions and artifacts. y: Confirm · n/ESC: Cancel`. `n` keeps it. `y` removes it (`Deleted.`) and `ls $HOME/.agav/workflow-runs` no longer has its id.
12. - [ ] Footers at 80x24. Resize the terminal to 80x24 and look at the footer line on each tab and in the detail view. Every hint is present. **Known cosmetic issue:** a long footer wraps mid-word (for example `Del|ete`). This is not a failure; note any other defect (truncated or missing hints, overlapped lines, footer pushed off screen).

**Expected:** as above; the YAML file keeps its comments; invalid input never writes the file.

**Failure signal:** comments lost after `e`; the file changed after an error; `d` offered on an active run; `R` on a finished run skips consent; any hint missing at 80x24.

**Cleanup:** delete finished runs (`d`, `y`); cancel others with `x`, `y`.

## M4. Close the app mid-run, reopen in a new terminal

**Goal:** A run continues with no app open; a fresh session sees it and shows its completion notification exactly once.

**Prerequisites:** `.agav/workflows/m4-wait.json`

```json
{
  "version": 1,
  "name": "m4-wait",
  "nodes": [
    { "id": "wait", "type": "job", "command": "sleep 40; echo finished" }
  ]
}
```

**Steps:**

1. - [ ] Terminal 1: `cd /var/tmp/wf-testing && agav`, `/workflows`, `R` on `m4-wait`, Enter. Confirm it is `running` on Runs.
2. - [ ] Terminal 1: ESC, then `/exit` (or Ctrl+C twice). Close terminal 1 entirely.
3. - [ ] Terminal 2 (new window): `cd /var/tmp/wf-testing && agav workflows list`. The run is listed as `● <id8>  m4-wait  running …`.
4. - [ ] Terminal 2: start `agav`, `/workflows`, Tab to Runs. The run is there and updates by itself.
5. - [ ] Stay in the app's main prompt (not the TUI) until the run finishes (about 40 s after start). Within about 5 s of the end, the status line shows exactly `Run <id8> passed` once.
6. - [ ] Exit `agav`, start it again (terminal 2 or a third terminal). Wait at least 15 s. The `Run <id8> passed` message does **not** appear again.
7. - [ ] Optional: with two `agav` sessions open at the same time, a new run's completion message appears in only one of them.

**Expected:** the run survives closing the app; `workflows list` shows it as `running` and later `passed`; the notification shows once in total.

**Failure signal:** the run is `interrupted` or gone after closing the app; no notification at all; the notification appears again after a restart or in two sessions.

**Cleanup:** delete the run in the TUI (`d`, `y`).

## M5. Real agent: structured output and transcript

**Goal:** A `prompt` node returns schema-checked JSON that a downstream node consumes; check the transcript, model and duration; a schema violation fails the node.

**Prerequisites:** provider credentials in the HOME you use (see Setup). `.agav/workflows/m5-agent.yaml`

```yaml
version: 1
name: m5-agent
inputs:
  city: { type: string, default: Paris }
nodes:
  - id: ask
    type: prompt
    prompt: |
      Reply with only a JSON object with keys "country" (string) and "capital" (string)
      for the city ${inputs.city}. No other text.
    output: json
    outputSchema:
      type: object
      required: [country, capital]
      properties:
        country: { type: string }
        capital: { type: string }
    maxIterations: 3
    timeoutSeconds: 120
  - id: save
    type: tool
    dependsOn: [ask]
    tool: write_file
    input: { path: m5-out.txt, content: "${nodes.ask.output.country}" }
```

and `.agav/workflows/m5-bad-schema.yaml`

```yaml
version: 1
name: m5-bad-schema
nodes:
  - id: ask
    type: prompt
    prompt: 'Reply with only this JSON: {"count": "not-a-number"}'
    output: json
    outputSchema:
      type: object
      required: [count]
      properties:
        count: { type: number }
    maxIterations: 2
```

**Steps:**

1. - [ ] `agav workflows validate m5-agent` and `agav workflows validate m5-bad-schema` both succeed.
2. - [ ] `agav workflows run m5-agent --wait`, answer `none` for env and `y`. Output follows the run until it ends with exit code 0 (`echo $?` prints `0`).
3. - [ ] `agav workflows status <id8>`. The `ask` line looks like `✓ ask: passed (<model>, <n.n>s)` with a `→ {"country":"France","capital":"Paris"}`-style output line, and `✓ save: passed`.
4. - [ ] `cat m5-out.txt` prints a country name (the value of `country`, with no quotes or braces).
5. - [ ] Transcript: `ls $HOME/.agav/workflow-runs/<full-run-id>/artifacts/` includes `ask.txt`. `cat` it: it holds the agent's conversation/reply text for that node.
6. - [ ] `agav workflows run m5-agent --input '{"city":"Tokyo"}' --wait`: `m5-out.txt` now contains `Japan`.
7. - [ ] `agav workflows run m5-bad-schema --wait`. The run ends `failed` (exit code 1). `agav workflows status <id8>` shows `✗ ask: failed — Output does not match schema: …` (a message mentioning `count` and `must be number`).
8. - [ ] Reply is not JSON at all (optional): edit the prompt of `m5-bad-schema` to `Reply with the single word hello`; run it. Expected `✗ ask: failed — Output is not valid JSON and contains no ```json block.`

**Expected:** as above; the downstream node sees `${nodes.ask.output.country}` as a plain string.

**Failure signal:** `m5-agent` fails with credentials in place; the transcript file is missing; the schema-violating run passes; `m5-out.txt` contains JSON braces or `undefined`.

**Cleanup:** `rm m5-out.txt`; delete the runs (`d`, `y` in the TUI).

## M6. Agent sub-tool consent in the background

**Goal:** A `prompt` node's non-read-only tool calls become `agent_tool_consent` inbox decisions; approve and deny behave as documented; `deny-writes` and destructive commands are refused without a prompt.

**Prerequisites:** provider credentials; `.agav/workflows/m6-tools.yaml`

```yaml
version: 1
name: m6-tools
nodes:
  - id: worker
    type: prompt
    allowedTools: [write_file, run_command, read_file]
    maxIterations: 8
    timeoutSeconds: 300
    prompt: |
      Do exactly these steps with your tools, in order, and report what happened for each:
      1. Use write_file to create m6-a.txt in the current directory with the content "alpha".
      2. Use write_file to create m6-b.txt in the current directory with the content "beta".
      3. Use run_command to run exactly: rm -rf /var/tmp/wf-testing-does-not-exist
      Say "refused" for any call that was refused or denied and "ok" for any that worked.
```

and `.agav/workflows/m6-deny-writes.yaml`

```yaml
version: 1
name: m6-deny-writes
policies:
  permissionMode: deny-writes
nodes:
  - id: worker
    type: prompt
    allowedTools: [write_file]
    maxIterations: 4
    timeoutSeconds: 120
    prompt: Use write_file to create m6-c.txt with the content "gamma", then say whether it worked.
```

**Steps:**

1. - [ ] Park on consent. Run `agav workflows run m6-tools` (answer `none`, `y`). Then `agav workflows inbox`. Within about a minute a line appears with kind `agent_tool_consent`, node `worker` and a summary `Allow write_file in node worker?`. `agav workflows status <id8>` shows `worker` as `running` (the run is **not** `waiting_approval`; the agent waits in-process).
2. - [ ] Inspect in the TUI: `/workflows` → Inbox. The detail shows `agent tool consent on worker`, `Tool: write_file`, and the full input JSON with `"path": "m6-a.txt"`.
3. - [ ] Approve. Press `a`, then `y` (or `agav workflows approve <id8> <decisionId>`). `m6-a.txt` appears (`cat m6-a.txt` prints `alpha`), the run stays `running`, and a new decision for `m6-b.txt` appears.
4. - [ ] Deny. Deny the `m6-b.txt` decision (`D`, `y`; or `agav workflows deny <id8> <decisionId>`). `m6-b.txt` is **not** created, the run does **not** fail, and the agent continues.
5. - [ ] Destructive command. Step 3 of the prompt (`rm -rf /var/tmp/wf-testing-does-not-exist`) is refused outright: no inbox decision is ever filed for it (check `agav workflows inbox` while the agent is on that step).
6. - [ ] Final state. The run ends `passed`. `agav workflows status <id8>` shows `worker` output mentioning one `ok` (m6-a) and `refused` for the denied/destructive calls. `ls m6-*.txt` lists only `m6-a.txt`.
7. - [ ] Identical calls share one decision. Re-run `m6-tools`, approve the `m6-a.txt` decision, and note the second `write_file` has a different decision id (different input).
8. - [ ] Deny-writes. `agav workflows run m6-deny-writes --wait` (consent shows `Permission mode: ask`; the policy narrows it to `deny-writes`). The run passes without ever creating an inbox item (`agav workflows inbox` is empty throughout), `ls m6-c.txt` fails, and the agent's reply says the write was refused.
9. - [ ] CLI deny-writes flag. `agav --deny-writes workflows run m6-tools --wait`: no inbox decisions are filed, and `ls m6-*.txt` shows no new files.

**Expected:** an `agent_tool_consent` decision per distinct write; approve lets that call run; deny refuses only that call; the node and run keep running; `deny-writes` refuses without a prompt; destructive commands never become decisions.

**Failure signal:** the run turns `waiting_approval` or `failed` on a denied call; a file is written without approval under `ask`; any decision appears under `deny-writes`; `m6-b.txt` exists after the deny.

**Cleanup:** `rm -f m6-*.txt`; cancel and delete leftover runs in the TUI.

## M7. A2A agent node (optional)

**Goal:** An `agent` node that names an A2A agent runs through the same invoker as a native agent, and per-node `model`, `effort` and `maxIterations` are rejected on it with an error that names the fields.

Skip this scenario if no A2A agent is installed (`/agents` lists none with type `a2a`).

**Prerequisites:** an installed and enabled A2A agent (its `AGENT.md` has `type: a2a`, `start-command` and `endpoint`) and provider credentials in the test HOME (the default invoker is built from the provider config even for A2A agents). Replace `my-a2a-agent` below with the real agent name. `.agav/workflows/m7-a2a.yaml`

```yaml
version: 1
name: m7-a2a
nodes:
  - id: remote
    type: agent
    agent: my-a2a-agent
    task: Reply with the single word pong.
```

and `.agav/workflows/m7-a2a-overrides.yaml`

```yaml
version: 1
name: m7-a2a-overrides
nodes:
  - id: remote
    type: agent
    agent: my-a2a-agent
    task: Reply with the single word pong.
    model: some-model
    effort: high
    maxIterations: 5
```

**Steps:**

1. - [ ] Validate. `agav workflows validate m7-a2a` and `agav workflows validate m7-a2a-overrides` both print `Workflow valid.` (the overrides are legal on the schema level; only the runtime refuses them for A2A).
2. - [ ] Plain run. `agav workflows run m7-a2a --wait` (answer `none`, `y`). The node `remote` ends `passed` and the output contains the agent's reply. `ls $HOME/.agav/workflow-runs/<runId>/artifacts/remote.txt` exists and contains the task plus a `## Reply` section.
3. - [ ] Overrides rejected. `agav workflows run m7-a2a-overrides --wait`. The run ends `failed` and `remote` shows: `Agent "my-a2a-agent" is an a2a agent; model, effort, maxIterations cannot be applied to remote agents. Remove them from node remote.` Nothing is sent to the remote agent (check its own log).
4. - [ ] One field only. Delete the `model` and `effort` lines and run again. The error now reads `... is an a2a agent; maxIterations cannot be applied to remote agents. Remove it from node remote.` (singular `it`).
5. - [ ] Timeout. Add `timeoutSeconds: 1` to `m7-a2a.yaml` and point the agent at a slow task if you can. If the agent does not answer within 1 s the node ends `timed_out` with `Timed out after 1s.` (the A2A call does not take a signal, so the node is released at the deadline). Skip this step if your agent always answers in under a second.

**Expected:** the A2A node passes without overrides and fails (not silently ignores) with overrides; the error lists exactly the fields that were set.

**Failure signal:** the overrides run passes (the fields were silently ignored); the error does not name the fields; the plain run fails with `Unsupported agent type` or `Unknown agent`.

**Cleanup:** delete the runs (`d`, `y` in the TUI); stop the A2A process if the agent's `start-command` left one running.

## M8. Fix until tests pass, end to end

**Goal:** A `loop` with a failing check (`test`) and a `fix` step runs until `until: nodes.test.status == 'passed'` holds. The loop survives closing the TUI and agav during iteration 2 and finishes in the background with the right iteration count. A check that can never pass exhausts `maxIterations` with `loop exhausted after N iterations`.

**Prerequisites:** the check is `grep -q ok m8-target.txt` (it fails while the file is missing or lacks `ok`). The fix script only writes `ok` on its second call, so a green result needs 3 iterations. In `/var/tmp/wf-testing`:

```sh
rm -f m8-count m8-target.txt m8-attempt.txt
cat > m8-fix.sh <<'EOS'
n=$(cat m8-count 2>/dev/null || echo 0); n=$((n+1)); echo $n > m8-count
if [ "$n" -ge 2 ]; then echo ok > m8-target.txt; else echo bad > m8-target.txt; fi
EOS
```

`.agav/workflows/m8-fix-until-pass.yaml`

```yaml
version: 1
name: m8-fix-until-pass
description: Loop until the check passes; the fix step only succeeds on its second call.
nodes:
  - id: fix-loop
    type: loop
    maxIterations: 5
    until: "nodes.test.status == 'passed'"
    body:
      - id: test
        type: tool
        tool: run_command
        input:
          command: sleep 20; grep -q ok m8-target.txt
        timeoutSeconds: 60
        continueOnError: true
      - id: fix
        type: tool
        dependsOn: [test]
        when: "nodes.test.status != 'passed'"
        tool: run_command
        input:
          command: sh m8-fix.sh
```

`.agav/workflows/m8-unfixable.yaml`

```yaml
version: 1
name: m8-unfixable
nodes:
  - id: fix-loop
    type: loop
    maxIterations: 3
    until: "nodes.test.status == 'passed'"
    body:
      - id: test
        type: tool
        tool: run_command
        input:
          command: grep -q ok m8-never.txt
        continueOnError: true
      - id: fix
        type: tool
        dependsOn: [test]
        tool: write_file
        input:
          path: m8-attempt.txt
          content: "attempt ${loop.index}"
```

Optional agent variant (needs provider credentials): `.agav/workflows/m8-fix-agent.yaml` replaces the `fix` script with a `prompt` node.

```yaml
version: 1
name: m8-fix-agent
nodes:
  - id: fix-loop
    type: loop
    maxIterations: 4
    until: "nodes.test.status == 'passed'"
    body:
      - id: test
        type: tool
        tool: run_command
        input:
          command: grep -q ok m8-target.txt
        continueOnError: true
      - id: fix
        type: prompt
        dependsOn: [test]
        when: "nodes.test.status != 'passed'"
        allowedTools: [write_file]
        maxIterations: 4
        timeoutSeconds: 120
        prompt: Use write_file to create m8-target.txt in the current directory with exactly the content "ok", then say done.
```

The `test` step is a `tool` node here because it is the simplest form and needs no job. `job` nodes now work inside loops too (fixed in commit 6c20619e; the request id is `wf-<runId>-<node>-<attempt>_i<iteration>`, for example `wf-<runId>-test-1_i0`). Step 9 is an optional variant with a `job` node as the `test`.

**Steps:**

1. - [ ] Validate all workflows: `agav workflows validate m8-fix-until-pass`, `m8-unfixable` and `m8-fix-agent` each print `Workflow valid.`
2. - [ ] Start from the TUI. `/workflows`, `R` on `m8-fix-until-pass`, Enter at consent (no env). The new run opens in Runs.
3. - [ ] Watch iteration 1. Open the run (Enter). It shows `loop fix-loop iteration 1/5`, `test` running (20 s), then `test` ✗ failed and `fix` ✓ passed (`m8-count` now holds `1`, `m8-target.txt` holds `bad`).
4. - [ ] Close during iteration 2. As soon as the detail shows `iteration 2/5` (between about 20 s and 40 s after the start), press ESC out of the TUI and quit agav (`/exit`). Do not cancel the run.
5. - [ ] Confirm it keeps going. In a plain shell (same HOME and cwd) run `agav workflows status <id8>`. It shows `running` with `iteration 2/5` or `3/5`. `pgrep -af supervisor/entry | grep /tmp/wf-testing` still lists a supervisor.
6. - [ ] Finish. After about 70 s in total `agav workflows status <id8>` shows `✓ passed`, `fix-loop: passed (loop fix-loop iteration 3/5)`, `earlier iterations: ✓ ✓`, and in iteration 3 `test` ✓ passed and `fix` ↷ skipped (`when is false: nodes.test.status != 'passed'`). `cat m8-count` prints `2`, `cat m8-target.txt` prints `ok`.
7. - [ ] Exhaustion. `agav workflows run m8-unfixable --wait` (answer `none`, `y`). The run ends `failed` and `fix-loop` shows `loop exhausted after 3 iterations`. `cat m8-attempt.txt` prints `attempt 2` (the loop ran the fix on iterations 0, 1 and 2). `test` shows `✗ failed` in the last iteration, but the iteration itself is `passed` because of `continueOnError: true`.
8. - [ ] Agent variant (optional). `rm -f m8-target.txt`, then `agav workflows run m8-fix-agent --wait`. Under `ask`, approve the `write_file` decision of node `fix` (it is an `agent_tool_consent`, see M6). The run ends `passed` after 2 iterations (`iteration 2/4`), and `fix` is skipped in iteration 2.
9. - [ ] Job-node `test` (optional). Save `.agav/workflows/m8-fix-job.yaml`, which is `m8-fix-until-pass` with the check as a `job` node:

   ```yaml
   version: 1
   name: m8-fix-job
   nodes:
     - id: fix-loop
       type: loop
       maxIterations: 5
       until: "nodes.test.status == 'passed'"
       body:
         - id: test
           type: job
           command: grep -q ok m8-target.txt
           continueOnError: true
         - id: fix
           type: tool
           dependsOn: [test]
           when: "nodes.test.status != 'passed'"
           tool: run_command
           input:
             command: sh m8-fix.sh
   ```

   `rm -f m8-count m8-target.txt`, recreate `m8-fix.sh` if you removed it, and run `agav workflows run m8-fix-job --wait`. The run ends `✓ passed` with `fix-loop: passed (loop fix-loop iteration 3/5)`, the `test` job is `✓ passed` in iteration 3 and `fix` is `↷ skipped`. `cat m8-count` prints `2`. There is no `Invalid or unsafe identifier` error. The three job request ids are `wf-<runId>-test-1_i0`, `_i1` and `_i2`: `ls $HOME/.agav/background-jobs/specs | grep test-1_i` lists them (the `.` form `fix-loop.0.test-1` is gone).

**Expected:** the run needs 3 iterations and exactly 2 fix calls; closing the TUI and agav during iteration 2 does not interrupt it; the unfixable run fails with `loop exhausted after 3 iterations` and the right fix count.

**Failure signal:** the run turns `interrupted` or `cancelled` when the TUI closes; the iteration count is off (`m8-count` is not `2`); step 9 fails with `Invalid or unsafe identifier` (the loop job-id fix regressed); the loop stops after a failed `test` (the `continueOnError` is ignored); the exhausted run ends `passed` or has a different error text.

**Cleanup:** `rm -f m8-count m8-target.txt m8-attempt.txt m8-fix.sh`; delete the runs (`d`, `y` in the TUI).

## M9. Tool consent in the Inbox for a mutating tool node

**Goal:** A mutating tool node whose tool is not covered by the run's consent files a `tool_consent` decision. The Inbox detail shows the exact resolved input. After approval, identical calls in later loop iterations do not ask again, while a call with a changed input asks again.

A tool node is normally covered by the consent (the consent lists the tool names of the definition), so no decision appears in a normal run. This scenario simulates an uncovered tool by editing the stored consent while the run is parked on an approval node. It is a test-only edit of local state.

**Prerequisites:** `jq`. `.agav/workflows/m9-consent.yaml`

```yaml
version: 1
name: m9-consent
nodes:
  - id: arm
    type: approval
    prompt: Edit the run consent now (M9 step 2), then approve this.
  - id: writes
    type: loop
    dependsOn: [arm]
    maxIterations: 3
    onExhausted: continue
    body:
      - id: same
        type: tool
        tool: write_file
        input:
          path: m9-same.txt
          content: constant
      - id: changing
        type: tool
        dependsOn: [same]
        tool: write_file
        input:
          path: m9-changing.txt
          content: "round ${loop.index}"
```

**Steps:**

1. - [ ] Start. `rm -f m9-*.txt`, then `agav workflows run m9-consent` (answer `none`, `y`). Within a few seconds `agav workflows inbox` shows an `approval` line on `arm`. Note the run's id8.
2. - [ ] Drop the tool from the consent. The runner has exited (the run is parked), so the checkpoint is safe to edit. The checkpoint is `<runId>.json` **next to** the run directory `<runId>/`, not inside it (the directory holds only `decisions/`, `events.jsonl` and `artifacts/`), so `ls <runId>/*.json` fails with `No such file or directory`. Use the id8 glob, or the full id without a slash:

   ```sh
   F=$(ls $HOME/.agav/workflow-runs/<id8>*.json)     # = $HOME/.agav/workflow-runs/<full-run-id>.json
   jq -c '.consent.capabilities' "$F"     # {"tools":["write_file"],"jobCommands":[]}
   jq '.consent.capabilities.tools = []' "$F" > "$F.tmp" && mv "$F.tmp" "$F"
   jq -c '.consent.capabilities' "$F"     # {"tools":[],"jobCommands":[]}
   agav workflows status <id8>            # still prints the tree (`◐ waiting_approval`), no `Invalid`/`Corrupt workflow checkpoint`
   ```

   Edit only `consent.capabilities.tools`. On read the store requires `consent.definitionHash` to equal the run's `workflowHash` and `consent.cwd` to equal the run's `cwd`, and the consent object must keep exactly its known fields, so do not touch those or add keys. The `.tmp` file must be gone after the `mv`.
3. - [ ] Release the run. `agav workflows approve <id8> arm`. The output ends `runner started (attempt 2).` After a few seconds the run is `waiting_approval` again (not `failed`), with `same` ◐ in iteration 1 and `changing` pending.
4. - [ ] Inspect in the TUI. `/workflows` → Inbox. The item reads `◐ same · m9-consent <id8>`, kind `tool consent`. The detail shows `tool consent on same (iteration 1)`, `Directory:` and `Permission mode: ask`, the summary `Allow write_file in node same?`, then `Tool: write_file  (input #<12 hex>)` and the full input JSON: `"path": "m9-same.txt"`, `"content": "constant"`. The last line reads `Approving allows identical calls (same tool and resolved input) of this node for the rest of the run.`
5. - [ ] Approve in the TUI. Press `a`, then `y`. `cat m9-same.txt` prints `constant`. The Inbox now holds a new item for node `changing` (iteration 1) whose JSON input has `"content": "round 0"`.
6. - [ ] Identical call, next iteration. Approve `changing` (TUI `a`, `y`, or `agav workflows approve <id8> changing`). Iteration 2 starts. The Inbox gets one new item, `changing (iteration 2)` with `"content": "round 1"`. **No** new decision for `same` appears, although iteration 2 calls `write_file` with the same input, and `same` shows ✓ passed in iteration 2.
7. - [ ] Changed input. Approve `changing` for iteration 2. Iteration 3 asks for `changing` again, with `"content": "round 2"` (a different decision id and `#hash` each time), and still never for `same`.
8. - [ ] Finish. Approve the last decision. The run ends `✓ passed` (the loop uses `onExhausted: continue`). `cat m9-changing.txt` prints `round 2`. `ls $HOME/.agav/workflow-runs/<id8>*/decisions/ | grep -c decided` prints `5` (`arm`, one `same`, three `changing`).

**Expected:** exactly one decision for the repeated `same` call over 3 iterations and one decision per distinct `changing` input; the Inbox detail shows the resolved input before anything is approved; no file is written before its decision is approved.

**Failure signal:** `m9-same.txt` exists before step 5; `same` asks again in iteration 2 or 3; `changing` is auto-approved on a changed input; the run fails or is cancelled after an approve; the Inbox detail lacks the input JSON.

**Cleanup:** `rm -f m9-*.txt`; delete the run (`d`, `y` in the TUI).

## M10. Approval node inside a loop

**Goal:** An `approval` node in a loop body asks again in every iteration. Approving from the Inbox resumes the loop in the same iteration, and one iteration's approval never decides the next.

**Prerequisites:** `rm -f m10-rounds.txt`; `.agav/workflows/m10-approval-loop.yaml`

```yaml
version: 1
name: m10-approval-loop
nodes:
  - id: rounds
    type: loop
    maxIterations: 3
    onExhausted: continue
    body:
      - id: gate
        type: approval
        prompt: Continue with this round?
      - id: mark
        type: tool
        dependsOn: [gate]
        tool: run_command
        input:
          command: echo round >> m10-rounds.txt
```

**Steps:**

1. - [ ] Park in iteration 1. `agav workflows run m10-approval-loop` (answer `none`, `y`). `agav workflows status <id8>` shows `◐ rounds: waiting_approval (loop rounds iteration 1/3)` with `gate` ◐ and `mark` pending. `agav workflows inbox` shows one line: `approval  gate (iteration 1)  Continue with this round?`. Note the decision id. `m10-rounds.txt` does not exist.
2. - [ ] Inspect in the TUI. Inbox tab → Enter on the item. The detail starts with `approval on gate (iteration 1)` and ends with `Approval grants no tool permissions.`
3. - [ ] Approve from the Inbox. Press `a`, then `y` (or `agav workflows approve <id8> gate`). The status line says `runner started (attempt 2)` (or similar). Within a few seconds `m10-rounds.txt` has **1** line and the run shows `iteration 2/3` with `earlier iterations: ✓`. Iteration 1 was resumed, not restarted: there is no second line from iteration 1.
4. - [ ] Asks again. The Inbox has a new `gate (iteration 2)` item with a **different** decision id from step 1. The run is `waiting_approval` again.
5. - [ ] Approve iteration 2, then iteration 3. After each approval `m10-rounds.txt` grows by exactly one line (2, then 3), and the next `gate` item appears with the next iteration number. Attempt numbers rise (3, 4).
6. - [ ] Finish. After the third approval the run ends `✓ passed` (`rounds: passed (loop rounds iteration 3/3)`). `wc -l m10-rounds.txt` prints `3`. The Inbox is empty.
7. - [ ] Deny variant. Run again (`rm m10-rounds.txt` first), deny the first `gate` (`D`, `y`, or `agav workflows deny <id8> gate`). The run ends `failed`, the loop does not continue to iteration 2, and `m10-rounds.txt` does not exist. An approval denial is a human decision, so `continueOnError` is not allowed on it. `agav workflows status <id8>` prints the tree normally (no `Corrupt workflow checkpoint`): `✗ rounds: failed (loop rounds iteration 1/3) — iteration 0 failed: gate: Approval denied by …`, `✗ gate: failed — Approval denied by …`, and `… mark: pending`. `agav workflows list` still lists the run as `✗ ... failed`.

   > Fixed in commit 6c20619e. Before the fix `mark` was recorded as `skipped` (`dependency gate failed`) inside the loop iteration, `status` printed `Corrupt workflow checkpoint; invalid node state or dependencies.`, and the run no longer listed. Now the dependent of a denied loop gate stays `pending`. Treat `Corrupt workflow checkpoint`, a missing run in `list`, or `mark` shown as `skipped` as a failure of step 7.

**Expected:** three separate approvals with three distinct decision ids; every approval resumes the same iteration; `m10-rounds.txt` has exactly 3 lines; a deny fails the run and leaves the run readable (`mark` pending).

**Failure signal:** iteration 2 starts without a new inbox item (the first approval was reused); an approval restarts iteration 1 (duplicate lines); the run stays `waiting_approval` after the last approval; the deny continues the loop; after the deny `status` prints `Corrupt workflow checkpoint` or the run disappears from `list`.

**Cleanup:** `rm -f m10-rounds.txt`; delete the runs (`d`, `y` in the TUI).

## M11. Timeouts and the run deadline

**Goal:** `timeoutSeconds` stops a slow tool node and a slow job node (the child process is really gone), `policies.maxRuntimeSeconds` makes the whole run `timed_out`, and an approval node never times out (`m11-approval-wait` stays parked; a definition that puts `timeoutSeconds` on an approval node is rejected before anything runs, which step 2 checks as a negative test).

**Prerequisites:** five files in `.agav/workflows/`: four valid workflows (`m11-tool-timeout`, `m11-job-timeout`, `m11-deadline`, `m11-approval-wait`) and one deliberately **invalid** one (`m11-approval-timeout`, used only by step 2). `m11-tool-timeout.yaml`

```yaml
version: 1
name: m11-tool-timeout
nodes:
  - id: slow
    type: tool
    tool: run_command
    timeoutSeconds: 3
    input:
      command: sleep 30
```

`m11-job-timeout.yaml`

```yaml
version: 1
name: m11-job-timeout
nodes:
  - id: slowjob
    type: job
    command: sleep 300
    timeoutSeconds: 5
```

`m11-deadline.yaml`

```yaml
version: 1
name: m11-deadline
policies:
  maxRuntimeSeconds: 8
nodes:
  - id: slowjob
    type: job
    command: sleep 300
```

`m11-approval-wait.yaml`

```yaml
version: 1
name: m11-approval-wait
nodes:
  - id: gate
    type: approval
    prompt: Waits until a human decides.
```

and `m11-approval-timeout.yaml`, the **negative-test** file (invalid on purpose; it is never expected to run, and no other step uses it):

```yaml
version: 1
name: m11-approval-timeout
nodes:
  - id: gate
    type: approval
    timeoutSeconds: 10
    prompt: Never times out
```

Before you start, make sure no stray `sleep` from earlier tests is running: `ps -eo pid,args | grep '[s]leep 30'` prints nothing.

**Steps:**

1. - [ ] Validate the four valid workflows. `agav workflows validate m11-tool-timeout`, `m11-job-timeout`, `m11-deadline` and `m11-approval-wait` each print `Workflow valid.` and exit 0 (`echo $?`).
2. - [ ] Negative test: an approval node with `timeoutSeconds` is rejected. This step is expected to **fail**; a failure here is the pass. (a) `agav workflows validate m11-approval-timeout; echo "exit=$?"` prints exactly `error: Approval nodes do not support timeoutSeconds (approvals wait until decided): gate` and `exit=1`, and never `Workflow valid.`. (b) In the real terminal, `agav workflows run m11-approval-timeout; echo "exit=$?"` prints the same `error: ...` line and `exit=1`. The definition is validated before consent: no consent summary, no env checklist and no `Approve this background run?` question appear, so there is nothing to answer. (c) `agav workflows list` shows no run for `m11-approval-timeout`, `ls $HOME/.agav/workflow-runs` has no new `<uuid>.json` or directory, and `pgrep -af internal-workflow-runner | grep m11-approval-timeout` prints nothing.
3. - [ ] Tool timeout. `agav workflows run m11-tool-timeout --wait` (answer `none`, `y`). While it runs (in a second terminal), `ps -eo pid,args | grep '[s]leep 30'` shows the `sleep 30`. After about 3 s the node shows `⏱ slow: timed_out` (error `Command failed: Command cancelled.`) and the run ends `⏱ timed_out` after about 4 s. The `ps` check is empty a moment later.
4. - [ ] Job timeout. `agav workflows run m11-job-timeout` (answer `none`, `y`, no `--wait`). Within 2 s `ps -eo pid,args | grep '[s]leep 300'` shows `/bin/sh -c sleep 300` and `sleep 300`. After about 6 s, `agav workflows status <id8>` shows `⏱ slowjob: timed_out — Timed out after 5s; the job was stopped. Job <jobId> was interrupted.` The `ps` check prints nothing: the child job was stopped, not just abandoned. In agav, `/job list` shows that job as `interrupted`.
5. - [ ] Run deadline. `agav workflows run m11-deadline --wait`. After about 8 s the node shows `⏱ slowjob: timed_out — Run deadline exceeded (policies.maxRuntimeSeconds=8). Job <jobId> was interrupted.` and the run ends `⏱ timed_out` (about 9–10 s). `ps -eo pid,args | grep '[s]leep 300'` prints nothing. The last line of `$HOME/.agav/workflow-runs/<runId>/events.jsonl` has `"status":"timed_out"` and `"reason":"run deadline exceeded"`.
6. - [ ] Approval never times out. `agav workflows run m11-approval-wait` (answer `none`, `y`). Wait at least 60 s. `agav workflows list` still shows `◐ ... waiting_approval`, and the Inbox still holds the `approval` item. Approve it: the run ends `✓ passed`. (With no `maxRuntimeSeconds` there is no deadline to hit.)
7. - [ ] Status bar and TUI glyphs. In the TUI Runs tab the timed-out runs show the `⏱` glyph and the status `timed_out`, and the run notification `... timed out` was shown once.

**Expected:** each `timed_out` run ends within a second or two of its limit; no `sleep` process outlives its node; the approval (`m11-approval-wait`) waits without any timeout; the negative-test file `m11-approval-timeout` is rejected by `validate` and by `run` (exit 1, same message, no consent prompt, no run created).

**Failure signal:** a run that should time out ends `failed` or `cancelled`; a `sleep 30` or `sleep 300` process is still alive 15 s after the run ended (check with `ps`); a job stays `running` in `/job list`; the approval run changes state on its own; `m11-approval-timeout` validates, or `run` on it shows a consent prompt or creates a run.

**Cleanup:** `ps -eo pid,args | grep '[s]leep 30'` should be empty (if not, stop the leftover job with `/job stop <id>` rather than `kill`ing blindly); delete the runs (`d`, `y` in the TUI).

## M12. Retention: old finished runs are pruned

**Goal:** A terminal run (`passed`, `failed`, `cancelled`, `timed_out`) that was last updated more than 7 days ago is deleted together with its run directory, `.cancel` marker and mailbox notifications, the next time `workflows list` runs. A non-terminal run (here a parked `waiting_approval` one) and a recent terminal run are kept. The 7 days are built in (the background-jobs `completedLogRetentionDays` default); there is no workflow setting for it.

> **TEST-ONLY HACK.** Real runs cannot be 8 days old on demand, so this scenario edits the timestamps in a checkpoint JSON by hand. Do it **only** on the throwaway `HOME=/tmp/wf-testing/home` from Setup, never on your real `~/.agav`. Close any agav TUI first: it reconciles in the background and could prune early.

**What decides pruning** (`source/workflows/reconcile.ts`, `pruneRun`): the run's status is terminal **and** `Date.parse(updatedAt) <= now - 7 days`. `workflows list` (and the app's periodic reconcile) prunes. `workflows status <id>` reconciles that one run only and never prunes. The checkpoint read check in `source/workflows/store.ts` does not compare `updatedAt` with `createdAt`, but the helper below shifts **every** ISO timestamp in the file by the same amount (`createdAt`, `updatedAt`, node `startedAt`/`endedAt`, and so on), so the file stays consistent and schema-valid. Do not change anything else in the file: the definition hash and consent are checked on read.

**Prerequisites:** `.agav/workflows/m12-quick.yaml`

```yaml
version: 1
name: m12-quick
nodes:
  - id: hello
    type: tool
    tool: run_command
    input:
      command: echo m12-done
```

and `.agav/workflows/m12-park.yaml`

```yaml
version: 1
name: m12-park
nodes:
  - id: gate
    type: approval
    prompt: Parked on purpose for the retention test.
```

Shell variables and the helper used below (define them once, in the terminal you use for the whole scenario). The helper rewrites a checkpoint through a temp file and a rename:

```sh
export HOME=/tmp/wf-testing/home
WR=$HOME/.agav/workflow-runs
age() {
  python3 - "$1" "$2" <<'PY'
import re, sys, os, datetime
path, days = sys.argv[1], float(sys.argv[2])
text = open(path).read()
pat = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z')
def shift(m):
    t = datetime.datetime.fromisoformat(m.group(0).replace('Z', '+00:00')) - datetime.timedelta(days=days)
    return t.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
tmp = path + '.tmp'
open(tmp, 'w').write(pat.sub(shift, text))
os.replace(tmp, path)
PY
}
```

**Steps:**

1. - [ ] Validate. `agav workflows validate m12-quick` and `agav workflows validate m12-park` both print `Workflow valid.`
2. - [ ] Create three runs. `agav workflows run m12-quick --wait` (answer `none`, `y`) twice, then `agav workflows run m12-park` once (`none`, `y`). `agav workflows list --json` shows two `passed` runs and one `waiting_approval` run. Copy the three **full UUIDs** and set them: `A=<first passed run>`, `C=<second passed run>`, `P=<parked run>`. (`ls $WR/*.json` lists the same ids.)
3. - [ ] Add the side files that pruning must remove for run `A`. Create the marker: `touch $WR/$A.cancel`. Then find its mailbox notification and a `.seen` marker for it: `n=$(grep -l $A $WR/_mailbox/*.json | head -1); echo $n; touch "${n%.json}.seen"`. The `echo` prints one `wfn_....json` path (the `passed` notification). Record the "before" state: `ls $WR $WR/_mailbox`. It shows `$A.json`, the directory `$A`, `$A.cancel`, and the `wfn_*` files of the runs.
4. - [ ] Age the runs (the `age` helper above):

   ```sh
   age $WR/$A.json 10     # terminal, 10 days old: must be pruned
   age $WR/$C.json 6      # terminal, 6 days old (inside the window): must be kept
   age $WR/$P.json 10     # NOT terminal, 10 days old: must be kept
   ```

   Check the edit took effect without running agav: `grep -m2 -E '"(createdAt|updatedAt)"' $WR/$A.json` shows dates 10 days in the past, and `createdAt` is not later than `updatedAt`.
5. - [ ] `status` does not prune. `agav workflows status ${A:0:8}` still prints the run tree (`✓ passed`), and `ls $WR` still shows `$A.json`, `$A` and `$A.cancel`.
6. - [ ] `agav workflows list`. Only **two** runs are printed: `C` (`passed`) and `P` (`◐ ... waiting_approval`). No `warning: reconcile ...` line appears on stderr.
7. - [ ] Check the files of `A`: `ls $WR` no longer shows `$A.json`, the `$A` directory or `$A.cancel`. `grep -l $A $WR/_mailbox/*.json 2>/dev/null` prints nothing, and the `.seen` file you made in step 3 is gone too (`ls $WR/_mailbox`). The notifications of `C` and `P` are still there.
8. - [ ] Check that the others are untouched: `ls $WR` still shows `$C.json`, the `$C` directory, `$P.json` and the `$P` directory. `agav workflows inbox` still lists the `approval  gate` decision for `P`, and `agav workflows status ${P:0:8}` still shows `waiting_approval`.
9. - [ ] Boundary. `age $WR/$C.json 2` (now 8 days old) and run `agav workflows list` again. `C` disappears (with its directory and mailbox entries). `P` is still listed.

**Expected:** only terminal runs older than 7 days are removed, and everything that belongs to them (checkpoint, run directory with `events.jsonl`/decisions/artifacts, `.cancel`, mailbox `.json` and `.seen`) goes with them. The parked `P` stays at any age, together with its inbox decision. `status` never prunes.

**Failure signal:** `A` (or its directory, `.cancel` or a `wfn_*` entry mentioning it) survives step 6; `C` is removed at 6 days; `P` is removed or changes state; `list` skips an edited run or warns `Invalid workflow checkpoint` (the timestamps were shifted inconsistently, or another field was changed); a leftover `*.json.tmp` appears next to the checkpoints.

**Cleanup:** `agav workflows deny ${P:0:8} gate` (or `agav workflows cancel ${P:0:8}`), then delete the remaining runs from the TUI (`d`, `y`) or with `rm -rf $WR`. In your shell: `unset -f age; unset A C P WR n`.

## M13. Decision: do selected env names reach job and tool nodes?

**Goal:** This is a **decision**, not a pass/fail test. Record what the product should do. In the consent checklist you select an environment variable name, for example `FAKE_SECRET`. The runner process gets it. The smoke test showed that **tool nodes and job nodes do not**: their environment is minimal, and `$FAKE_SECRET` printed empty in both. `docs/docs/reference/workflows.md` only says "Only the selected names are passed to the runner". It does not say whether the nodes see them.

**Prerequisites:** `.agav/workflows/m13-env.yaml`. (`run_command` rejects `${...}` in its input as interpolation, so the example uses `printenv`.) The final `hold` job keeps the run alive for 90 s so you can inspect the processes.

```yaml
version: 1
name: m13-env
nodes:
  - id: tool-env
    type: tool
    tool: run_command
    input:
      command: printenv FAKE_SECRET || echo absent
  - id: job-env
    type: job
    command: printenv FAKE_SECRET || echo absent
  - id: hold
    type: job
    dependsOn: [tool-env, job-env]
    command: sleep 90
```

Then, in the terminal where you launch the run: `export HOME=/tmp/wf-testing/home FAKE_SECRET=s3cr3t-m13`.

**Steps:**

1. - [ ] `agav workflows validate m13-env` prints `Workflow valid.`
2. - [ ] `agav workflows run m13-env`. In the env checklist `FAKE_SECRET` is listed by **name only**. Answer with its number (for example `7`), see `Selected: FAKE_SECRET`, then `y`. Note the run id (`<id8>`).
3. - [ ] Wait about 5 s. `agav workflows status <id8>` shows `tool-env` passed with an output containing `absent` (or the secret, if nodes do get it). Write down which: `tool-env: ______`.
4. - [ ] Find the job id of `job-env` in the same status output, then in `agav` run `/job log <jobId>`. Write down what it printed (`absent` or the value): `job-env: ______`.
5. - [ ] Confirm the **runner** did get it, while `hold` is still running. Find the runner process(es) and read their environment:

   ```sh
   RUN=<full run uuid>
   for pid in $(pgrep -f "internal-workflow-runner $RUN"); do
     echo "pid $pid"; cat /proc/$pid/environ | tr '\0' '\n' | grep FAKE_SECRET
   done
   ```

   At least one pid prints `FAKE_SECRET=s3cr3t-m13` (a wrapper pid may print nothing). Also check the `hold` job's own environment: `for pid in $(pgrep -f 'sleep 90'); do echo "pid $pid"; tr '\0' '\n' < /proc/$pid/environ | grep FAKE_SECRET; done`, and write down whether the variable is present.
6. - [ ] The value must not be on disk: `grep -r s3cr3t-m13 $HOME/.agav` prints nothing.
7. - [ ] Repeat steps 2–4 once with `none` in the checklist, to see the baseline (`absent` in both).
8. - [ ] **Owner decision.** Should job and tool nodes receive the env names selected in the consent? Tick one:
   - [ ] **Y**: selected names are passed on to tool and job nodes (the checklist then means "this run's commands may read these variables"). Follow-up: change the tool and job paths, and update the consent text and `docs/docs/reference/workflows.md`.
   - [ ] **N**: only the runner gets them (needed e.g. for provider API keys of `prompt`/`agent` nodes), and nodes keep a minimal environment on purpose. Follow-up: say so in `docs/docs/reference/workflows.md` and in the consent prompt text, and consider a per-node `env` allow-list as a later feature.

   Owner / date: ______   Answer: ______   Reason: ______

**Expected (current behaviour, from the smoke test):** the runner process has `FAKE_SECRET`; `tool-env` and `job-env` both print `absent`; the value is never written to disk.

**Failure signal:** the runner does **not** have `FAKE_SECRET` although it was selected (consent not honoured); the value appears anywhere under `~/.agav` (leak); the two node types behave differently from each other (record it in Notes).

**Cleanup:** `agav workflows cancel <id8>`, check `ps -eo pid,args | grep '[s]leep 90'` is empty, delete the runs, `unset FAKE_SECRET RUN`.

## M14. Background runs refused on non-Windows hosts without the native helper (optional)

**Goal:** On a **non-Windows** host where the background-jobs capabilities report `nativeHelperAvailable: false`, `workflows run` refuses **before** the consent prompt, with a clear message, and creates no run. Skip this scenario on Linux/macOS (the helper is available there and there is no supported switch to turn it off); mark it `n/a` in the log.

**Windows:** do not expect missing-helper refusal. Run **W1** instead: the Windows fallback warns and proceeds to consent.

**Prerequisites:** a non-Windows host without the helper, `backgroundJobsEnabled` and `workflowsEnabled` set, and `.agav/workflows/m14-any.yaml`

```yaml
version: 1
name: m14-any
nodes:
  - id: hello
    type: tool
    tool: run_command
    input:
      command: echo hello
```

**Steps:**

1. - [ ] `agav workflows validate m14-any` prints `Workflow valid.` (validation does not need the helper).
2. - [ ] In a real terminal: `agav workflows run m14-any`. Before any consent text or `Approve this background run?` question appears, stderr shows `error: Background workflow runs are unavailable on this host: the native process helper is missing`, followed by the capability limitations in parentheses (if there are any) and a period. The exit code is `1` (`echo $?`; PowerShell: `$LASTEXITCODE`; cmd: `echo %ERRORLEVEL%`).
3. - [ ] In the TUI/app, `/workflows run m14-any` answers `Workflow error: Background workflow runs are unavailable on this host: the native process helper is missing...` and does **not** open the consent screen.
4. - [ ] `agav workflows list` prints `No workflow runs.` and `ls ~/.agav/workflow-runs` (PowerShell: `Get-ChildItem $env:USERPROFILE\.agav\workflow-runs`) shows no new `<uuid>.json` or run directory.

**Expected:** the refusal text above, shown before consent, and no run created.

**Failure signal:** the consent prompt is shown first and the failure only comes after `y`; a run is created in a `queued` state that never starts; the message is a stack trace or an unrelated error.

**Cleanup:** none (nothing was created). If a stray run exists, delete it from the TUI.

## M15. Gates and no-TTY

**Goal:** The two opt-in settings each block workflows with a clear message, and `workflows run` without a terminal refuses with `requires interactive consent` and starts nothing.

**Prerequisites:** the throwaway `HOME` from Setup, and `.agav/workflows/m15-ok.yaml`

```yaml
version: 1
name: m15-ok
nodes:
  - id: hello
    type: tool
    tool: run_command
    input:
      command: echo m15
```

Keep a copy of the good config: `cp $HOME/.agav/config.json $HOME/.agav/config.json.good`.

**Steps:**

1. - [ ] **`workflowsEnabled: false`.** Write `{"backgroundJobsEnabled":true,"workflowsEnabled":false,"permissionMode":"ask"}` to `$HOME/.agav/config.json`. `agav workflows list` prints `error: Workflows require backgroundJobsEnabled=true AND workflowsEnabled=true.` on stderr and exits `1`. Same for `agav workflows run m15-ok` and `agav workflows validate m15-ok` (the gate is checked before anything else). In the TUI/app, `/workflows` answers `Workflows require backgroundJobsEnabled=true AND workflowsEnabled=true.` and the status line shows no workflow badge.
2. - [ ] **`backgroundJobsEnabled: false`.** Write `{"backgroundJobsEnabled":false,"workflowsEnabled":true,"permissionMode":"ask"}`. The same commands print the same message (one message covers both settings and names both).
3. - [ ] Restore: `cp $HOME/.agav/config.json.good $HOME/.agav/config.json`. `agav workflows list` works again (`No workflow runs.` or your remaining runs).
4. - [ ] **No TTY, piped stdin.** Record the state: `ls $HOME/.agav/workflow-runs > /tmp/wf-testing/before.txt 2>&1`. Then `echo y | agav workflows run m15-ok; echo "exit=$?"` prints `error: workflow run requires interactive consent` and `exit=1`. No consent summary and no `Approve this background run?` question appear.
5. - [ ] **No TTY, piped stdout.** `agav workflows run m15-ok | cat` prints the same error (stdout must be a terminal too) and nothing on stdout.
6. - [ ] **Nothing was started.** `ls $HOME/.agav/workflow-runs > /tmp/wf-testing/after.txt 2>&1; diff /tmp/wf-testing/before.txt /tmp/wf-testing/after.txt` prints nothing: no `<uuid>.json`, no run directory, no `.cancel`. `agav workflows list` shows no new run and `pgrep -af internal-workflow-runner | grep m15` prints nothing.
7. - [ ] **Check order.** A workflow name that does not exist fails the same way (the TTY check comes first): `echo y | agav workflows run x` prints `error: workflow run requires interactive consent`.

**Expected:** gate message `Workflows require backgroundJobsEnabled=true AND workflowsEnabled=true.` for either disabled setting; `workflow run requires interactive consent` with exit code 1 for any non-terminal stdin or stdout; the run store is unchanged by the piped invocations.

**Failure signal:** a gate is silently ignored; a piped run asks anything or reads the `y` as consent; a run directory or checkpoint appears after a piped invocation; the exit code is `0`.

**Cleanup:** `rm -f /tmp/wf-testing/before.txt /tmp/wf-testing/after.txt $HOME/.agav/config.json.good`, and make sure `$HOME/.agav/config.json` has both settings `true` again.

## Results log

| Scenario | Result (pass/fail) | Notes | Date |
| --- | --- | --- | --- |
| M1 |  |  |  |
| M2 |  |  |  |
| M3 |  |  |  |
| M4 |  |  |  |
| M5 |  |  |  |
| M6 |  |  |  |
| M7 |  |  |  |
| M8 |  |  |  |
| M9 |  |  |  |
| M10 |  |  |  |
| M11 |  |  |  |
| M12 |  |  |  |
| M13 |  | decision: Y / N |  |
| M14 |  |  |  |
| M15 |  |  |  |

### Windows results

Fill in on a Windows host. Leave unrun manual checks blank; do not infer a pass from automated coverage. The compiled Node smoke test passes, but real-terminal/TUI, standalone binary and Docker checks are not covered by that test.

| Scenario | Result (pass / fail / not run / n/a) | Notes | Date |
| --- | --- | --- | --- |
| W1 |  |  |  |
| W2 |  |  |  |
| W3 |  | BOM JSON fails: expected today |  |
| W4 |  | host/font: |  |
| W5 |  |  |  |
| M1 |  |  |  |
| M2 |  |  |  |
| M3 |  | `v`, Tab, footers checked in W4 |  |
| M4 |  |  |  |
| M5 |  |  |  |
| M6 |  |  |  |
| M7 |  | Validate and run; retain A2A limits |  |
| M8 |  |  |  |
| M9 |  |  |  |
| M10 |  |  |  |
| M11 |  |  |  |
| M12 |  |  |  |
| M13 |  | Partial: `/proc` inspection is Linux-only |  |

## Cleanup

When all scenarios are done:

- [ ] Stop the supervisors and runners that belong to the test HOME only:

  ```sh
  pgrep -af supervisor/entry | grep /tmp/wf-testing
  pgrep -af supervisor/entry | grep /tmp/wf-testing | awk '{print $1}' | xargs -r kill
  ```

  Then check that no workflow runner or leftover test `sleep` remains: `pgrep -af internal-workflow-runner` and `ps -eo pid,args | grep '[s]leep 30'` print nothing for the test runs. Do not use a bare `pkill -f supervisor/entry`; it would also stop the supervisors of your real HOME.
- [ ] Delete the throwaway data and the workflow cwd:

  ```sh
  rm -rf /tmp/wf-testing
  rm -rf /var/tmp/wf-testing
  ```

- [ ] Unset test variables in your shell: `unset WF_SECRET_A WF_SECRET_B FAKE_SECRET`, and open a new terminal so `HOME` points to your real home again.

**Windows (PowerShell, in the dedicated test terminal):**

- [ ] Stop leftover processes that belong to the test profile only, then check nothing remains:

  ```powershell
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*wf-testing*' -and $_.CommandLine -like '*agav*' } | Select-Object ProcessId,CommandLine
  # after checking the list: Stop-Process -Id <pid>   (one pid at a time; never match on 'agav' alone)
  Get-CimInstance Win32_Process | Where-Object CommandLine -like '*internal-workflow-runner*'    # prints nothing
  ```

- [ ] Delete the throwaway profile and workflow cwd: `Remove-Item -Recurse -Force C:\wf-testing`.
- [ ] Restore `USERPROFILE` by closing the dedicated terminal window (do not set it back by hand), and remove any `$env:` test variables (`Remove-Item Env:FAKE_SECRET`). Remove the `agav` function if you pasted it only for this pass.
