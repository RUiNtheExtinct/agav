import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(platform = 'win32', failure = true) {
  const root = mkdtempSync(join(tmpdir(), 'agav-build-diagnostic-'));
  roots.push(root);
  for (const dir of ['scripts', 'source/voice']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync('scripts/build-binary.mjs', join(root, 'scripts/build-binary.mjs'));
  writeFileSync(join(root, 'source/voice/bundled-runtime.ts'), 'original stub\n');
  writeFileSync(join(root, 'scripts/gen-bundled-skills.mjs'), '');
  // Mock only Bun in an isolated subprocess; keep real filesystem and Node execution.
  const preload = join(root, 'mock-bun.mjs');
  writeFileSync(preload, `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeFileSync } from 'node:fs';
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    const original = cp.spawnSync;
    cp.spawnSync = (command, args, options) => {
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
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'scripts/build-binary.mjs'), 'native'], {
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
