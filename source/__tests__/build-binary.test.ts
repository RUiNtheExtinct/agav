import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(platform = 'win32', failure = true, args: string[] = [], powershellFailure = false, realPowerShell = false) {
  const root = mkdtempSync(join(tmpdir(), 'agav-build-diagnostic-'));
  roots.push(root);
  for (const dir of ['scripts', 'source/voice']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync('scripts/build-binary.mjs', join(root, 'scripts/build-binary.mjs'));
  writeFileSync(join(root, 'source/voice/bundled-runtime.ts'), 'original stub\n');
  writeFileSync(join(root, 'scripts/gen-bundled-skills.mjs'), '');
  // Simulate the build host while keeping filesystem paths native to the real host.
  const preload = join(root, 'mock-bun.mjs');
  writeFileSync(preload, `
    import cp from 'node:child_process';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeFileSync } from 'node:fs';
    os.tmpdir = () => ${JSON.stringify(root)};
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    const original = cp.spawnSync;
    cp.spawnSync = (command, args, options) => {
      if (command === 'powershell.exe') {
        if (${realPowerShell}) return original(command, args, options);
        const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
        writeFileSync(${JSON.stringify(join(root, 'powershell-script.txt'))}, script);
        return { status: ${powershellFailure ? 1 : 0}, stderr: ${powershellFailure ? JSON.stringify('access denied') : JSON.stringify('')}, stdout: '' };
      }
      if (command !== 'bun' && command !== 'bun.exe') return original(command, args, options);
      if (args[0] === '--version') return { status: 0 };
      const output = args[args.indexOf('--outfile') + 1];
      if (${failure}) {
        process.stderr.write('failed to move executable to ' + output + ': EPERM\\n');
        return { status: 1 };
      }
      writeFileSync(output, 'compiled executable');
      return { status: 0 };
    };
    syncBuiltinESMExports();
  `);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'scripts/build-binary.mjs'), 'native', ...args], {
    encoding: 'utf8', env: { ...process.env, AGAV_VOICE_HELPER_PATH: '', AGAV_VOICE_HELPER_DIR: '' },
  });
  return { root, result };
}

describe('binary build failure diagnostics', () => {
  it('explains Windows target locks without hiding the Bun error or reporting success', () => {
    const { root, result } = fixture();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed to move executable to ' + join(root, 'dist/agav.exe') + ': EPERM');
    expect(result.stderr).toContain('bun.exe failed (1)');
    expect(result.stderr).toContain('Close Agav sessions and background supervisors running from this path');
    expect(result.stderr).toContain('permissions and antivirus');
    expect(result.stdout).not.toContain('Built:');
    expect(readFileSync(join(root, 'source/voice/bundled-runtime.ts'), 'utf8')).toBe('original stub\n');
  });

  it('only invokes worker termination with the explicit flag and checks the exact output path and worker modes', () => {
    const { root, result } = fixture('win32', false, ['--force-kill-workers']);
    expect(result.status, result.stderr).toBe(0);
    const script = readFileSync(join(root, 'powershell-script.txt'), 'utf8');
    expect(script).toContain(`$target = '${join(root, 'dist/agav.exe')}'`);
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain('[string]::Equals($candidate.ExecutablePath, $target');
    expect(script).toContain('--internal-background-jobs-supervisor');
    expect(script).toContain('--internal-background-jobs-tick');
    expect(script).toContain('--internal-workflow-runner');
    expect(script).toContain('Stop-Process -Id $worker.ProcessId -Force');
    expect(script).toContain('$current.CreationDate -ne $worker.CreationDate');
  });

  it.skipIf(process.platform !== 'win32')('selects only the exact executable and worker flag with real PowerShell (without stopping processes)', () => {
    const { root } = fixture('win32', false, ['--force-kill-workers']);
    const script = readFileSync(join(root, 'powershell-script.txt'), 'utf8');
    const target = join(root, 'dist/agav.exe').replaceAll("'", "''");
    const stub = `
function Get-CimInstance {
  param($Class, $Filter)
  $items = @(
    [pscustomobject]@{ ProcessId = 101; ExecutablePath = '${target}'; CommandLine = '"${target}" --internal-background-jobs-supervisor id'; CreationDate = 'now' },
    [pscustomobject]@{ ProcessId = 102; ExecutablePath = '${target}'; CommandLine = '"${target}" --version'; CreationDate = 'now' },
    [pscustomobject]@{ ProcessId = 103; ExecutablePath = 'C:\\other\\agav.exe'; CommandLine = 'agav.exe --internal-background-jobs-tick'; CreationDate = 'now' }
  )
  if ($Filter -like 'ProcessId*') { return $items | Where-Object ProcessId -eq ([int]($Filter -split ' = ')[1]) }
  return $items
}
function Stop-Process { param($Id, [switch]$Force, $ErrorAction); Write-Output "mock stop $Id" }
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(stub + script, 'utf16le').toString('base64')], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('mock stop 101');
    expect(result.stdout).not.toContain('mock stop 102');
    expect(result.stdout).not.toContain('mock stop 103');
  });

  it.skipIf(process.platform !== 'win32')('runs the real PowerShell worker query for an isolated output path', () => {
    const { root, result } = fixture('win32', false, ['--force-kill-workers'], false, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Built: dist/agav.exe');
    expect(readFileSync(join(root, 'dist/agav.exe'), 'utf8')).toBe('compiled executable');
  });

  it('fails closed if workers cannot be enumerated or stopped', () => {
    const { root, result } = fixture('win32', false, ['--force-kill-workers'], true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('access denied');
    expect(result.stdout).not.toContain('Built:');
    expect(readFileSync(join(root, 'source/voice/bundled-runtime.ts'), 'utf8')).toBe('original stub\n');
  });

  it('rejects the force flag on non-Windows hosts', () => {
    const { result } = fixture('linux', false, ['--force-kill-workers']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('only supported on Windows');
  });

  it('keeps non-Windows failures unchanged', () => {
    const { result } = fixture('linux');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bun failed (1)');
    expect(result.stderr).not.toContain('Close Agav');
  });

  it('still publishes the expected artifact path on success', () => {
    const { root, result } = fixture('win32', false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Built: dist/agav.exe');
    expect(readFileSync(join(root, 'dist/agav.exe'), 'utf8')).toBe('compiled executable');
  });
});