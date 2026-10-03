import type { AgentEvent, AgentToolCallEvent } from "@openeuler/core";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DriverError } from "./error.js";
import type {
  AgentDriver,
  AgentExit,
  AgentHandle,
  AgentExecSeam,
  AgentStartOpts,
} from "./types.js";

/** Error codes for {@link OpenCodeDriverError}. */
export type OpenCodeDriverErrorCode = "OPENCODE_NOT_FOUND" | "OPENCODE_SPAWN_FAILED";

/**
 * Typed, actionable failure raised by the opencode driver. Surfaced through
 * `exited` (`reason: "error"`) and an `error` event — never thrown from
 * `start()`.
 */
export class OpenCodeDriverError extends Error {
  readonly code: OpenCodeDriverErrorCode;

  constructor(code: OpenCodeDriverErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpenCodeDriverError";
    this.code = code;
    Object.setPrototypeOf(this, OpenCodeDriverError.prototype);
  }
}

/** Usage totals captured from `step-finish` envelopes, when present. */
export interface OpencodeUsage {
  /** Sum of `part.cost` across `step-finish` envelopes; `null` when absent. */
  cost: number | null;
  /** Wall-clock span of the emitted envelopes (first → last timestamp) in ms; `null` when absent. */
  durationMs: number | null;
}

/** Mutable parser state carried across NDJSON lines of one run. */
export interface OpencodeParserState {
  /** Next `seq` to assign (events are 0-based; the driver's `started` uses 0 and the state starts at 1). */
  seq: number;
  /** Session id once observed; drives the one-time `session` event. */
  sessionId: string | null;
  /** Output accumulated from `message-delta` and `tool-output` texts. */
  outputSoFar: string;
  /** Accumulated cost across `step-finish` envelopes; `null` until first seen. */
  cost: number | null;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  /** Whether an `error` envelope was observed for this run. */
  sawError: boolean;
  /** `callID`s for which a `tool-call` event was already emitted. */
  toolCallsSeen: Set<string>;
}

/** Why a line produced no events (`step_start`/`step_finish` still update state). */
export type OpencodeLineSkipReason = "blank" | "malformed" | "unknown-type" | "unmapped-type";

/** Result of parsing one NDJSON line. */
export interface OpencodeLineResult {
  events: AgentEvent[];
  skipped: OpencodeLineSkipReason | null;
}

/** Create fresh parser state; `nextSeq` defaults to `1` (the driver emits `started` with seq 0). */
export function createOpencodeParserState(nextSeq = 1): OpencodeParserState {
  return {
    seq: nextSeq,
    sessionId: null,
    outputSoFar: "",
    cost: null,
    firstTimestamp: null,
    lastTimestamp: null,
    sawError: false,
    toolCallsSeen: new Set<string>(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(
  value: unknown,
): value is null | boolean | number | string | unknown[] | Record<string, unknown> {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string" ||
    Array.isArray(value) ||
    isRecord(value)
  );
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Parse one `opencode run --format json` NDJSON line into `AgentEvent`s,
 * mutating `state` (session id, seq, output/cost accumulation). Pure with
 * respect to the outside world: malformed JSON and unknown envelope types are
 * reported via `skipped` and never throw.
 */
export function parseOpencodeLine(line: string, state: OpencodeParserState): OpencodeLineResult {
  const trimmed = line.trim();
  if (!trimmed) return { events: [], skipped: "blank" };

  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    return { events: [], skipped: "malformed" };
  }
  if (!isRecord(envelope)) return { events: [], skipped: "malformed" };

  const events: AgentEvent[] = [];

  if (typeof envelope.sessionID === "string" && envelope.sessionID && state.sessionId === null) {
    state.sessionId = envelope.sessionID;
    events.push({ type: "session", seq: state.seq++, sessionId: envelope.sessionID });
  }

  if (typeof envelope.timestamp === "number" && Number.isFinite(envelope.timestamp)) {
    if (state.firstTimestamp === null) state.firstTimestamp = envelope.timestamp;
    state.lastTimestamp = envelope.timestamp;
  }

  const part = isRecord(envelope.part) ? envelope.part : null;

  switch (envelope.type) {
    case "text": {
      const text = part && typeof part.text === "string" ? part.text : null;
      if (text === null) return { events, skipped: "malformed" };
      state.outputSoFar += text;
      events.push({ type: "message-delta", seq: state.seq++, delta: text });
      return { events, skipped: null };
    }
    case "tool_use": {
      if (!part) return { events, skipped: "malformed" };
      const tool = typeof part.tool === "string" ? part.tool : null;
      const callID = typeof part.callID === "string" ? part.callID : null;
      const toolState = isRecord(part.state) ? part.state : null;
      if (!tool || !callID || !toolState) return { events, skipped: "malformed" };
      const status = toolState.status;
      const seen = state.toolCallsSeen.has(callID);
      if (!seen) {
        state.toolCallsSeen.add(callID);
        const toolCall: AgentToolCallEvent = { type: "tool-call", seq: state.seq++, tool };
        const input = toolState.input;
        if (isJsonValue(input)) toolCall.input = input as AgentToolCallEvent["input"];
        events.push(toolCall);
      }
      if (status === "completed" || status === "error") {
        const rawOutput =
          status === "error" && typeof toolState.error === "string"
            ? toolState.error
            : toolState.output;
        const output = stringifyToolOutput(rawOutput);
        state.outputSoFar += output;
        events.push({ type: "tool-output", seq: state.seq++, output });
      }
      return { events, skipped: null };
    }
    case "step_finish": {
      if (part && typeof part.cost === "number" && Number.isFinite(part.cost)) {
        state.cost = (state.cost ?? 0) + part.cost;
      }
      return { events, skipped: null };
    }
    case "error": {
      const error = isRecord(envelope.error) ? envelope.error : null;
      const data = error && isRecord(error.data) ? error.data : null;
      const name = error && typeof error.name === "string" && error.name ? error.name : null;
      const detail = data && typeof data.message === "string" && data.message ? data.message : null;
      const message = detail ?? name ?? "opencode reported an error";
      state.sawError = true;
      events.push({ type: "error", seq: state.seq++, message, ...(name ? { code: name } : {}) });
      return { events, skipped: null };
    }
    case "step_start":
      return { events, skipped: null };
    case "reasoning":
      return { events, skipped: "unmapped-type" };
    default:
      return { events, skipped: "unknown-type" };
  }
}

/** Map {@link AgentStartOpts} to the `opencode run` argv (no shell involved). */
export function buildOpencodeArgs(opts: AgentStartOpts): string[] {
  const args = ["run", opts.prompt, "--format", "json", "--dir", resolve(opts.cwd)];
  if (opts.mode === "auto") args.push("--auto");
  if (opts.model) args.push("-m", opts.model);
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.sessionId) args.push("--session", opts.sessionId);
  return args;
}

/** Construction options for {@link OpenCodeDriver}. */
export interface OpenCodeDriverOptions {
  /** Registry id; defaults to `"opencode"`. */
  id?: string;
  /** Binary to invoke; defaults to `"opencode"` (resolved via `PATH`). */
  binary?: string;
  /** Bounded events buffer cap (drop-oldest); defaults to `1000`. */
  eventBufferCap?: number;
  /** Grace period between SIGTERM and SIGKILL on abort, in ms; defaults to `5000`. */
  killGraceMs?: number;
  /** Bytes of stderr retained for diagnostics; defaults to `4096`. */
  stderrTailBytes?: number;
  /**
   * Timeout for one in-sandbox agent command (`exec` seam, #102) when the
   * seam passes no `timeoutMs`. Defaults to 30 minutes — the local path has
   * no spawn timeout, so the sandbox bound is deliberately generous.
   */
  sandboxExecTimeoutMs?: number;
  /** Diagnostic sink for malformed NDJSON lines; defaults to a no-op. */
  log?: (message: string) => void;
}

interface RecordLike {
  id: string;
  binary: string;
  eventBufferCap: number;
  killGraceMs: number;
  stderrTailBytes: number;
  sandboxExecTimeoutMs: number;
  log: (message: string) => void;
}

const DEFAULT_EVENT_BUFFER_CAP = 1000;
const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_STDERR_TAIL_BYTES = 4096;
const DEFAULT_SANDBOX_EXEC_TIMEOUT_MS = 30 * 60 * 1000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class BoundedEventQueue {
  private readonly items: AgentEvent[] = [];
  private readonly waiters: ((event: AgentEvent | null) => void)[] = [];
  private closed = false;
  private droppedCount = 0;

  constructor(private readonly cap: number) {}

  get dropped(): number {
    return this.droppedCount;
  }

  push(event: AgentEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    if (this.items.length >= this.cap) {
      this.items.shift();
      this.droppedCount++;
    }
    this.items.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  next(): Promise<AgentEvent | null> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(null);
    return new Promise<AgentEvent | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

class StderrRing {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.size -= dropped?.length ?? 0;
    }
    if (this.size > this.maxBytes && this.chunks.length === 1 && this.chunks[0]) {
      this.chunks[0] = this.chunks[0].subarray(this.size - this.maxBytes);
      this.size = this.maxBytes;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Live handle for one `opencode run` child process. */
export class OpenCodeAgentHandle implements AgentHandle {
  readonly events: AsyncIterable<AgentEvent>;
  readonly exited: Promise<AgentExit>;
  /** Usage totals captured from the NDJSON stream; resolves `null` when the run failed to produce any envelopes. */
  readonly usage: Promise<OpencodeUsage | null>;

  private readonly config: RecordLike;
  private readonly child: ChildProcess | null;
  private readonly queue: BoundedEventQueue;
  private readonly state: OpencodeParserState = createOpencodeParserState();
  private readonly stderrRing: StderrRing;
  private readonly stream: AsyncGenerator<AgentEvent, void>;
  private stdoutRemainder = "";
  private resolveExited!: (exit: AgentExit) => void;
  private resolveUsage!: (usage: OpencodeUsage | null) => void;
  private finished = false;
  private iterated = false;
  private abortRequested = false;
  private abortPromise: Promise<void> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private spawnError: Error | null = null;

  constructor(config: RecordLike, opts: AgentStartOpts, args: string[]) {
    this.config = config;
    this.stderrRing = new StderrRing(config.stderrTailBytes);
    this.queue = new BoundedEventQueue(config.eventBufferCap);
    this.exited = new Promise<AgentExit>((resolve) => {
      this.resolveExited = resolve;
    });
    this.usage = new Promise<OpencodeUsage | null>((resolve) => {
      this.resolveUsage = resolve;
    });

    const cwd = resolve(opts.cwd);
    const env = { ...process.env, ...opts.env } as NodeJS.ProcessEnv;

    if (!existsSync(cwd)) {
      this.child = null;
      this.spawnError = new OpenCodeDriverError(
        "OPENCODE_SPAWN_FAILED",
        `working directory does not exist: ${cwd}`,
      );
      this.stream = this.streamEvents();
      this.events = { [Symbol.asyncIterator]: () => this[Symbol.asyncIterator]() };
      this.queue.push({ type: "started", seq: 0 });
      this.finish();
      return;
    }

    this.child = spawn(config.binary, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.on("error", (error: NodeJS.ErrnoException) => {
      if (this.finished || this.exitCode !== null || this.exitSignal !== null) return;
      this.spawnError = error;
      this.finish();
    });
    this.child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
    });
    this.child.on("close", () => {
      this.finish();
    });

    if (this.child.stdout) {
      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (chunk: string) => {
        this.feedStdout(chunk);
      });
    }
    if (this.child.stderr) {
      this.child.stderr.on("data", (chunk: Buffer) => {
        this.stderrRing.append(chunk);
      });
    }

    this.queue.push({ type: "started", seq: 0 });
    this.stream = this.streamEvents();
    this.events = { [Symbol.asyncIterator]: () => this[Symbol.asyncIterator]() };
  }

  /** Child process id (also the process-group id: the child is spawned `detached`). `null` when the run never spawned. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Process-group id of the child (`detached` spawn → pgid === pid). `null` when the run never spawned. */
  get pgid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Last retained stderr bytes (see `stderrTailBytes` option). */
  get lastStderr(): string {
    return this.stderrRing.toString();
  }

  /** Events dropped from the bounded buffer (drop-oldest) because no consumer kept up. */
  get droppedEvents(): number {
    return this.queue.dropped;
  }

  /**
   * Terminate the run: SIGTERM to the child's whole process group, escalated to
   * SIGKILL after the grace period. Resolves once the run has ended. No-op
   * after the run finished; safe to call repeatedly.
   */
  abort(): Promise<void> {
    if (this.finished) return Promise.resolve();
    if (this.abortPromise) return this.abortPromise;
    this.abortRequested = true;
    this.abortPromise = this.terminate();
    return this.abortPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.iterated) {
      throw new DriverError(
        "DRIVER_EVENTS_ALREADY_CONSUMED",
        `opencode driver "${this.config.id}" handle events were already iterated; an AgentHandle supports a single consumer`,
      );
    }
    this.iterated = true;
    return this.stream[Symbol.asyncIterator]();
  }

  private async terminate(): Promise<void> {
    this.signalGroup("SIGTERM");
    this.killTimer = setTimeout(() => {
      this.signalGroup("SIGKILL");
    }, this.config.killGraceMs);
    this.killTimer.unref?.();
    await this.exited;
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const child = this.child;
    if (child === null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Process (group) already gone — the exit/close handler finishes the run.
      }
    }
  }

  private feedStdout(chunk: string): void {
    this.stdoutRemainder += chunk;
    const lines = this.stdoutRemainder.split("\n");
    this.stdoutRemainder = lines.pop() ?? "";
    for (const line of lines) this.feedLine(line);
  }

  private feedLine(line: string): void {
    const { events, skipped } = parseOpencodeLine(line, this.state);
    if (skipped === "malformed") {
      this.config.log(
        `opencode driver "${this.config.id}": skipping malformed NDJSON line: ${line.slice(0, 200)}`,
      );
    }
    for (const event of events) this.queue.push(event);
  }

  private async *streamEvents(): AsyncGenerator<AgentEvent, void> {
    for (;;) {
      const event = await this.queue.next();
      if (event === null) return;
      yield event;
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    if (this.stdoutRemainder.trim()) this.feedLine(this.stdoutRemainder);

    const usage: OpencodeUsage | null =
      this.spawnError !== null || this.state.firstTimestamp === null
        ? null
        : {
            cost: this.state.cost,
            durationMs: (this.state.lastTimestamp ?? 0) - (this.state.firstTimestamp ?? 0),
          };

    if (this.spawnError !== null) {
      const error = this.toSpawnError(this.spawnError);
      this.queue.push({
        type: "error",
        seq: this.state.seq++,
        message: error.message,
        code: error.code,
      });
      this.queue.close();
      this.resolveUsage(usage);
      this.resolveExited({ code: null, reason: "error", output: error.message });
      return;
    }

    if (this.abortRequested) {
      this.queue.close();
      this.resolveUsage(usage);
      this.resolveExited({ code: null, reason: "aborted", output: this.state.outputSoFar });
      return;
    }

    if (this.exitCode === 0 && !this.state.sawError) {
      this.queue.push({ type: "done", seq: this.state.seq++, output: this.state.outputSoFar });
      this.queue.close();
      this.resolveUsage(usage);
      this.resolveExited({ code: 0, reason: "exit", output: this.state.outputSoFar });
      return;
    }

    const stderrTail = this.stderrRing.toString().trim();
    const exitDescription =
      this.exitCode !== null
        ? `opencode exited with code ${this.exitCode}`
        : this.exitSignal !== null
          ? `opencode terminated by signal ${this.exitSignal}`
          : "opencode run failed";
    if (!this.state.sawError) {
      const message = stderrTail ? `${exitDescription}: ${stderrTail}` : exitDescription;
      this.queue.push({
        type: "error",
        seq: this.state.seq++,
        message,
        code: "OPENCODE_NONZERO_EXIT",
      });
    }
    const output = stderrTail
      ? `${this.state.outputSoFar}${this.state.outputSoFar ? "\n" : ""}[stderr]\n${stderrTail}`
      : this.state.outputSoFar;
    this.queue.close();
    this.resolveUsage(usage);
    this.resolveExited({ code: this.exitCode, reason: "error", output });
  }

  private toSpawnError(error: Error): OpenCodeDriverError {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return new OpenCodeDriverError(
        "OPENCODE_NOT_FOUND",
        `opencode CLI not found on PATH (tried "${this.config.binary}"). Install it from https://opencode.ai/docs/install, authenticate with "opencode auth login", then retry.`,
        { cause: error },
      );
    }
    return new OpenCodeDriverError(
      "OPENCODE_SPAWN_FAILED",
      `failed to start opencode (tried "${this.config.binary}"): ${error.message}`,
      { cause: error },
    );
  }
}

/**
 * Handle for one in-sandbox `opencode run` invocation (#102): the argv is
 * the same as the local path (`buildOpencodeArgs`, with `cwd` a container
 * path like `/workspace`), but the command runs through the run's exec
 * seam instead of a local spawn. Stdout NDJSON is parsed with the exact
 * same line parser; abort goes through `seam.stop()` (which must cancel
 * the in-flight `run()` — the rejection settles this handle as aborted).
 */
export class OpenCodeSandboxAgentHandle implements AgentHandle {
  readonly events: AsyncIterable<AgentEvent>;
  readonly exited: Promise<AgentExit>;

  private readonly config: RecordLike;
  private readonly seam: AgentExecSeam;
  private readonly argv: string[];
  private readonly env: Record<string, string> | undefined;
  private readonly queue: BoundedEventQueue;
  private readonly state: OpencodeParserState = createOpencodeParserState();
  private readonly stderrRing: StderrRing;
  private readonly stream: AsyncGenerator<AgentEvent, void>;
  private resolveExited!: (exit: AgentExit) => void;
  private finished = false;
  private iterated = false;
  private abortRequested = false;
  private abortPromise: Promise<void> | null = null;

  constructor(config: RecordLike, opts: AgentStartOpts, seam: AgentExecSeam, args: string[]) {
    this.config = config;
    this.seam = seam;
    this.argv = [config.binary, ...args];
    this.env = opts.env;
    this.stderrRing = new StderrRing(config.stderrTailBytes);
    this.queue = new BoundedEventQueue(config.eventBufferCap);
    this.exited = new Promise<AgentExit>((resolve) => {
      this.resolveExited = resolve;
    });
    this.queue.push({ type: "started", seq: 0 });
    this.stream = this.streamEvents();
    this.events = { [Symbol.asyncIterator]: () => this[Symbol.asyncIterator]() };
    void this.invoke();
  }

  /** argv the seam is asked to run (`opencode run …`), for diagnostics/tests. */
  get command(): string[] {
    return [...this.argv];
  }

  /**
   * Abort the in-sandbox run: ask the seam to cancel in-flight work, then
   * wait (bounded by the kill grace) for the run to settle. No-op when the
   * run already finished; safe to call repeatedly.
   */
  abort(): Promise<void> {
    if (this.finished) return Promise.resolve();
    if (this.abortPromise) return this.abortPromise;
    this.abortRequested = true;
    this.abortPromise = this.terminate();
    return this.abortPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.iterated) {
      throw new DriverError(
        "DRIVER_EVENTS_ALREADY_CONSUMED",
        `opencode driver "${this.config.id}" handle events were already iterated; an AgentHandle supports a single consumer`,
      );
    }
    this.iterated = true;
    return this.stream[Symbol.asyncIterator]();
  }

  private async terminate(): Promise<void> {
    try {
      await this.seam.stop?.();
    } catch {
      // Best-effort: a failed stop must not mask the abort itself. A seam
      // without stop leaves the run to settle via its own timeout.
    }
    // Bounded wait: seam.stop() cancels the in-flight exec (its promise
    // rejects → finish), but a misbehaving seam must not hang abort().
    await Promise.race([this.exited, delay(this.config.killGraceMs)]);
  }

  private async invoke(): Promise<void> {
    let result: Awaited<ReturnType<AgentExecSeam["run"]>> | null;
    let failure: unknown = null;
    try {
      result = await this.seam.run(this.argv, {
        timeoutMs: this.config.sandboxExecTimeoutMs,
        ...(this.env === undefined || Object.keys(this.env).length === 0
          ? {}
          : { env: { ...this.env } }),
      });
    } catch (err) {
      result = null;
      failure = err;
    }
    if (this.finished) return;
    if (result !== null) this.stderrRing.append(Buffer.from(result.stderr, "utf8"));
    this.finish(result, failure);
  }

  private feedStdout(stdout: string): void {
    const lines = stdout.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      const { events, skipped } = parseOpencodeLine(line, this.state);
      if (skipped === "malformed") {
        this.config.log(
          `opencode driver "${this.config.id}": skipping malformed NDJSON line: ${line.slice(0, 200)}`,
        );
      }
      for (const event of events) this.queue.push(event);
    }
  }

  private async *streamEvents(): AsyncGenerator<AgentEvent, void> {
    for (;;) {
      const event = await this.queue.next();
      if (event === null) return;
      yield event;
    }
  }

  private finish(
    result: { code: number; stdout: string; stderr: string } | null,
    failure: unknown,
  ): void {
    if (this.finished) return;
    this.finished = true;

    // Abort wins even if the command meanwhile produced a result: the run's
    // verdict is "aborted", with whatever output streamed so far.
    if (this.abortRequested) {
      this.queue.close();
      this.resolveExited({ code: null, reason: "aborted", output: this.state.outputSoFar });
      return;
    }

    if (failure !== null) {
      // Seam failures (sandbox stopped under us, exec timeout, …) are typed
      // errors — except the abort race handled above.
      const message = failure instanceof Error ? failure.message : String(failure);
      this.queue.push({ type: "error", seq: this.state.seq++, message });
      this.queue.close();
      this.resolveExited({ code: null, reason: "error", output: message });
      return;
    }

    this.feedStdout(result?.stdout ?? "");

    const exitCode = result?.code ?? null;
    // Only a NON-ZERO exit may be classified as a missing binary — a
    // successful run whose stderr incidentally contains "not found" (grep
    // output, warnings) must not fail the step.
    if (
      exitCode !== null &&
      exitCode !== 0 &&
      (exitCode === 127 || /(?:not found|ENOENT|no such file)/i.test(result?.stderr ?? ""))
    ) {
      const error = new OpenCodeDriverError(
        "OPENCODE_NOT_FOUND",
        `opencode CLI not found inside the sandbox image (tried "${this.config.binary}", exit ${exitCode ?? "?"}). Install opencode in the sandbox image (e.g. add it to the image built via POST /api/sandbox/images/build) and retry.`,
      );
      this.queue.push({
        type: "error",
        seq: this.state.seq++,
        message: error.message,
        code: error.code,
      });
      this.queue.close();
      this.resolveExited({ code: exitCode, reason: "error", output: error.message });
      return;
    }

    if (exitCode === 0 && !this.state.sawError) {
      this.queue.push({ type: "done", seq: this.state.seq++, output: this.state.outputSoFar });
      this.queue.close();
      this.resolveExited({ code: 0, reason: "exit", output: this.state.outputSoFar });
      return;
    }

    const stderrTail = this.stderrRing.toString().trim();
    const exitDescription =
      exitCode !== null
        ? `opencode exited with code ${exitCode} inside the sandbox`
        : "opencode sandbox run failed";
    if (!this.state.sawError) {
      const message = stderrTail ? `${exitDescription}: ${stderrTail}` : exitDescription;
      this.queue.push({
        type: "error",
        seq: this.state.seq++,
        message,
        code: "OPENCODE_NONZERO_EXIT",
      });
    }
    const output = stderrTail
      ? `${this.state.outputSoFar}${this.state.outputSoFar ? "\n" : ""}[stderr]\n${stderrTail}`
      : this.state.outputSoFar;
    this.queue.close();
    this.resolveExited({ code: exitCode, reason: "error", output });
  }
}

/**
 * Process-backed driver that spawns `opencode run` per start, streams its
 * `--format json` NDJSON as `AgentEvent`s, and supports session continuation
 * and group-abort.
 */
export class OpenCodeDriver implements AgentDriver {
  readonly id: string;

  private readonly options: RecordLike;

  constructor(options: OpenCodeDriverOptions = {}) {
    this.id = options.id ?? "opencode";
    this.options = {
      id: this.id,
      binary: options.binary ?? "opencode",
      eventBufferCap: Math.max(1, options.eventBufferCap ?? DEFAULT_EVENT_BUFFER_CAP),
      killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
      stderrTailBytes: options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES,
      sandboxExecTimeoutMs: options.sandboxExecTimeoutMs ?? DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
      log: options.log ?? (() => {}),
    };
  }

  /** Local execution (no `exec` seam): a live child-process handle. */
  start(opts: AgentStartOpts & { exec?: undefined }): OpenCodeAgentHandle;
  /** Sandboxed execution (#102, `exec` seam present): an in-sandbox handle. */
  start(opts: AgentStartOpts): AgentHandle;
  start(opts: AgentStartOpts): AgentHandle {
    const args = buildOpencodeArgs(opts);
    if (opts.exec !== undefined) {
      // Sandbox execution (#102): the command runs inside the run's sandbox
      // through the seam; `cwd` is already a container path.
      return new OpenCodeSandboxAgentHandle(this.options, opts, opts.exec, args);
    }
    return new OpenCodeAgentHandle(this.options, opts, args);
  }
}

/** Create an opencode driver. */
export function createOpenCodeDriver(options: OpenCodeDriverOptions = {}): OpenCodeDriver {
  return new OpenCodeDriver(options);
}

/** Options for {@link checkOpenCodeInstalled}. */
export interface CheckOpenCodeOptions {
  /** Binary to check; defaults to `"opencode"`. */
  binary?: string;
  /** Environment override merged over `process.env`. */
  env?: Record<string, string>;
}

/**
 * Preflight that the opencode CLI is installed and runnable
 * (`opencode --version`). Throws {@link OpenCodeDriverError} with code
 * `OPENCODE_NOT_FOUND` when the binary is missing or the version call fails.
 * Not called by `start()` — spawn failures surface there via `exited` instead.
 */
export function checkOpenCodeInstalled(options: CheckOpenCodeOptions = {}): Promise<void> {
  const binary = options.binary ?? "opencode";
  const env = { ...process.env, ...options.env } as NodeJS.ProcessEnv;
  return new Promise<void>((resolve, reject) => {
    execFile(binary, ["--version"], { env, windowsHide: true }, (error, stdout) => {
      if (error) {
        const errno = error as NodeJS.ErrnoException;
        const detail =
          errno.code === "ENOENT"
            ? `opencode CLI not found on PATH (tried "${binary}")`
            : `"${binary} --version" failed: ${error.message}`;
        reject(
          new OpenCodeDriverError(
            "OPENCODE_NOT_FOUND",
            `${detail}. Install it from https://opencode.ai/docs/install, authenticate with "opencode auth login", then retry.`,
            { cause: error },
          ),
        );
        return;
      }
      void stdout;
      resolve();
    });
  });
}
