import { SandboxError } from "./error.js";
import type { SandboxExecStreamScript } from "./contract.js";
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
  /**
   * Scripted `execStream` outcomes served FIFO (#104). When the queue is
   * empty, `execStream` streams the default echo result as a single stdout
   * chunk and resolves `exited` with code 0.
   */
  execStreams?: SandboxExecStreamScript[];
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

/** Recorded `handle.execStream()` call. */
export interface FakeExecStreamCall {
  sandboxId: string;
  cmd: string[];
  opts: SandboxExecOptions | undefined;
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

/**
 * Single-consumer async queue backing the fake's `execStream`: chunks are
 * pushed from the scripted replay, the consumer iterates until `close()`.
 */
class StreamChunkQueue {
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

  execStream(cmd: string[], opts?: SandboxExecOptions): SandboxExecStream {
    this.provider.recordExecStream(this.id, cmd, opts);
    if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((part) => typeof part !== "string")) {
      throw new SandboxError(
        "SANDBOX_INVALID_SPEC",
        "exec cmd must be a non-empty array of strings",
      );
    }
    if (this.state !== "running") {
      throw new SandboxError(
        "SANDBOX_UNAVAILABLE",
        `sandbox "${this.id}" is not running (state: ${this.state}); cannot exec ${cmd.join(" ")}`,
      );
    }
    const startedAt = this.provider.now();
    const scripted = this.provider.nextScriptedExecStream();
    const chunks: SandboxExecChunk[] =
      scripted === undefined
        ? [{ stream: "stdout", chunk: `${cmd.join(" ")}\n` }]
        : scripted.chunks.map((chunk) => ({ ...chunk }));
    const interChunkDelayMs =
      scripted?.interChunkDelayMs !== undefined
        ? Math.max(0, scripted.interChunkDelayMs)
        : this.provider.execDelayMs;
    const code = scripted?.code ?? 0;
    const timeoutMs = opts?.timeoutMs;

    const queue = new StreamChunkQueue();
    let rejectExit!: (error: SandboxError) => void;
    const exited = new Promise<{ code: number; durationMs: number }>((resolve, reject) => {
      rejectExit = reject;
      void (async () => {
        try {
          // The delay applies BEFORE every chunk, and the timeout check
          // happens before the sleep: a stream whose next chunk cannot
          // arrive within timeoutMs rejects promptly (chunks already
          // delivered stay delivered — the queue is closed, not unwound).
          for (const chunk of chunks) {
            if (interChunkDelayMs > 0) {
              if (
                timeoutMs !== undefined &&
                this.provider.now() - startedAt + interChunkDelayMs > timeoutMs
              ) {
                queue.close();
                reject(
                  new SandboxError(
                    "SANDBOX_TIMEOUT",
                    `exec "${cmd.join(" ")}" in sandbox "${this.id}" timed out after ${timeoutMs}ms`,
                  ),
                );
                return;
              }
              await sleep(interChunkDelayMs);
            }
            queue.push(chunk);
          }
          queue.close();
          resolve({ code, durationMs: this.provider.now() - startedAt });
        } catch (err) {
          queue.close();
          reject(
            err instanceof SandboxError
              ? err
              : new SandboxError("SANDBOX_EXEC_FAILED", String(err)),
          );
        }
      })();
    });
    return {
      events: queue.iterate(),
      exited,
      cancel: () => {
        queue.close();
        rejectExit(
          new SandboxError(
            "SANDBOX_UNAVAILABLE",
            `exec "${cmd.join(" ")}" in sandbox "${this.id}" was cancelled`,
          ),
        );
      },
    };
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
        for (const { entry, at } of entries) {
          if (delayMs > 0) await sleep(delayMs);
          yield { ...entry, at };
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
  /** Every `handle.execStream()` call, in call order (#104). */
  readonly execStreamCalls: FakeExecStreamCall[] = [];
  /** Every `handle.stop()` call, in call order. */
  readonly stopCalls: FakeStopCall[] = [];
  /** Every `handle.destroy()` call, in call order (idempotent calls included). */
  readonly destroyCalls: { sandboxId: string }[] = [];

  private readonly options: Required<
    Pick<FakeSandboxProviderOptions, "execDelayMs" | "logDelayMs">
  > &
    FakeSandboxProviderOptions;
  private readonly execQueue: FakeExecScriptEntry[];
  private readonly execStreamQueue: SandboxExecStreamScript[];
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
    this.execStreamQueue = [...(options.execStreams ?? [])];
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

  /**
   * Destroy by `list()` id (the GC path, #105): idempotent like a handle
   * `destroy()` — an unknown id resolves (already gone), a known one is
   * destroyed through its handle (recorded in `destroyCalls`).
   */
  async destroy(id: string): Promise<void> {
    const handle = this.sandboxes.get(id);
    if (handle === undefined) return;
    await handle.destroy();
  }

  /**
   * Graceful stop by `list()` id (#112): idempotent — an unknown id resolves
   * (already gone), a known one is stopped through its handle (recorded in
   * `stopCalls`); the sandbox stays listed as `stopped`.
   */
  async stop(id: string): Promise<void> {
    const handle = this.sandboxes.get(id);
    if (handle === undefined) return;
    await handle.stop();
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

  /** @internal Shift the next scripted execStream outcome (FIFO, may be undefined). */
  nextScriptedExecStream(): SandboxExecStreamScript | undefined {
    return this.execStreamQueue.length > 0 ? this.execStreamQueue.shift() : undefined;
  }

  /** @internal Record an exec call for assertions. */
  recordExec(sandboxId: string, cmd: string[], opts: SandboxExecOptions | undefined): void {
    this.execCalls.push({
      sandboxId,
      cmd: [...cmd],
      opts: opts === undefined ? undefined : { ...opts },
    });
  }

  /** @internal Record an execStream call for assertions (#104). */
  recordExecStream(sandboxId: string, cmd: string[], opts: SandboxExecOptions | undefined): void {
    this.execStreamCalls.push({
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
