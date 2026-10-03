/** Directory bind-mount into a sandbox. */
export interface SandboxMount {
  /** Absolute path on the host. */
  hostPath: string;
  /** Absolute path inside the sandbox. */
  containerPath: string;
  /** Mount read-only when true. */
  readonly?: boolean;
  /**
   * Bind consistency hint appended to the `-v` spec (`:cached` etc.). A
   * documented no-op on native Linux daemons; meaningful on Docker Desktop.
   */
  consistency?: "consistent" | "cached" | "delegated";
}

/**
 * Named volume mounted into a sandbox (#102). Unlike {@link SandboxMount}
 * this is a docker-managed named volume (docker auto-creates it on first
 * use), so its contents persist across sandboxes — the run-to-run cache
 * mounts (`policy.cachePaths`).
 */
export interface SandboxVolume {
  /** Docker volume name (`[a-zA-Z0-9][a-zA-Z0-9_.-]*`). */
  name: string;
  /** Absolute path inside the sandbox the volume is mounted at. */
  containerPath: string;
}

/** CPU/memory constraints for a sandbox. */
export interface SandboxResources {
  cpus?: number;
  memoryMb?: number;
}

/**
 * Network exposure of a sandbox.
 * - `none` — fully isolated (no networking, not even DNS)
 * - `limited` — outbound DNS resolution plus an operator-configured egress
 *   allowlist; everything else blocked. Providers without native support
 *   approximate this (the docker provider uses a dedicated bridge network
 *   with DNS plus documented allowlist plumbing) and MUST document their
 *   approximation in the provider README.
 * - `default` — normal outbound access.
 */
export type SandboxNetworkMode = "none" | "limited" | "default";

/** Requested sandbox configuration, validated by providers at `create()`. */
export interface SandboxSpec {
  /** Id of the run this sandbox belongs to. */
  runId: string;
  /** Container image to run, e.g. `"openeuler/worker:latest"`. */
  image: string;
  /** Directory bind-mounts. May be empty. */
  mounts: SandboxMount[];
  /** Named volumes (persist across sandboxes; e.g. dependency caches). May be empty. */
  volumes?: SandboxVolume[];
  /** Environment variables set inside the sandbox. */
  env: Record<string, string>;
  /** Container ports to publish; mapped to ephemeral host ports. */
  ports?: number[];
  /** Resource limits. */
  resources?: SandboxResources;
  /** Network mode; providers may default this. */
  network?: SandboxNetworkMode;
  /** Labels used for discovery/filtering via `SandboxProvider.list()`. */
  labels?: Record<string, string>;
  /** Initial working directory inside the sandbox. */
  workingDir?: string;
}

/** Lifecycle state of a sandbox. `stopped` = stopped via `handle.stop()`. */
export type SandboxStatus = "running" | "exited" | "stopped";

/** Options for {@link SandboxHandle.exec}. */
export interface SandboxExecOptions {
  /** Kill the command and reject with `SANDBOX_TIMEOUT` after this many ms. */
  timeoutMs?: number;
  /** Working directory for this command (default: spec `workingDir`). */
  cwd?: string;
  /** Extra environment variables for this command only. */
  env?: Record<string, string>;
}

/** Result of one {@link SandboxHandle.exec} invocation. */
export interface SandboxExecResult {
  /** Process exit code. Non-zero is a *result*, not an error. */
  code: number;
  stdout: string;
  stderr: string;
  /** Wall-clock duration of the command in ms. */
  durationMs: number;
}

/**
 * One output chunk of a streaming {@link SandboxHandle.execStream} command.
 * Chunks arrive as the command produces them (unsplittable writes may be
 * split or coalesced by the transport); per-stream ORDER is guaranteed,
 * cross-stream interleaving is arrival-order.
 */
export interface SandboxExecChunk {
  stream: "stdout" | "stderr";
  chunk: string;
}

/** Completion of a streaming {@link SandboxHandle.execStream} command. */
export interface SandboxExecExit {
  /** Process exit code. Non-zero is a *result*, not an error. */
  code: number;
  /** Wall-clock duration of the command in ms. */
  durationMs: number;
}

/**
 * Live view of one running {@link SandboxHandle.execStream} command (#104):
 * `events` yields chunks as they arrive (ends when the command's streams
 * close), `exited` settles exactly once with the exit code — or rejects with
 * `SandboxError` (`SANDBOX_TIMEOUT`, `SANDBOX_UNAVAILABLE`, …) when the
 * execution failed or was cancelled. `cancel()` best-effort stops the local
 * CLI process (the command may keep running in the sandbox until
 * `stop()`/`destroy()`); afterwards `events` ends and `exited` rejects with
 * `SANDBOX_UNAVAILABLE`.
 */
export interface SandboxExecStream {
  /** Output chunks in arrival order; single consumer. */
  events: AsyncIterable<SandboxExecChunk>;
  /** Resolves once with the exit; rejects on execution failure/cancel. */
  exited: Promise<SandboxExecExit>;
  /** Best-effort cancel; never throws. Optional (providers may lack it). */
  cancel?(): void;
}

/** One log line streamed from a sandbox. */
export interface SandboxLogEntry {
  stream: "stdout" | "stderr";
  line: string;
  /**
   * Epoch-ms emission timestamp when the provider can recover it (the docker
   * provider parses the `--timestamps` prefix). Absent on providers without
   * per-line timestamps; used by log tailers for incremental cursors.
   */
  at?: number;
}

/** Options for {@link SandboxHandle.logs}. */
export interface SandboxLogOptions {
  /** Only entries emitted at/after this epoch-ms timestamp. */
  since?: number;
  /** Reserved for follow-mode streaming; only `false` (or omitted) in v1. */
  follow?: false;
  /** Only the last N entries (after `since` filtering). */
  tail?: number;
}

/** Container-port → host-port mapping (keys are `SandboxSpec.ports`). */
export type SandboxHostPorts = Record<number, number>;

/** Immutable facts about a sandbox handle. */
export interface SandboxHandleMeta {
  /** Epoch ms when the sandbox was created. */
  createdAt: number;
  /** Image the sandbox runs. */
  image: string;
  /** Container ports this sandbox publishes (from `SandboxSpec.ports`). */
  ports: number[];
}

/** Live handle to one sandbox. All methods reject with `SandboxError`. */
export interface SandboxHandle {
  /** Unique provider-scoped id. */
  id: string;
  /** Current lifecycle state. */
  status(): Promise<SandboxStatus>;
  /**
   * Run a command inside the sandbox. Resolves with the command's exit code
   * and output; rejects with `SandboxError` (`SANDBOX_TIMEOUT`,
   * `SANDBOX_UNAVAILABLE`, …) when the *execution* failed. After
   * stop/destroy rejects with `SANDBOX_UNAVAILABLE`.
   */
  exec(cmd: string[], opts?: SandboxExecOptions): Promise<SandboxExecResult>;
  /**
   * Streaming variant of {@link exec} (#104): runs the command WITHOUT
   * detaching and returns its live output — `events` yields stdout/stderr
   * chunks as the command emits them, `exited` settles with the exit code
   * (or rejects with the same typed errors as `exec`). Prefer this over
   * `exec` whenever output must be observed while the command runs (e.g. a
   * driver streaming agent NDJSON live). After stop/destroy `exited` rejects
   * with `SANDBOX_UNAVAILABLE` and `events` is empty.
   */
  execStream(cmd: string[], opts?: SandboxExecOptions): SandboxExecStream;
  /**
   * Stream log entries in emission order. May be called multiple times
   * (each call returns a fresh iterable). Empty once destroyed.
   */
  logs(opts?: SandboxLogOptions): AsyncIterable<SandboxLogEntry>;
  /** Container-port → host-port mapping for published ports. `{}` when none. */
  hostPorts(): Promise<SandboxHostPorts>;
  /**
   * Gracefully stop the sandbox. Idempotent (no-op when not running).
   * Rejects with `SandboxError` (`SANDBOX_STOP_FAILED`) on provider failure.
   */
  stop(timeoutMs?: number): Promise<void>;
  /**
   * Stop and remove the sandbox. Idempotent. After destroy the sandbox is
   * gone: `list()` no longer returns it, `exec` rejects, `logs` is empty.
   */
  destroy(): Promise<void>;
  meta: SandboxHandleMeta;
}

/** Snapshot of a sandbox for `SandboxProvider.list()`. */
export interface SandboxSummary {
  id: string;
  labels: Record<string, string>;
  image: string;
  status: SandboxStatus;
  createdAt: number;
}

/** Per-sandbox resource usage reported by `SandboxProvider.stats()`. */
export interface SandboxUsage {
  id: string;
  cpus?: number;
  memoryMb?: number;
}

/**
 * A pluggable sandbox backend (e.g. docker, fake). The engine codes against
 * this interface only.
 */
export interface SandboxProvider {
  /** Unique registry id, e.g. `"docker"` or `"fake"`. */
  id: string;
  /** Validate the spec, start a sandbox, and return its handle. */
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /**
   * Live sandboxes. `labelSelector` (when given) must match as a subset of
   * each sandbox's labels.
   */
  list(labelSelector?: Record<string, string>): Promise<SandboxSummary[]>;
  /**
   * Best-effort destroy of a sandbox by `list()` id (the GC path, #105).
   * Stop + remove the sandbox; resolving means gone (an already-missing id
   * resolves, never rejects). Optional — providers without it cannot be
   * garbage-collected by id.
   */
  destroy?(id: string): Promise<void>;
  /**
   * Graceful stop of a sandbox by `list()` id (#112, the sandboxes
   * dashboard): stops the container but KEEPS it — still listed (as
   * `stopped`) and inspectable. An already-stopped or missing id resolves,
   * never rejects. Optional — providers without it cannot be stopped by id.
   */
  stop?(id: string): Promise<void>;
  /** Optional per-sandbox resource usage. */
  stats?(): Promise<SandboxUsage[]>;
}
