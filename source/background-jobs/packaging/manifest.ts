/** `minNodeVersion` mirrors `engines.node` in package.json; the supervisor runs on the same Node binary as the CLI. */
export const SUPERVISOR_RUNTIME = {
  kind: "node" as const,
  minNodeVersion: "22.13.0",
};

/** Always the currently-running Node executable; never a bundled or downloaded runtime. */
export function getNodeRuntimeInvocation(): { executable: string; prependArgs: string[] } {
  return {
    executable: process.execPath,
    prependArgs: [],
  };
}

export interface AssetManifestEntry {
  platform: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64";
  relativePath: string;
}

/**
 * Intentionally empty: no native Windows Job Object helper is bundled, so the Windows
 * adapter reports `nativeHelperAvailable: false` (see `platform/windows.ts`).
 */
export const WINDOWS_HELPER_ASSETS: AssetManifestEntry[] = [];

/** Private self-reexec mode; not a user command or an authorization bypass. */
export const SUPERVISOR_INTERNAL_FLAG = "--internal-background-jobs-supervisor";

/**
 * Private headless mode that runs exactly one background-jobs tick and exits
 * without rendering the Ink UI. Invoked by packaged binaries and OS-scheduler
 * entries (systemd/launchd/Task Scheduler); not a user command, never listed
 * in `--help`, and not an authorization bypass.
 */
export const BACKGROUND_TICK_INTERNAL_FLAG = "--internal-background-jobs-tick";

/**
 * Private headless mode that executes one workflow run (`<flag> <runId>`) as a supervised background job
 * and exits without rendering the Ink UI. Not a user command and not an authorization bypass.
 */
export const WORKFLOW_RUNNER_INTERNAL_FLAG = "--internal-workflow-runner";

/** Every private self-reexec flag recognised as `process.argv[2]` by `cli.tsx`. */
export const INTERNAL_FLAGS = [SUPERVISOR_INTERNAL_FLAG, BACKGROUND_TICK_INTERNAL_FLAG, WORKFLOW_RUNNER_INTERNAL_FLAG] as const;

/**
 * Arguments that make the current executable run one headless tick.
 * Standalone binaries reexec themselves directly; Node installs must prepend
 * the CLI entry script (`cliEntryPath`) before the flag.
 */
export function getBackgroundTickArgs(cliEntryPath?: string): string[] {
  return cliEntryPath ? [cliEntryPath, BACKGROUND_TICK_INTERNAL_FLAG] : [BACKGROUND_TICK_INTERNAL_FLAG];
}

/**
 * Arguments that make the current executable run one headless workflow runner (`[<cli>] <flag> <runId>`).
 * Standalone binaries reexec themselves directly (their `process.argv[1]` is a virtual, non-executable path);
 * Node installs must prepend the CLI entry script. Pass `cliEntryPath` only for Node installs.
 */
export function getWorkflowRunnerArgs(runId: string, cliEntryPath?: string): string[] {
  return cliEntryPath ? [cliEntryPath, WORKFLOW_RUNNER_INTERNAL_FLAG, runId] : [WORKFLOW_RUNNER_INTERNAL_FLAG, runId];
}

/** Bun standalone module URLs are virtual, not externally executable JS files. */
export function isStandaloneBinary(moduleUrl: string = import.meta.url): boolean {
  return /^file:\/\/\/(?:\$bunfs\/|[a-z]:\/(?:~|%7e)BUN\/)/i.test(moduleUrl);
}
