import { SandboxError } from "./error.js";
import type {
  SandboxExecOptions,
  SandboxExecResult,
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

/** One scripted `exec` outcome: a partial result (defaults filled in) or an error to throw. */
export type FakeExecScriptEntry = Partial<SandboxExecResult> | SandboxError;

/** Construction options for {@link createFakeSandboxProvider}. */
export interface FakeSandboxProviderOptions {
  /** Registry id; defaults to `"fake"`. */
  id?: string;
  /**
   * Scripted `exec` outcomes served from a provider-level FIFO queue, in
   * call order across all handles. When the queue is empty, `exec` resolves
   * with the default echo result (code 0, stdout = the joined command).
   */
  execResults?: FakeExecScriptEntry[];
  /** Simulated command duration in ms; also drives `SANDBOX_TIMEOUT` behavior. Default 0. */
  execDelayMs?: number;
  /** Log lines replayed (per sandbox) by `handle.logs()`. */
  logLines?: SandboxLogEntry[];
  /** Delay between replayed log lines in ms; 0 (default) emits immediately. */
  logDelayMs?: number;
  /**
   * When set, `create()` rejects with `SANDBOX_IMAGE_MISSING` for any image
   * not in the list (simulates an unpullable image).
   */
  knownImages?: string[];
  /** When set, each sandbox transitions `running → exited` on its own after this many ms. */
  exitsAfterMs?: number;
  /** Reject every `create()` with `SANDBOX_UNAVAILABLE`. */
  failOnCreate?: boolean;
  /** Reject every `stop()` with `SANDBOX_STOP_FAILED`. */
  failOnStop?: boolean;
  /** Clock used for `meta.createdAt` and measured `durationMs`; default `Date.now`. */
  now?: () => number;
}

/** Recorded `handle.exec()` call. */
export interface FakeExecCall {
  sandboxId: string;
  cmd: string[];
  opts: SandboxExecOptions | undefined;
}

/** Recorded `handle.stop()` call. */
export interface FakeStopCall {
  sandboxId: string;
  timeoutMs: number | undefined;
}

interface TimestampedLog {
  entry: SandboxLogEntry;
  at: number;
}

type FakeSandboxState = "running" | "exited" | "stopped" | "destroyed";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchesLabels(spec: SandboxSpec, labelSelector: Record<string, string>): boolean {
  return Object.entries(labelSelector).every(([key, value]) => spec.labels?.[key] === value);
}

class FakeSandboxHandle implements SandboxHandle {
  readonly id: string;
  readonly meta: SandboxHandleMeta;

  private state: FakeSandboxState = "running";
  private readonly spec: SandboxSpec;
  private readonly provider: FakeSandboxProvider;
  private readonly hostPortMap: SandboxHostPorts;
  private readonly logScript: readonly TimestampedLog[];
  private exitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: {
    id: string;
    spec: SandboxSpec;
    provider: FakeSandboxProvider;
    hostPortMap: SandboxHostPorts;
    logScript: readonly TimestampedLog[];
    createdAt: number;
    exitsAfterMs: number | undefined;
  }) {
    this.id = config.id;
    this.spec = config.spec;
    this.provider = config.provider;
    this.hostPortMap = config.hostPortMap;
    this.logScript = config.logScript;
    this.meta = {
      createdAt: config.createdAt,
      image: config.spec.image,
      ports: config.spec.ports ? [...config.spec.ports] : [],
    };
    if (config.exitsAfterMs !== undefined) {
      const timer = setTimeout(() => {
        if (this.state === "running") this.state = "exited";
      }, config.exitsAfterMs);
      timer.unref?.();
      this.exitTimer = timer;
    }
  }

  /** Lifecycle status for `list()` summaries (destroyed reports `stopped`). */
  summaryStatus(): SandboxStatus {
    return this.state === "destroyed" ? "stopped" : this.state;
  }

  summarySpec(): SandboxSpec {
    return this.spec;
  }

  async status(): Promise<SandboxStatus> {
    return this.state === "destroyed" ? "stopped" : this.state;
  }

  async exec(cmd: string[], opts?: SandboxExecOptions): Promise<SandboxExecResult> {
    this.provider.recordExec(this.id, cmd, opts);
    if (this.state !== "running") {
      throw new SandboxError(
        "SANDBOX_UNAVAILABLE",
        `sandbox "${this.id}" is not running (state: ${this.state}); cannot exec ${cmd.join(" ")}`,
      );
    }
    const startedAt = this.provider.now();
    const delayMs = this.provider.execDelayMs;
    const timeoutMs = opts?.timeoutMs;
    if (timeoutMs !== undefined && delayMs > timeoutMs) {
      await sleep(timeoutMs);
      throw new SandboxError(
        "SANDBOX_TIMEOUT",
        `exec "${cmd.join(" ")}" in sandbox "${this.id}" timed out after ${timeoutMs}ms`,
      );
    }
    if (delayMs > 0) await sleep(delayMs);
    const scripted = this.provider.nextScriptedExec();
    if (scripted instanceof SandboxError) throw scripted;
    const measured = this.provider.now() - startedAt;
    if (scripted !== undefined) {
      return { code: 0, stdout: "", stderr: "", durationMs: measured, ...scripted };
    }
    return { code: 0, stdout: `${cmd.join(" ")}\n`, stderr: "", durationMs: measured };
  }

  logs(opts?: SandboxLogOptions): AsyncIterable<SandboxLogEntry> {
    const state = this.state;
    const delayMs = this.provider.logDelayMs;
    const since = opts?.since;
    const tail = opts?.tail;
    const script =
      state === "destroyed"
        ? []
        : since === undefined && tail === undefined
          ? this.logScript
          : this.logScript.filter(({ at }) => (since === undefined ? true : at >= since));
    const entries = tail === undefined ? [...script] : tail <= 0 ? [] : script.slice(-tail);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<SandboxLogEntry> {
        for (const { entry } of entries) {
          if (delayMs > 0) await sleep(delayMs);
          yield entry;
        }
      },
    };
  }

  async hostPorts(): Promise<SandboxHostPorts> {
    if (this.state === "destroyed") return {};
    return { ...this.hostPortMap };
  }

  async stop(timeoutMs?: number): Promise<void> {
    this.provider.recordStop(this.id, timeoutMs);
    if (this.provider.failOnStop) {
      throw new SandboxError("SANDBOX_STOP_FAILED", `failed to stop sandbox "${this.id}"`);
    }
    if (this.exitTimer !== null) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
    if (this.state === "running") this.state = "stopped";
  }

  async destroy(): Promise<void> {
    this.provider.recordDestroy(this.id);
    if (this.exitTimer !== null) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
    this.state = "destroyed";
    this.provider.removeSandbox(this.id);
  }
}

/**
 * Scripted in-memory sandbox provider for tests: no containers are started.
 * `create()` validates the spec (non-empty image), replays scripted `exec`
 * results and log lines, maps spec ports to fake ephemeral host ports, and
 * records every call (`createdSpecs`, `execCalls`, `stopCalls`,
 * `destroyCalls`) for assertions.
 */
export class FakeSandboxProvider implements SandboxProvider {
  readonly id: string;

  /** Deep snapshots of every spec accepted by `create()`, in call order. */
  readonly createdSpecs: SandboxSpec[] = [];
  /** Every `handle.exec()` call, in call order. */
  readonly execCalls: FakeExecCall[] = [];
  /** Every `handle.stop()` call, in call order. */
  readonly stopCalls: FakeStopCall[] = [];
  /** Every `handle.destroy()` call, in call order (idempotent calls included). */
  readonly destroyCalls: { sandboxId: string }[] = [];

  private readonly options: Required<
    Pick<FakeSandboxProviderOptions, "execDelayMs" | "logDelayMs">
  > &
    FakeSandboxProviderOptions;
  private readonly execQueue: FakeExecScriptEntry[];
  private readonly sandboxes = new Map<string, FakeSandboxHandle>();
  private nextSandbox = 1;
  private nextHostPort = 32768;

  constructor(options: FakeSandboxProviderOptions = {}) {
    this.id = options.id ?? "fake";
    this.options = {
      ...options,
      execDelayMs: Math.max(0, options.execDelayMs ?? 0),
      logDelayMs: Math.max(0, options.logDelayMs ?? 0),
    };
    this.execQueue = [...(options.execResults ?? [])];
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (typeof spec.image !== "string" || spec.image.trim() === "") {
      throw new SandboxError("SANDBOX_IMAGE_MISSING", "sandbox spec requires a non-empty image");
    }
    const known = this.options.knownImages;
    if (known !== undefined && !known.includes(spec.image)) {
      throw new SandboxError(
        "SANDBOX_IMAGE_MISSING",
        `image "${spec.image}" is not available on the fake provider`,
      );
    }
    if (this.options.failOnCreate) {
      throw new SandboxError(
        "SANDBOX_UNAVAILABLE",
        `fake sandbox provider "${this.id}" is configured to fail create()`,
      );
    }
    const snapshot = structuredClone(spec);
    this.createdSpecs.push(snapshot);

    const id = `${this.id}-sb-${this.nextSandbox}`;
    this.nextSandbox += 1;
    const createdAt = this.now();
    const hostPortMap: SandboxHostPorts = {};
    for (const port of spec.ports ?? []) {
      hostPortMap[port] = this.nextHostPort;
      this.nextHostPort += 1;
    }
    const handle = new FakeSandboxHandle({
      id,
      spec: snapshot,
      provider: this,
      hostPortMap,
      logScript: (this.options.logLines ?? []).map((entry, index) => ({
        entry,
        at: createdAt + index,
      })),
      createdAt,
      exitsAfterMs: this.options.exitsAfterMs,
    });
    this.sandboxes.set(id, handle);
    return handle;
  }

  async list(labelSelector?: Record<string, string>): Promise<SandboxSummary[]> {
    const summaries: SandboxSummary[] = [];
    for (const handle of this.sandboxes.values()) {
      const spec = handle.summarySpec();
      if (labelSelector !== undefined && !matchesLabels(spec, labelSelector)) continue;
      summaries.push({
        id: handle.id,
        labels: spec.labels ? { ...spec.labels } : {},
        image: spec.image,
        status: handle.summaryStatus(),
        createdAt: handle.meta.createdAt,
      });
    }
    return summaries;
  }

  async stats(): Promise<SandboxUsage[]> {
    return [...this.sandboxes.values()].map((handle) => ({
      id: handle.id,
      cpus: handle.summarySpec().resources?.cpus,
      memoryMb: handle.summarySpec().resources?.memoryMb,
    }));
  }

  /** Clock used for `meta.createdAt` and measured exec durations. */
  now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** @internal Simulated command duration in ms (shared by all handles). */
  get execDelayMs(): number {
    return this.options.execDelayMs;
  }

  /** @internal Delay between replayed log lines in ms (shared by all handles). */
  get logDelayMs(): number {
    return this.options.logDelayMs;
  }

  /** @internal Whether stop() is scripted to fail. */
  get failOnStop(): boolean {
    return this.options.failOnStop ?? false;
  }

  /** @internal Shift the next scripted exec outcome (FIFO, may be undefined). */
  nextScriptedExec(): FakeExecScriptEntry | undefined {
    return this.execQueue.length > 0 ? this.execQueue.shift() : undefined;
  }

  /** @internal Record an exec call for assertions. */
  recordExec(sandboxId: string, cmd: string[], opts: SandboxExecOptions | undefined): void {
    this.execCalls.push({
      sandboxId,
      cmd: [...cmd],
      opts: opts === undefined ? undefined : { ...opts },
    });
  }

  /** @internal Record a stop call for assertions. */
  recordStop(sandboxId: string, timeoutMs: number | undefined): void {
    this.stopCalls.push({ sandboxId, timeoutMs });
  }

  /** @internal Record a destroy call for assertions. */
  recordDestroy(sandboxId: string): void {
    this.destroyCalls.push({ sandboxId });
  }

  /** @internal Remove a destroyed sandbox from list()/stats(). */
  removeSandbox(sandboxId: string): void {
    this.sandboxes.delete(sandboxId);
  }
}

/** Create a scripted fake sandbox provider. */
export function createFakeSandboxProvider(
  options: FakeSandboxProviderOptions = {},
): FakeSandboxProvider {
  return new FakeSandboxProvider(options);
}
