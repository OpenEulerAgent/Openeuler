import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GIT_EXEC_TIMEOUT_MS = 10_000;

/** Structured failure from a `git` invocation; never leaks a shell. */
export class GitError extends Error {
  /** Git's exit code; undefined when git could not be spawned or timed out. */
  readonly exitCode: number | undefined;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cwd: string;
  readonly args: readonly string[];

  constructor(
    message: string,
    details: {
      exitCode?: number;
      stderr?: string;
      timedOut?: boolean;
      cwd: string;
      args: readonly string[];
      cause?: unknown;
    },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GitError";
    this.exitCode = details.exitCode;
    this.stderr = details.stderr ?? "";
    this.timedOut = details.timedOut ?? false;
    this.cwd = details.cwd;
    this.args = details.args;
  }
}

export interface GitExecOptions {
  timeoutMs?: number;
}

/**
 * Runs `git <args>` in `cwd` via execFile (no shell, no interpolation) with a
 * hard timeout, and returns trimmed stdout.
 */
export async function gitExec(
  cwd: string,
  args: readonly string[],
  options: GitExecOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? GIT_EXEC_TIMEOUT_MS;
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (err) {
    const details = err as { code?: number | string; stderr?: string; killed?: boolean };
    const timedOut = details.killed === true;
    throw new GitError(
      `git ${args.join(" ")} failed in ${cwd}${details.stderr ? `: ${details.stderr.trim()}` : ""}`,
      {
        exitCode: typeof details.code === "number" ? details.code : undefined,
        stderr: details.stderr ?? "",
        timedOut,
        cwd,
        args,
        cause: err,
      },
      { cause: err },
    );
  }
}

/** True when the failure is `git` exiting non-zero quietly (e.g. `rev-parse --verify --quiet`). */
export function isGitExitCode(err: unknown, exitCode: number): boolean {
  return err instanceof GitError && err.exitCode === exitCode;
}
