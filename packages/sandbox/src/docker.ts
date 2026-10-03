import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import { cpus } from "node:os";
import { SandboxError } from "./error.js";
import {
  createDockerAvailabilityProbe,
  defaultDockerCliRunner,
  defaultDockerLogsSpawner,
  type DockerCliResult,
  type DockerCliRunner,
  type DockerLogsSource,
  type DockerLogsSpawner,
  docker,
  dockerOk,
  isContainerMissingText,
  isDaemonDown,
  isImageMissingText,
  isNotRunningText,
  stderrTail,
} from "./docker-cli.js";
import type {
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxExecStream,
  SandboxHandle,
  SandboxHandleMeta,
  SandboxHostPorts,
  SandboxLogEntry,
  SandboxLogOptions,
  SandboxProvider,
  SandboxSpec,
  SandboxStatus,
  SandboxSummary,
  SandboxUsage,
} from "./types.js";

/** Docker label marking containers this provider manages (value `1`). */
export const DOCKER_SANDBOX_LABEL = "openeuler.sandbox";
/** Docker label carrying the owning run id. */
export const DOCKER_RUN_LABEL = "openeuler.run";
/** Docker label carrying the spec image (survives `list()` round-trips). */
export const DOCKER_IMAGE_LABEL = "openeuler.image";
/** Docker label carrying the epoch-ms creation time. */
export const DOCKER_CREATED_AT_LABEL = "openeuler.createdAt";

/** Labels owned by the provider; stripped from `list()` summaries. */
const PROVIDER_LABELS = new Set([
  DOCKER_SANDBOX_LABEL,
  DOCKER_RUN_LABEL,
  DOCKER_IMAGE_LABEL,
  DOCKER_CREATED_AT_LABEL,
]);

/** Label namespace owned by the provider; `spec.labels` keys must not use it. */
const RESERVED_LABEL_NAMESPACE = "openeuler.";

/**
 * Conservative image reference grammar: lowercase repo path (with optional
 * `/` separators), optional tag, optional digest. Deliberately rejects
 * anything that could reach docker's flag parser (`--privileged`, refs with
 * leading dash/whitespace) and registry refs containing `:` before the last
 * path segment (e.g. `localhost:5000/img` — rejected in v0.2). Exported for
 * the image-management helpers (`images.ts`) which validate pull refs with
 * the same grammar.
 */
export const IMAGE_REF_PATTERN = /^[a-z0-9._/-]+(:[A-Za-z0-9._-]+)?(@\S+)?$/;

/** Default per-stream byte cap for `logs()` snapshots (truncation beyond). */
export const DEFAULT_LOG_SNAPSHOT_CAP_BYTES = 8 * 1024 * 1024;

/** Construction options for {@link createDockerSandboxProvider}. */
export interface DockerSandboxProviderOptions {
  /** Registry id; defaults to `"docker"`. */
  id?: string;
  /** Injectable CLI runner (defaults to execFile-based `docker`); for tests. */
  runner?: DockerCliRunner;
  /** Injectable spawner used by `logs()` dual-stream demux; for tests. */
  logsSpawner?: DockerLogsSpawner;
  /**
   * Injectable spawner used by `execStream()` live output reading (#104);
   * same shape as `logsSpawner` (any `docker` invocation with piped
   * stdio). Defaults to the shared spawn-based spawner; for tests.
   */
  execSpawner?: DockerLogsSpawner;
  /** Timeout for `docker pull` when the image is missing. Default 300s. */
  pullTimeoutMs?: number;
  /** Default `exec` timeout when the caller passes no `timeoutMs`. Default 300s. */
  execTimeoutMs?: number;
  /** Timeout for control-plane calls (inspect/stop/rm/ps). Default 30s. */
  opTimeoutMs?: number;
  /** Default grace period for `stop()`. Default 10s. */
  stopGraceMs?: number;
  /** Name of the dedicated bridge used for `network: "limited"`. */
  limitedNetworkName?: string;
  /**
   * Command the container runs while idle (the sandbox model is exec-driven:
   * `create` starts an idle keeper and work happens via `exec`). Default
   * `["tail", "-f", "/dev/null"]`.
   */
  idleCommand?: string[];
  /**
   * Host IP published ports bind to (`-p <publishHost>::<containerPort>`).
   * Default `"127.0.0.1"` so published ports are reachable from the host's
   * loopback only, never the outside world.
   */
  publishHost?: string;
  /** Per-stream byte cap for `logs()` snapshots; beyond it the stream is truncated with a marker line. Default 8 MiB. */
  logsCapBytes?: number;
}

interface ResolvedDockerOptions {
  id: string;
  runner: DockerCliRunner;
  logsSpawner: DockerLogsSpawner;
  execSpawner: DockerLogsSpawner;
  pullTimeoutMs: number;
  execTimeoutMs: number;
  opTimeoutMs: number;
  stopGraceMs: number;
  limitedNetworkName: string;
  idleCommand: string[];
  publishHost: string;
  logsCapBytes: number;
}

const DEFAULT_IDLE_COMMAND = ["tail", "-f", "/dev/null"];

/**
 * Single-consumer async queue of exec chunks (#104): producers `push` from
 * stream events, the consumer iterates until `close()` (which ends the
 * iteration with a `null` sentinel). Chunks are buffered unboundedly — the
 * consumer (a driver parser) drains promptly.
 */
class ChunkQueue {
  private readonly items: SandboxExecChunk[] = [];
  private readonly waiters: ((chunk: SandboxExecChunk | null) => void)[] = [];
  private closed = false;

  push(chunk: SandboxExecChunk): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(chunk);
      return;
    }
    this.items.push(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  /** Shared single iterator: repeated `[Symbol.asyncIterator]()` calls return it (a manual `next()` plus a `for await` continues one consumption). */
  iterate(): AsyncIterable<SandboxExecChunk> {
    const iterator: AsyncIterator<SandboxExecChunk> = {
      // Arrow property: `this` stays bound to the queue instance.
      next: async (): Promise<IteratorResult<SandboxExecChunk>> => {
        const item = this.items.shift();
        if (item !== undefined) return { value: item, done: false };
        if (this.closed) return { value: undefined, done: true };
        const chunk = await new Promise<SandboxExecChunk | null>((resolve) => {
          this.waiters.push(resolve);
        });
        return chunk === null ? { value: undefined, done: true } : { value: chunk, done: false };
      },
    };
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<SandboxExecChunk> => iterator,
    };
  }
}

/** `docker inspect` view of one container (only the fields we read). */
interface DockerInspectView {
  State?: { Status?: string };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
}

/** One `docker ps --format json` row (only the fields we read). */
interface DockerPsRow {
  Names?: string;
  Image?: string;
  Labels?: string;
  State?: string;
  CreatedAt?: string;
}

/** Shared env-record validation for spec env and exec-time env. */
function validateEnvRecord(env: Record<string, string>, what: string): void {
  for (const [key, value] of Object.entries(env)) {
    if (key === "" || key.includes("=")) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `${what} env key "${key}" must be non-empty and contain no "="`,
      );
    }
    if (typeof value !== "string") {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `${what} env value for "${key}" must be a string`,
      );
    }
  }
}

function validateSpec(spec: SandboxSpec): void {
  if (typeof spec?.image !== "string" || spec.image.trim() === "") {
    throw new SandboxError("SANDBOX_IMAGE_MISSING", "sandbox spec requires a non-empty image");
  }
  if (
    spec.image.startsWith("-") ||
    spec.image !== spec.image.trim() ||
    !IMAGE_REF_PATTERN.test(spec.image)
  ) {
    throw new SandboxError(
      "SANDBOX_INVALID_SPEC",
      `image ref "${spec.image}" is not a valid image reference (no leading dash/whitespace, no flag-like refs)`,
    );
  }
  if (typeof spec.runId !== "string" || spec.runId.trim() === "") {
    throw new SandboxError("SANDBOX_INVALID_SPEC", "sandbox spec requires a non-empty runId");
  }
  for (const key of Object.keys(spec.labels ?? {})) {
    if (key.startsWith(RESERVED_LABEL_NAMESPACE)) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `label key "${key}" uses the provider-reserved "${RESERVED_LABEL_NAMESPACE}" namespace`,
      );
    }
  }
  for (const mount of spec.mounts ?? []) {
    if (!isAbsolute(mount?.hostPath ?? "")) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `mount hostPath "${mount?.hostPath}" must be an absolute host path`,
      );
    }
    if (!isAbsolute(mount?.containerPath ?? "")) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `mount containerPath "${mount?.containerPath}" must be absolute`,
      );
    }
    if (mount?.hostPath.includes(":")) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `mount hostPath "${mount.hostPath}" must not contain ":" (docker -v separator)`,
      );
    }
    if (mount?.containerPath.includes(":")) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `mount containerPath "${mount.containerPath}" must not contain ":" (docker -v separator)`,
      );
    }
    if (
      mount?.consistency !== undefined &&
      !["consistent", "cached", "delegated"].includes(mount.consistency)
    ) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `mount consistency "${mount.consistency}" must be one of consistent|cached|delegated`,
      );
    }
  }
  for (const volume of spec.volumes ?? []) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume?.name ?? "")) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `volume name "${volume?.name}" is not a valid docker volume name ([a-zA-Z0-9][a-zA-Z0-9_.-]*)`,
      );
    }
    if (!isAbsolute(volume?.containerPath ?? "")) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `volume containerPath "${volume?.containerPath}" must be absolute`,
      );
    }
    if (volume?.containerPath.includes(":")) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `volume containerPath "${volume.containerPath}" must not contain ":" (docker -v separator)`,
      );
    }
  }
  validateEnvRecord(spec.env ?? {}, "spec");
  for (const port of spec.ports ?? []) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `port ${port} must be an integer in [1, 65535]`,
      );
    }
  }
  if (spec.network === "none" && (spec.ports?.length ?? 0) > 0) {
    throw new SandboxError(
      "SANDBOX_INVALID_SPEC",
      'cannot publish ports on a "none" network sandbox (docker requires a network for -p)',
    );
  }
  const resources = spec.resources;
  if (resources) {
    if (resources.cpus !== undefined && (!Number.isFinite(resources.cpus) || resources.cpus <= 0)) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `resources.cpus ${resources.cpus} must be > 0`,
      );
    }
    if (
      resources.memoryMb !== undefined &&
      (!Number.isFinite(resources.memoryMb) || resources.memoryMb <= 0)
    ) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `resources.memoryMb ${resources.memoryMb} must be > 0`,
      );
    }
  }
}

/** Container names must match [a-zA-Z0-9][a-zA-Z0-9_.-]* — sanitize runId. */
function sanitizeRunId(runId: string): string {
  const cleaned = runId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40);
  return cleaned === "" ? "run" : cleaned;
}

function containerName(runId: string): string {
  return `openeuler-${sanitizeRunId(runId)}-${randomBytes(3).toString("hex")}`;
}

function buildRunArgs(
  spec: SandboxSpec,
  name: string,
  createdAt: number,
  options: ResolvedDockerOptions,
): string[] {
  const args = ["run", "-d", "--init", "--name", name];
  args.push("--label", `${DOCKER_SANDBOX_LABEL}=1`);
  args.push("--label", `${DOCKER_RUN_LABEL}=${spec.runId}`);
  args.push("--label", `${DOCKER_IMAGE_LABEL}=${spec.image}`);
  args.push("--label", `${DOCKER_CREATED_AT_LABEL}=${createdAt}`);
  for (const [key, value] of Object.entries(spec.labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }
  // json-file keeps stdout/stderr distinguishable for `docker logs` demux.
  args.push("--log-driver=json-file");
  const workingDir = spec.workingDir ?? (spec.mounts.length > 0 ? "/workspace" : undefined);
  if (workingDir !== undefined) args.push("-w", workingDir);
  for (const mount of spec.mounts) {
    const consistency = mount.consistency === undefined ? "" : `:${mount.consistency}`;
    args.push(
      "-v",
      `${mount.hostPath}:${mount.containerPath}${mount.readonly ? ":ro" : ""}${consistency}`,
    );
  }
  for (const volume of spec.volumes ?? []) {
    // Named volume: docker creates it on first use; contents persist across
    // sandboxes (the run-to-run cache mounts, #102).
    args.push("-v", `${volume.name}:${volume.containerPath}`);
  }
  for (const [key, value] of Object.entries(spec.env)) {
    args.push("-e", `${key}=${value}`);
  }
  for (const port of spec.ports ?? []) {
    // `ip::containerPort` → ephemeral host port bound to publishHost only
    // (default loopback; `-p <port>` would bind 0.0.0.0, exposing the port).
    args.push("-p", `${options.publishHost}::${port}`);
  }
  if (spec.resources?.memoryMb !== undefined) {
    args.push(`--memory=${Math.round(spec.resources.memoryMb)}m`);
  }
  if (spec.resources?.cpus !== undefined) {
    args.push(`--cpus=${spec.resources.cpus}`);
  }
  if (spec.network === "none") {
    args.push("--network", "none");
  } else if (spec.network === "limited") {
    args.push("--network", options.limitedNetworkName);
  }
  args.push(spec.image, ...options.idleCommand);
  return args;
}

function parseHostPorts(
  info: DockerInspectView,
  specPorts: number[] | undefined,
): SandboxHostPorts {
  const published: SandboxHostPorts = {};
  const ports = info.NetworkSettings?.Ports ?? {};
  for (const containerPort of specPorts ?? []) {
    const bindings = ports[`${containerPort}/tcp`] ?? ports[`${containerPort}/udp`];
    if (!bindings || bindings.length === 0) continue;
    const ipv4 = bindings.find((b) => b.HostIp === "0.0.0.0") ?? bindings[0];
    const hostPort = Number.parseInt(ipv4?.HostPort ?? "", 10);
    if (Number.isInteger(hostPort) && hostPort > 0) published[containerPort] = hostPort;
  }
  return published;
}

/** Parse docker's `--format json` Labels string ("k=v,k=v") into a map. */
function parseDockerLabels(joined: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!joined) return labels;
  for (const pair of joined.split(",")) {
    const equals = pair.indexOf("=");
    if (equals <= 0) continue;
    labels[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return labels;
}

/** Strip the `--timestamps` prefix docker prepends to every log line. */
const LOG_TIMESTAMP_PREFIX = /^(\d{4}-\d{2}-\d{2}T[^\s]+) /;

/**
 * Split one `docker logs --timestamps` line into the log-entry fields: the
 * stripped line plus the prefix's epoch ms (`at`, undefined when absent or
 * unparsable — providers only promise `at` on a best-effort basis).
 */
function splitLogTimestampEntry(line: string): Pick<SandboxLogEntry, "line" | "at"> {
  const match = LOG_TIMESTAMP_PREFIX.exec(line);
  if (match === null) return { line };
  const at = Date.parse(match[1] ?? "");
  return Number.isNaN(at) ? { line } : { line: line.slice(match[0].length), at };
}

function mapPsStateToStatus(state: string | undefined): SandboxStatus {
  return state === "running" ? "running" : "exited";
}

class DockerSandboxHandle implements SandboxHandle {
  readonly id: string;
  readonly meta: SandboxHandleMeta;

  private readonly spec: SandboxSpec;
  private readonly options: ResolvedDockerOptions;
  private stoppedByUs = false;
  private destroyed = false;
  private cachedHostPorts: SandboxHostPorts | null = null;

  constructor(config: {
    name: string;
    spec: SandboxSpec;
    options: ResolvedDockerOptions;
    createdAt: number;
    hostPorts: SandboxHostPorts;
  }) {
    this.id = config.name;
    this.spec = config.spec;
    this.options = config.options;
    this.meta = {
      createdAt: config.createdAt,
      image: config.spec.image,
      ports: config.spec.ports ? [...config.spec.ports] : [],
    };
    this.cachedHostPorts = config.hostPorts;
  }

  async status(): Promise<SandboxStatus> {
    if (this.destroyed || this.stoppedByUs) return "stopped";
    const result = await docker(["inspect", "--format", "{{.State.Status}}", this.id], {
      runner: this.options.runner,
      timeoutMs: this.options.opTimeoutMs,
    });
    if (result.code !== 0) {
      if (isContainerMissingText(result.stderr)) return "stopped";
      if (isDaemonDown(result)) {
        throw new SandboxError(
          "SANDBOX_UNAVAILABLE",
          `cannot inspect sandbox "${this.id}" (docker daemon unreachable)`,
        );
      }
      throw new SandboxError(
        "SANDBOX_EXEC_FAILED",
        `docker inspect of sandbox "${this.id}" failed: ${stderrTail(result.stderr)}`,
      );
    }
    return result.stdout.trim() === "running" ? "running" : "exited";
  }

  async exec(cmd: string[], opts?: SandboxExecOptions): Promise<SandboxExecResult> {
    const args = this.buildExecArgs(cmd, opts);
    const startedAt = Date.now();
    const result = await docker(args, {
      runner: this.options.runner,
      // execFile's timeout SIGKILLs the CLI → SANDBOX_TIMEOUT from docker().
      timeoutMs: opts?.timeoutMs ?? this.options.execTimeoutMs,
    });
    if (result.code !== 0) {
      const failureText = `${result.stderr}\n${result.stdout}`;
      if (isNotRunningText(failureText) || isContainerMissingText(failureText)) {
        throw new SandboxError(
          "SANDBOX_UNAVAILABLE",
          `sandbox "${this.id}" is not running; cannot exec ${cmd.join(" ")}`,
        );
      }
      if (isDaemonDown(result)) {
        throw new SandboxError(
          "SANDBOX_UNAVAILABLE",
          `exec "${cmd.join(" ")}" failed (docker daemon unreachable): ${stderrTail(result.stderr)}`,
        );
      }
    }
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Streaming exec (#104): spawns `docker exec` (no `--detach`) with piped
   * stdio and forwards BOTH streams live as {@link SandboxExecChunk}s.
   * `exited` mirrors `exec`'s error taxonomy (`SANDBOX_TIMEOUT` on timeout,
   * `SANDBOX_UNAVAILABLE` when the sandbox/daemon is gone); a non-zero exit
   * is a RESULT, resolved with its code. Note the CLI boundary: killing the
   * CLI (timeout/cancel) stops streaming, but the command itself keeps
   * running inside the sandbox until `stop()`/`destroy()` — callers that
   * need the process gone must stop the sandbox.
   */
  execStream(cmd: string[], opts?: SandboxExecOptions): SandboxExecStream {
    const args = this.buildExecArgs(cmd, opts);
    const startedAt = Date.now();
    const queue = new ChunkQueue();
    let resolveExit!: (exit: { code: number; durationMs: number }) => void;
    let rejectExit!: (error: SandboxError) => void;
    const exited = new Promise<{ code: number; durationMs: number }>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    let child: DockerLogsSource;
    try {
      child = this.options.execSpawner(args);
    } catch (err) {
      queue.close();
      rejectExit(
        new SandboxError(
          "SANDBOX_UNAVAILABLE",
          `exec "${cmd.join(" ")}" in sandbox "${this.id}" failed to spawn: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
      return { events: queue.iterate(), exited };
    }

    let settled = false;
    let timedOut = false;
    let rawStderr = "";
    const stderrCap = this.options.logsCapBytes;
    const timeoutMs = opts?.timeoutMs ?? this.options.execTimeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    timer.unref?.();

    const killChild = (): void => {
      try {
        child.kill?.("SIGKILL");
      } catch {
        // Already gone — the close handler settles.
      }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      queue.close();
      finish();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      queue.push({ stream: "stdout", chunk });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      queue.push({ stream: "stderr", chunk });
      if (rawStderr.length < stderrCap) rawStderr += chunk;
    });
    child.on("error", (err) =>
      settle(() =>
        rejectExit(
          new SandboxError(
            "SANDBOX_UNAVAILABLE",
            `exec "${cmd.join(" ")}" in sandbox "${this.id}" failed: ${err.message}`,
          ),
        ),
      ),
    );
    child.on("close", (code) => {
      if (timedOut) {
        settle(() =>
          rejectExit(
            new SandboxError(
              "SANDBOX_TIMEOUT",
              `exec "${cmd.join(" ")}" in sandbox "${this.id}" timed out after ${timeoutMs}ms`,
            ),
          ),
        );
        return;
      }
      if (code !== 0) {
        const failureText = `${rawStderr}`;
        if (isNotRunningText(failureText) || isContainerMissingText(failureText)) {
          settle(() =>
            rejectExit(
              new SandboxError(
                "SANDBOX_UNAVAILABLE",
                `sandbox "${this.id}" is not running; cannot exec ${cmd.join(" ")}`,
              ),
            ),
          );
          return;
        }
        if (isDaemonDown({ stderr: rawStderr })) {
          settle(() =>
            rejectExit(
              new SandboxError(
                "SANDBOX_UNAVAILABLE",
                `exec "${cmd.join(" ")}" failed (docker daemon unreachable): ${stderrTail(rawStderr)}`,
              ),
            ),
          );
          return;
        }
      }
      const exitCode = code ?? 0;
      settle(() => resolveExit({ code: exitCode, durationMs: Date.now() - startedAt }));
    });

    return {
      events: queue.iterate(),
      exited,
      cancel: () => {
        if (settled) return;
        // Settle BEFORE killing: a synchronous `close` out of killChild()
        // (e.g. test fakes) must not resolve the exit over the cancellation.
        settle(() =>
          rejectExit(
            new SandboxError(
              "SANDBOX_UNAVAILABLE",
              `exec "${cmd.join(" ")}" in sandbox "${this.id}" was cancelled`,
            ),
          ),
        );
        killChild();
      },
    };
  }

  /** Shared exec precondition checks (throw synchronously, like `exec`). */
  private assertExecable(cmd: string[], opts?: SandboxExecOptions): void {
    if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((part) => typeof part !== "string")) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        "exec cmd must be a non-empty array of strings",
      );
    }
    validateEnvRecord(opts?.env ?? {}, "exec");
    if (this.destroyed || this.stoppedByUs) {
      throw new SandboxError(
        "SANDBOX_UNAVAILABLE",
        `sandbox "${this.id}" is not running (destroyed or stopped); cannot exec ${cmd.join(" ")}`,
      );
    }
  }

  /** Builds the `docker exec` argv shared by `exec` and `execStream`. */
  private buildExecArgs(cmd: string[], opts?: SandboxExecOptions): string[] {
    this.assertExecable(cmd, opts);
    const args = ["exec"];
    if (opts?.cwd !== undefined) args.push("-w", opts.cwd);
    for (const [key, value] of Object.entries(opts?.env ?? {})) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(this.id, ...cmd);
    return args;
  }

  logs(opts?: SandboxLogOptions): AsyncIterable<SandboxLogEntry> {
    if (opts?.follow !== undefined && opts.follow !== false) {
      throw new SandboxError("SANDBOX_INVALID_SPEC", "logs follow:true is not supported in v0.2");
    }
    return this.snapshotLogs(opts ?? {});
  }

  /**
   * Single-shot snapshot (v0.2): spawns `docker logs`, reads both pipe
   * streams line-by-line tagging each entry with its source stream. Docker's
   * CLI writes container stdout to its stdout and container stderr to its
   * stderr, so per-stream order is preserved; cross-stream interleaving
   * follows pipe-arrival order (the contract pins per-stream order only).
   * Each stream is capped at `logsCapBytes` (default 8 MiB): crossing the cap
   * emits a truncation marker and stops reading that stream (memory-bounded).
   */
  private async *snapshotLogs(opts: SandboxLogOptions): AsyncIterable<SandboxLogEntry> {
    if (this.destroyed) return;
    const args = ["logs", "--timestamps"];
    if (opts.tail !== undefined) args.push("--tail", String(Math.max(0, Math.trunc(opts.tail))));
    if (opts.since !== undefined) args.push("--since", new Date(opts.since).toISOString());
    args.push(this.id);
    const entries: SandboxLogEntry[] = [];
    const cap = this.options.logsCapBytes;
    await new Promise<void>((resolve, reject) => {
      const child = this.options.logsSpawner(args);
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let rawStderr = "";
      const stdoutInterface = createInterface({ input: child.stdout });
      stdoutInterface.on("line", (line: string) => {
        if (stdoutTruncated) return;
        stdoutBytes += line.length + 1;
        if (stdoutBytes > cap) {
          stdoutTruncated = true;
          entries.push({
            stream: "stdout",
            line: `[openeuler] stdout log snapshot truncated at ${cap} bytes`,
          });
          stdoutInterface.close();
          child.stdout.destroy(); // unblock the CLI's pipe (expected EPIPE exit)
          return;
        }
        entries.push({ stream: "stdout", ...splitLogTimestampEntry(line) });
      });
      const stderrInterface = createInterface({ input: child.stderr });
      stderrInterface.on("line", (line: string) => {
        if (stderrTruncated) return;
        stderrBytes += line.length + 1;
        if (stderrBytes > cap) {
          stderrTruncated = true;
          entries.push({
            stream: "stderr",
            line: `[openeuler] stderr log snapshot truncated at ${cap} bytes`,
          });
          stderrInterface.close();
          child.stderr.destroy();
          return;
        }
        entries.push({ stream: "stderr", ...splitLogTimestampEntry(line) });
        if (rawStderr.length < cap) rawStderr += `${line}\n`;
      });
      let settled = false;
      const settle = (error: Error | undefined): void => {
        if (settled) return;
        settled = true;
        stdoutInterface.close();
        stderrInterface.close();
        if (error) reject(error);
        else resolve();
      };
      child.on("error", (err) =>
        settle(
          new SandboxError(
            "SANDBOX_UNAVAILABLE",
            `docker logs for "${this.id}" failed: ${err.message}`,
          ),
        ),
      );
      child.on("close", (code) => {
        if (code === 0) return settle(undefined);
        // Truncation closes the pipe early; the CLI's non-zero exit from the
        // broken pipe is expected, not a failure.
        if (stdoutTruncated || stderrTruncated) return settle(undefined);
        if (isContainerMissingText(rawStderr)) {
          entries.length = 0; // externally removed → empty stream, diagnostics dropped
          return settle(undefined);
        }
        if (isDaemonDown({ stderr: rawStderr })) {
          return settle(
            new SandboxError(
              "SANDBOX_UNAVAILABLE",
              `docker logs for "${this.id}" failed (daemon unreachable): ${stderrTail(rawStderr)}`,
            ),
          );
        }
        settle(
          new SandboxError(
            "SANDBOX_EXEC_FAILED",
            `docker logs for "${this.id}" failed: ${stderrTail(rawStderr)}`,
          ),
        );
      });
    });
    yield* entries;
  }

  async hostPorts(): Promise<SandboxHostPorts> {
    if (this.destroyed) return {};
    if (this.cachedHostPorts !== null) return { ...this.cachedHostPorts };
    const info = await this.inspect();
    this.cachedHostPorts = parseHostPorts(info, this.spec.ports);
    return { ...this.cachedHostPorts };
  }

  async stop(timeoutMs?: number): Promise<void> {
    if (this.destroyed) return;
    const graceMs = timeoutMs ?? this.options.stopGraceMs;
    const seconds = Math.max(0, Math.ceil(graceMs / 1000));
    const result = await docker(["stop", "-t", String(seconds), this.id], {
      runner: this.options.runner,
      timeoutMs: seconds * 1000 + this.options.opTimeoutMs,
    });
    if (result.code !== 0 && !isContainerMissingText(result.stderr)) {
      throw new SandboxError(
        "SANDBOX_STOP_FAILED",
        `failed to stop sandbox "${this.id}": ${stderrTail(result.stderr)}`,
      );
    }
    this.stoppedByUs = true;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    const result = await docker(["rm", "-f", this.id], {
      runner: this.options.runner,
      timeoutMs: this.options.opTimeoutMs,
    });
    // Only mark destroyed when rm succeeded (or the container is already
    // gone); otherwise the handle stays usable and destroy() is retryable.
    if (result.code !== 0 && !isContainerMissingText(result.stderr)) {
      throw new SandboxError(
        "SANDBOX_EXEC_FAILED",
        `failed to remove sandbox "${this.id}": ${stderrTail(result.stderr)}`,
      );
    }
    this.destroyed = true;
    this.cachedHostPorts = {};
  }

  private async inspect(): Promise<DockerInspectView> {
    const result = await docker(["inspect", this.id], {
      runner: this.options.runner,
      timeoutMs: this.options.opTimeoutMs,
    });
    if (result.code !== 0) {
      if (isDaemonDown(result)) {
        throw new SandboxError(
          "SANDBOX_UNAVAILABLE",
          `cannot inspect sandbox "${this.id}" (docker daemon unreachable)`,
        );
      }
      throw new SandboxError(
        "SANDBOX_UNAVAILABLE",
        `sandbox "${this.id}" no longer exists: ${stderrTail(result.stderr)}`,
      );
    }
    const parsed = JSON.parse(result.stdout) as DockerInspectView[];
    return parsed[0] ?? {};
  }
}

/**
 * Docker-backed {@link SandboxProvider}: real isolation via the docker CLI
 * (execFile, no shell, args arrays only). Docker does NOT need to be available
 * at construction — every operation probes lazily and maps failures onto
 * typed `SandboxError`s.
 */
export class DockerSandboxProvider implements SandboxProvider {
  readonly id: string;

  private readonly options: ResolvedDockerOptions;
  private readonly probe: ReturnType<typeof createDockerAvailabilityProbe>;

  constructor(options: DockerSandboxProviderOptions = {}) {
    this.id = options.id ?? "docker";
    if (
      options.publishHost !== undefined &&
      (typeof options.publishHost !== "string" ||
        options.publishHost.trim() === "" ||
        /\s/.test(options.publishHost))
    ) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `publishHost must be a non-empty, whitespace-free host/IP (got "${String(options.publishHost)}")`,
      );
    }
    if (
      options.logsCapBytes !== undefined &&
      (!Number.isInteger(options.logsCapBytes) || options.logsCapBytes <= 0)
    ) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        `logsCapBytes must be a positive integer (got ${String(options.logsCapBytes)})`,
      );
    }
    this.options = {
      id: this.id,
      runner: options.runner ?? defaultDockerCliRunner,
      logsSpawner: options.logsSpawner ?? defaultDockerLogsSpawner,
      execSpawner: options.execSpawner ?? options.logsSpawner ?? defaultDockerLogsSpawner,
      pullTimeoutMs: options.pullTimeoutMs ?? 300_000,
      execTimeoutMs: options.execTimeoutMs ?? 300_000,
      opTimeoutMs: options.opTimeoutMs ?? 30_000,
      stopGraceMs: options.stopGraceMs ?? 10_000,
      limitedNetworkName: options.limitedNetworkName ?? "openeuler-limited",
      idleCommand: options.idleCommand ?? [...DEFAULT_IDLE_COMMAND],
      publishHost: options.publishHost ?? "127.0.0.1",
      logsCapBytes: options.logsCapBytes ?? DEFAULT_LOG_SNAPSHOT_CAP_BYTES,
    };
    this.probe = createDockerAvailabilityProbe(this.options.runner);
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    validateSpec(spec);
    if (!(await this.probe.check())) {
      throw new SandboxError(
        "SANDBOX_UNAVAILABLE",
        "docker is not available (CLI missing from PATH or daemon unreachable)",
      );
    }
    await this.ensureImage(spec.image);
    if (spec.network === "limited") await this.ensureLimitedNetwork();

    let lastFailure: SandboxError | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const name = containerName(spec.runId);
      const createdAt = Date.now();
      const runArgs = buildRunArgs(spec, name, createdAt, this.options);
      let started: DockerCliResult;
      try {
        started = await docker(runArgs, {
          runner: this.options.runner,
          timeoutMs: this.options.opTimeoutMs,
        });
      } catch (err) {
        // The CLI died mid-run (timeout/spawn failure): the container may
        // exist under our unique name — best-effort cleanup, then rethrow.
        await this.bestEffortRemove(name);
        throw err;
      }
      if (started.code === 0) {
        try {
          return await this.buildHandle(spec, name, createdAt);
        } catch (err) {
          // Container is running but post-start inspect failed — remove the
          // leaked container (best-effort), then rethrow the typed error.
          await this.bestEffortRemove(name);
          throw err;
        }
      }
      if (isDaemonDown(started)) {
        throw new SandboxError(
          "SANDBOX_UNAVAILABLE",
          `failed to start sandbox from "${spec.image}" (docker daemon unreachable): ${stderrTail(started.stderr)}`,
        );
      }
      if (isImageMissingText(started.stderr)) {
        throw new SandboxError(
          "SANDBOX_IMAGE_MISSING",
          `failed to start sandbox from "${spec.image}" (image not available): ${stderrTail(started.stderr)}`,
        );
      }
      if (/already in use/i.test(started.stderr)) {
        lastFailure = new SandboxError(
          "SANDBOX_EXEC_FAILED",
          `container name collision for "${name}": ${stderrTail(started.stderr)}`,
        );
        continue; // extremely unlikely (random suffix) — retry with a new name
      }
      throw new SandboxError(
        "SANDBOX_EXEC_FAILED",
        `failed to start sandbox from "${spec.image}": ${stderrTail(started.stderr)}`,
      );
    }
    throw lastFailure ?? new SandboxError("SANDBOX_EXEC_FAILED", "failed to start sandbox");
  }

  async list(labelSelector?: Record<string, string>): Promise<SandboxSummary[]> {
    const args = ["ps", "-a", "--filter", `label=${DOCKER_SANDBOX_LABEL}=1`];
    for (const [key, value] of Object.entries(labelSelector ?? {})) {
      args.push("--filter", `label=${key}=${value}`);
    }
    args.push("--format", "json");
    const result = await dockerOk(args, {
      runner: this.options.runner,
      timeoutMs: this.options.opTimeoutMs,
      what: `docker ps for sandbox list`,
    });
    const summaries: SandboxSummary[] = [];
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const row = JSON.parse(trimmed) as DockerPsRow;
      const labels = parseDockerLabels(row.Labels);
      const reportedLabels: Record<string, string> = {};
      for (const [key, value] of Object.entries(labels)) {
        if (!PROVIDER_LABELS.has(key)) reportedLabels[key] = value;
      }
      // Docker filters server-side; re-check the subset client-side so the
      // semantics hold regardless of daemon-side parsing quirks.
      const selectorEntries = Object.entries(labelSelector ?? {});
      if (selectorEntries.some(([key, value]) => labels[key] !== value)) continue;
      const createdAt = Number.parseInt(labels[DOCKER_CREATED_AT_LABEL] ?? "", 10);
      summaries.push({
        id: row.Names ?? "",
        labels: reportedLabels,
        image: labels[DOCKER_IMAGE_LABEL] ?? row.Image ?? "",
        status: mapPsStateToStatus(row.State),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.parse(row.CreatedAt ?? "") || 0,
      });
    }
    return summaries;
  }

  async stats(): Promise<SandboxUsage[]> {
    // Scope stats to provider-managed sandboxes only — `docker stats` without
    // ids would cover EVERY container on the host, ours or not.
    const ids = (await this.list()).map((summary) => summary.id).filter((id) => id !== "");
    if (ids.length === 0) return [];
    const result = await dockerOk(["stats", "--no-stream", "--format", "json", ...ids], {
      runner: this.options.runner,
      timeoutMs: this.options.opTimeoutMs,
      what: "docker stats",
    });
    const hostCpus = cpus().length || 1;
    const usage: SandboxUsage[] = [];
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const row = JSON.parse(trimmed) as { Name?: string; CPUPerc?: string; MemUsage?: string };
      const cpuPercent = Number.parseFloat((row.CPUPerc ?? "").replace("%", ""));
      usage.push({
        id: row.Name ?? "",
        cpus: Number.isFinite(cpuPercent) ? (cpuPercent / 100) * hostCpus : undefined,
        memoryMb: parseMemoryUsageMb(row.MemUsage),
      });
    }
    return usage;
  }

  /**
   * Destroy by `list()` id (the GC path, #105): `docker rm -f` is idempotent
   * — an already-missing container resolves, provider failures reject with a
   * typed `SandboxError` (the GC logs and retries next pass).
   */
  async destroy(id: string): Promise<void> {
    const result = await docker(["rm", "-f", id], {
      runner: this.options.runner,
      timeoutMs: this.options.opTimeoutMs,
    });
    if (result.code !== 0 && !isContainerMissingText(result.stderr)) {
      throw new SandboxError(
        "SANDBOX_EXEC_FAILED",
        `failed to remove sandbox "${id}": ${stderrTail(result.stderr)}`,
      );
    }
  }

  /**
   * Graceful stop by `list()` id (#112, the sandboxes dashboard): same
   * `docker stop -t <grace>` the handle's `stop()` builds; the container is
   * kept (inspectable, listed as `stopped`). Stopping an already-stopped
   * container is a docker no-op; a missing one resolves (idempotent).
   */
  async stop(id: string): Promise<void> {
    const seconds = Math.max(0, Math.ceil(this.options.stopGraceMs / 1000));
    const result = await docker(["stop", "-t", String(seconds), id], {
      runner: this.options.runner,
      timeoutMs: seconds * 1000 + this.options.opTimeoutMs,
    });
    if (result.code !== 0 && !isContainerMissingText(result.stderr)) {
      throw new SandboxError(
        "SANDBOX_STOP_FAILED",
        `failed to stop sandbox "${id}": ${stderrTail(result.stderr)}`,
      );
    }
  }

  /**
   * Best-effort `rm -f` used by `create()` cleanup paths: the name is ours
   * and freshly generated, so removing it can never hit a foreign container;
   * every failure is swallowed (the original error is what matters).
   */
  private async bestEffortRemove(name: string): Promise<void> {
    try {
      await docker(["rm", "-f", name], {
        runner: this.options.runner,
        timeoutMs: this.options.opTimeoutMs,
      });
    } catch {
      // Best-effort only: CLI/daemon being down must not mask the real error.
    }
  }

  /**
   * Pull policy `never-if-exists`: when the image is present locally, never
   * pull; when missing, attempt one `docker pull` and surface failure as
   * `SANDBOX_IMAGE_MISSING`.
   */
  private async ensureImage(image: string): Promise<void> {
    const inspect = await docker(["image", "inspect", image], {
      runner: this.options.runner,
      timeoutMs: this.options.opTimeoutMs,
    });
    if (inspect.code === 0) return;
    if (isDaemonDown(inspect)) {
      throw new SandboxError(
        "SANDBOX_UNAVAILABLE",
        `cannot verify image "${image}" (docker daemon unreachable)`,
      );
    }
    const pull = await docker(["pull", image], {
      runner: this.options.runner,
      timeoutMs: this.options.pullTimeoutMs,
    });
    if (pull.code !== 0) {
      if (isDaemonDown(pull)) {
        throw new SandboxError(
          "SANDBOX_UNAVAILABLE",
          `pull of "${image}" failed (docker daemon unreachable): ${stderrTail(pull.stderr)}`,
        );
      }
      throw new SandboxError(
        "SANDBOX_IMAGE_MISSING",
        `image "${image}" is not present locally and could not be pulled: ${stderrTail(pull.stderr)}`,
      );
    }
  }

  /** Creates the dedicated `limited` bridge on demand (idempotent). */
  private async ensureLimitedNetwork(): Promise<void> {
    const inspect = await docker(["network", "inspect", this.options.limitedNetworkName], {
      runner: this.options.runner,
      timeoutMs: this.options.opTimeoutMs,
    });
    if (inspect.code === 0) return;
    if (isDaemonDown(inspect)) {
      throw new SandboxError(
        "SANDBOX_UNAVAILABLE",
        `cannot inspect network "${this.options.limitedNetworkName}" (docker daemon unreachable)`,
      );
    }
    const created = await docker(
      ["network", "create", "--driver", "bridge", this.options.limitedNetworkName],
      { runner: this.options.runner, timeoutMs: this.options.opTimeoutMs },
    );
    if (created.code !== 0 && !/already exists/i.test(created.stderr)) {
      throw new SandboxError(
        "SANDBOX_EXEC_FAILED",
        `failed to create limited network "${this.options.limitedNetworkName}": ${stderrTail(created.stderr)}`,
      );
    }
  }

  private async buildHandle(
    spec: SandboxSpec,
    name: string,
    createdAt: number,
  ): Promise<DockerSandboxHandle> {
    const info = await dockerOk(["inspect", name], {
      runner: this.options.runner,
      timeoutMs: this.options.opTimeoutMs,
      what: `docker inspect of started sandbox "${name}"`,
    });
    const view = (JSON.parse(info.stdout) as DockerInspectView[])[0] ?? {};
    return new DockerSandboxHandle({
      name,
      spec,
      options: this.options,
      createdAt,
      hostPorts: parseHostPorts(view, spec.ports),
    });
  }
}

/** `docker stats` MemUsage looks like `"12.3MiB / 256MiB"` — parse the used part. */
function parseMemoryUsageMb(memUsage: string | undefined): number | undefined {
  if (!memUsage) return undefined;
  const used = memUsage.split("/")[0]?.trim() ?? "";
  const match = /^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|KB|MB|GB)$/.exec(used);
  const value = match === null ? Number.NaN : Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(value)) return undefined;
  const factors: Record<string, number> = {
    B: 1 / (1024 * 1024),
    KiB: 1 / 1024,
    kB: 1 / 1024,
    KB: 1 / 1024,
    MiB: 1,
    MB: 1,
    GiB: 1024,
    GB: 1024,
    TiB: 1024 * 1024,
  };
  const factor = factors[match?.[2] ?? ""];
  return factor === undefined ? undefined : value * factor;
}

/** Create a docker-backed sandbox provider. Docker is probed lazily per call. */
export function createDockerSandboxProvider(
  options: DockerSandboxProviderOptions = {},
): DockerSandboxProvider {
  return new DockerSandboxProvider(options);
}
