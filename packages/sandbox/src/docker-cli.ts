import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import { SandboxError } from "./error.js";

const execFileAsync = promisify(execFile);

/** Binary the wrapper invokes; resolved from PATH, never through a shell. */
export const DOCKER_CLI = "docker";

/**
 * Classifies one execFile failure (callback or promise flavor) exactly like
 * {@link defaultDockerCliRunner}: resolves non-zero exits as data, throws
 * typed `DockerCliError`s for infrastructure failures. Shared so the stdin
 * runner below keeps identical semantics.
 */
function classifyExecFileFailure(
  err: unknown,
  ctx: { args: readonly string[]; timeoutMs: number; stdout?: string; stderr?: string },
): DockerCliResult {
  const details = err as {
    code?: number | string;
    stdout?: string;
    stderr?: string;
    killed?: boolean;
  };
  if (details.code === "ENOENT") {
    throw new DockerCliError(
      `docker CLI not found in PATH (tried "${DOCKER_CLI}")`,
      { failedToSpawn: true, args: ctx.args, cause: err },
      { cause: err },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  // maxBuffer kills also set killed:true — classify them BEFORE timeouts.
  if (details.code === "ENOBUFS" || /maxBuffer (?:length |size )?exceeded/i.test(message)) {
    throw new DockerCliError(
      `docker ${argvSummary(ctx.args)} output exceeded maxBuffer (${DOCKER_CLI_MAX_BUFFER_BYTES} bytes)`,
      { maxBufferExceeded: true, args: ctx.args, cause: err },
      { cause: err },
    );
  }
  if (details.killed === true) {
    throw new DockerCliError(
      `docker ${argvSummary(ctx.args)} timed out after ${ctx.timeoutMs}ms`,
      { timedOut: true, args: ctx.args, cause: err },
      { cause: err },
    );
  }
  if (typeof details.code === "number") {
    return {
      code: details.code,
      stdout: details.stdout ?? ctx.stdout ?? "",
      stderr: details.stderr ?? ctx.stderr ?? "",
    };
  }
  throw new DockerCliError(
    `docker ${argvSummary(ctx.args)} could not be executed: ${message}`,
    { failedToSpawn: true, args: ctx.args, cause: err },
    { cause: err },
  );
}

/** Default timeout for one docker CLI invocation. */
export const DOCKER_CLI_TIMEOUT_MS = 60_000;

/** Output cap enforced per CLI invocation (stdout/stderr combined). */
export const DOCKER_CLI_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Renders an argv array for error messages with `-e K=V` values redacted —
 * environment values must never leak into logs or error text.
 */
export function argvSummary(args: readonly string[]): string {
  return args
    .map((arg, index) => {
      if (args[index - 1] === "-e") {
        const key = arg.split("=", 1)[0] ?? "";
        return key === "" || key === arg ? "***" : `${key}=***`;
      }
      return arg;
    })
    .join(" ");
}

/** Availability probe result is cached this long. */
export const DOCKER_AVAILABILITY_TTL_MS = 30_000;

/** Raw outcome of one docker CLI invocation; any exit code resolves. */
export interface DockerCliResult {
  /** Process exit code. */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Infrastructure failure while *running* the docker CLI (as opposed to the
 * command exiting non-zero). Carries enough structure for {@link docker} to
 * map onto `SandboxError` codes.
 */
export class DockerCliError extends Error {
  /** True when the invocation exceeded its timeout and was SIGKILLed. */
  readonly timedOut: boolean;
  /** True when the docker binary could not be spawned at all (e.g. ENOENT). */
  readonly failedToSpawn: boolean;
  /** True when the invocation's output exceeded the runner's maxBuffer. */
  readonly maxBufferExceeded: boolean;
  /** The args that were attempted. */
  readonly args: readonly string[];

  constructor(
    message: string,
    details: {
      timedOut?: boolean;
      failedToSpawn?: boolean;
      maxBufferExceeded?: boolean;
      args?: readonly string[];
      cause?: unknown;
    } = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DockerCliError";
    this.timedOut = details.timedOut ?? false;
    this.failedToSpawn = details.failedToSpawn ?? false;
    this.maxBufferExceeded = details.maxBufferExceeded ?? false;
    this.args = details.args ?? [];
  }
}

/**
 * Runs one docker CLI invocation. Resolves with `{code, stdout, stderr}` for
 * ANY process exit code (non-zero is data, not failure) so callers can apply
 * command-specific interpretation. Rejects with `DockerCliError` only for
 * infrastructure failures: spawn errors and timeouts.
 */
export type DockerCliRunner = (
  args: readonly string[],
  options: { timeoutMs?: number },
) => Promise<DockerCliResult>;

/** execFile-based runner: no shell, args array only, hard SIGKILL timeout. */
export const defaultDockerCliRunner: DockerCliRunner = async (args, options) => {
  const timeoutMs = options.timeoutMs ?? DOCKER_CLI_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execFileAsync(DOCKER_CLI, args, {
      timeout: timeoutMs,
      // execFile's timeout signal: kill the CLI immediately, no grace period.
      killSignal: "SIGKILL",
      maxBuffer: DOCKER_CLI_MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return classifyExecFileFailure(err, { args, timeoutMs });
  }
};

/**
 * Runs one docker CLI invocation with `input` written to the child's stdin
 * (used by `docker build -` to send a Dockerfile without a context
 * directory). Same argv-only/no-shell guarantees and the same failure
 * classification as {@link defaultDockerCliRunner}.
 */
export type DockerStdinCliRunner = (
  args: readonly string[],
  input: string,
  options: { timeoutMs?: number },
) => Promise<DockerCliResult>;

export const defaultDockerStdinCliRunner: DockerStdinCliRunner = (args, input, options) =>
  new Promise<DockerCliResult>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DOCKER_CLI_TIMEOUT_MS;
    const child = execFile(
      DOCKER_CLI,
      args,
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: DOCKER_CLI_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        try {
          resolve(classifyExecFileFailure(err, { args, timeoutMs, stdout, stderr }));
        } catch (classified) {
          reject(classified);
        }
      },
    );
    // The CLI may exit before draining stdin (e.g. an early build failure);
    // the EPIPE is expected and the exit code carries the real story.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });

/** Trailing `max` characters of stderr, whitespace-trimmed (error-message tail). */
export function stderrTail(stderr: string, max = 400): string {
  const text = stderr.trim();
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

/** True when the CLI output indicates the docker daemon is unreachable. */
export function isDaemonDown(result: { stderr: string }): boolean {
  return /cannot connect to the docker daemon|error during connect|is the docker daemon running|docker daemon is not running/i.test(
    result.stderr,
  );
}

/** True when the CLI output indicates the referenced image does not exist / is unpullable. */
export function isImageMissingText(text: string): boolean {
  return (
    /unable to find image/i.test(text) ||
    /manifest unknown/i.test(text) ||
    /manifest for .* not found/i.test(text) ||
    /pull access denied/i.test(text) ||
    /repository does not exist/i.test(text) ||
    /no such image/i.test(text) ||
    /requested access to the resource is denied/i.test(text)
  );
}

/** True when the CLI output indicates the referenced container does not exist. */
export function isContainerMissingText(text: string): boolean {
  return /no such container/i.test(text);
}

/** True when the CLI output indicates the container is not currently running. */
export function isNotRunningText(text: string): boolean {
  return /is not running/i.test(text);
}

/**
 * Runs `docker <args>` via `runner` and resolves the raw result (any exit
 * code). Infrastructure failures map to typed `SandboxError`s: CLI missing or
 * daemon unreachable → `SANDBOX_UNAVAILABLE`; timeout → `SANDBOX_TIMEOUT`.
 * Non-zero exit codes are returned as data for command-specific handling.
 */
export async function docker(
  args: readonly string[],
  options: { timeoutMs?: number; runner?: DockerCliRunner } = {},
): Promise<DockerCliResult> {
  const runner = options.runner ?? defaultDockerCliRunner;
  try {
    return await runner(args, { timeoutMs: options.timeoutMs });
  } catch (err) {
    if (err instanceof DockerCliError) {
      if (err.timedOut) {
        throw new SandboxError(
          "SANDBOX_TIMEOUT",
          `docker ${argvSummary(args)} timed out: ${err.message}`,
        );
      }
      if (err.maxBufferExceeded) {
        throw new SandboxError(
          "SANDBOX_EXEC_FAILED",
          `docker ${argvSummary(args)} output exceeded the CLI maxBuffer (${DOCKER_CLI_MAX_BUFFER_BYTES} bytes): ${err.message}`,
        );
      }
      throw new SandboxError("SANDBOX_UNAVAILABLE", `docker CLI unavailable: ${err.message}`);
    }
    if (err instanceof SandboxError) throw err;
    throw new SandboxError(
      "SANDBOX_EXEC_FAILED",
      `docker ${argvSummary(args)} failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Runs `docker <args>` and requires exit code 0. Non-zero exits map to typed
 * `SandboxError`s: daemon down → `SANDBOX_UNAVAILABLE`; image-missing output →
 * `SANDBOX_IMAGE_MISSING`; anything else → `fallbackCode` with the stderr tail.
 */
export async function dockerOk(
  args: readonly string[],
  options: {
    timeoutMs?: number;
    runner?: DockerCliRunner;
    what: string;
    fallbackCode?: "SANDBOX_EXEC_FAILED" | "SANDBOX_UNAVAILABLE" | "SANDBOX_STOP_FAILED";
  },
): Promise<DockerCliResult> {
  const result = await docker(args, options);
  if (result.code === 0) return result;
  const tail = stderrTail(result.stderr) || `exit code ${result.code}`;
  if (isDaemonDown(result)) {
    throw new SandboxError(
      "SANDBOX_UNAVAILABLE",
      `${options.what} failed (docker daemon unreachable): ${tail}`,
    );
  }
  if (isImageMissingText(result.stderr) && options.fallbackCode !== "SANDBOX_STOP_FAILED") {
    throw new SandboxError(
      "SANDBOX_IMAGE_MISSING",
      `${options.what} failed (image not available): ${tail}`,
    );
  }
  throw new SandboxError(
    options.fallbackCode ?? "SANDBOX_EXEC_FAILED",
    `${options.what} failed: ${tail}`,
  );
}

/**
 * A log source for `docker logs` demux: two piped streams plus a close
 * event. `kill` is present on real spawn() children (used by
 * {@link SandboxHandle.execStream} timeouts/cancel); test fakes may omit it.
 */
export interface DockerLogsSource {
  stdout: Readable;
  stderr: Readable;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  /** Best-effort signal delivery to the CLI process; optional for fakes. */
  kill?(signal?: NodeJS.Signals): void;
}

/** Spawns `docker <args>` with piped stdio for dual-stream reading. */
export type DockerLogsSpawner = (args: readonly string[]) => DockerLogsSource;

export const defaultDockerLogsSpawner: DockerLogsSpawner = (args) =>
  // Structurally compatible: real spawn() with piped stdio has both streams.
  spawn(DOCKER_CLI, args, { stdio: ["ignore", "pipe", "pipe"] }) as unknown as DockerLogsSource;

export interface DockerAvailabilityProbe {
  /** True when `docker info` succeeds; cached for the probe's TTL. */
  check(options?: { force?: boolean }): Promise<boolean>;
  /** Drop the cached value. */
  reset(): void;
}

/**
 * Cached `docker info` probe. A dedicated instance per provider keeps caches
 * isolated (tests inject their own runners).
 */
export function createDockerAvailabilityProbe(
  runner: DockerCliRunner = defaultDockerCliRunner,
  ttlMs: number = DOCKER_AVAILABILITY_TTL_MS,
): DockerAvailabilityProbe {
  let cachedAt = 0;
  let cachedValue: boolean | null = null;
  return {
    async check(options = {}): Promise<boolean> {
      if (!options.force && cachedValue !== null && Date.now() - cachedAt < ttlMs) {
        return cachedValue;
      }
      let value = false;
      try {
        const result = await docker(["info", "--format", "{{.ServerVersion}}"], {
          runner,
          timeoutMs: 10_000,
        });
        value = result.code === 0;
      } catch {
        value = false;
      }
      cachedAt = Date.now();
      cachedValue = value;
      return value;
    },
    reset(): void {
      cachedValue = null;
      cachedAt = 0;
    },
  };
}

const moduleProbe = createDockerAvailabilityProbe();

/**
 * Availability of the default docker CLI + daemon, cached 30s. Cheap enough
 * to call per operation; providers use their own injected-runner probe.
 */
export async function dockerAvailable(options: { force?: boolean } = {}): Promise<boolean> {
  return moduleProbe.check(options);
}
