import type { AgentEvent, RunEvent, RunStatusEvent } from "@openeuler/core";
import { AgentEventSchema, RunEventSchema, TERMINAL_RUN_STATUSES } from "@openeuler/core";
import { daemonBaseUrl } from "./api";

/** Every event type the daemon may send on a run stream (driver + engine events). */
export const RUN_EVENT_TYPES = [
  "started",
  "session",
  "message-delta",
  "tool-call",
  "tool-output",
  "done",
  "error",
  "run.status",
  "step.started",
  "step.completed",
  "loop.iteration",
] as const;

/** One frame off the wire: a driver event or an engine (run/step) event. */
export type RunStreamEvent = AgentEvent | RunEvent;

/**
 * Connection lifecycle as seen by the client. `reconnecting` means the browser
 * is retrying on its own (it resends `Last-Event-ID` so the daemon resumes
 * from our cursor); `error` means the source failed fatally (daemon down,
 * HTTP error, stream cap) and waits for an explicit `reconnect()`;
 * `closed` is permanent (terminal event or explicit cleanup).
 */
export type RunStreamState = "connecting" | "open" | "reconnecting" | "error" | "closed";

/** Absolute SSE URL for a run's event stream, with an optional explicit cursor. */
export function runEventsUrl(
  runId: string,
  baseUrl: string = daemonBaseUrl(),
  afterSeq?: number,
): string {
  const url = `${baseUrl}/api/runs/${encodeURIComponent(runId)}/events`;
  return afterSeq === undefined ? url : `${url}?afterSeq=${afterSeq}`;
}

/** Parse one SSE `data` payload; `null` when it is not valid JSON or not a known event. */
export function parseRunStreamEvent(raw: string): RunStreamEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const agent = AgentEventSchema.safeParse(data);
  if (agent.success) return agent.data;
  const engine = RunEventSchema.safeParse(data);
  if (engine.success) return engine.data;
  return null;
}

/** `run.status` is only terminal for these statuses (`running` keeps the stream open). */
export function isTerminalRunStatusEvent(event: RunStatusEvent): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(event.status);
}

/** Minimal structural slice of `EventSource` the client needs (mockable in tests). */
export interface RunEventSource {
  /** 0 connecting, 1 open, 2 closed (matches `EventSource.CONNECTING/OPEN/CLOSED`). */
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export type RunEventSourceFactory = new (url: string) => RunEventSource;

/** Default source: the browser's native `EventSource` behind our narrow interface. */
export class BrowserEventSource implements RunEventSource {
  private readonly source: EventSource;

  constructor(url: string) {
    this.source = new EventSource(url);
  }

  get readyState(): number {
    return this.source.readyState;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.source.addEventListener(type, listener as unknown as EventListener);
  }

  close(): void {
    this.source.close();
  }
}

export interface RunEventsOptions {
  runId: string;
  /** Explicit replay cursor; when omitted the daemon replays from seq 0. */
  afterSeq?: number;
  /** Daemon base URL; defaults to `daemonBaseUrl()`. */
  baseUrl?: string;
  /** Injectable for tests; defaults to the native `EventSource`. */
  sourceFactory?: RunEventSourceFactory;
  onEvent: (event: RunStreamEvent) => void;
  onStateChange?: (state: RunStreamState) => void;
}

export interface RunEventsHandle {
  /** Stop the stream permanently and drop all listeners. Idempotent. */
  close(): void;
  /**
   * Ditch the current source and dial again, resuming from the last
   * delivered seq. No-op once the stream closed for good (terminal event
   * or explicit `close()`).
   */
  reconnect(): void;
  /** Highest event seq delivered so far (the Last-Event-ID reconnect cursor). */
  readonly lastSeq: number;
  readonly state: RunStreamState;
}

/**
 * Typed SSE client for `GET /api/runs/:id/events`. The daemon sends named
 * events (`event: <type>`) with the AgentEvent JSON in `data`, so we register
 * one listener per type rather than `onmessage`. Reconnects are left to the
 * browser: `EventSource` retries automatically and resends `Last-Event-ID`
 * (the last `id:` frame it saw), which the daemon honors as the replay
 * cursor. The stream ends for good when a terminal `run.status` arrives or
 * the caller invokes `close()`; a fatal source failure moves to the `error`
 * state until `reconnect()` dials again.
 */
export function connectRunEvents(options: RunEventsOptions): RunEventsHandle {
  const { runId, afterSeq, onEvent, onStateChange } = options;
  const baseUrl = options.baseUrl ?? daemonBaseUrl();
  const sourceFactory: RunEventSourceFactory = options.sourceFactory ?? BrowserEventSource;

  let state: RunStreamState = "connecting";
  let lastSeq = afterSeq ?? -1;
  let closed = false;
  let source: RunEventSource | null = new sourceFactory(runEventsUrl(runId, baseUrl, afterSeq));

  const setState = (next: RunStreamState): void => {
    if (closed || state === next) return;
    state = next;
    onStateChange?.(next);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    state = "closed";
    onStateChange?.("closed");
    source?.close();
    source = null;
  };

  const wire = (target: RunEventSource): void => {
    target.addEventListener("open", () => {
      setState("open");
    });

    target.addEventListener("error", () => {
      if (closed) return;
      // readyState CONNECTING (0): the browser is already retrying with
      // Last-Event-ID — surface it and wait. readyState CLOSED (2): fatal
      // (daemon down, HTTP error, stream cap) — the source gave up for
      // good, so surface the failure and wait for an explicit reconnect().
      if (target.readyState !== 2) {
        setState("reconnecting");
        return;
      }
      target.close();
      if (target === source) source = null;
      setState("error");
    });

    for (const type of RUN_EVENT_TYPES) {
      target.addEventListener(type, (event) => {
        if (closed || typeof event.data !== "string") return;
        const parsed = parseRunStreamEvent(event.data);
        // Skip malformed frames and replays the cursor already covers (e.g. an
        // overlapping resend after a reconnect).
        if (!parsed || parsed.seq <= lastSeq) return;
        lastSeq = parsed.seq;
        onEvent(parsed);
        if (parsed.type === "run.status" && isTerminalRunStatusEvent(parsed)) {
          // Terminal: the daemon closes the stream; mirror that locally so the
          // browser does not reconnect against a finished run. Non-terminal
          // `run.status` frames (e.g. `running`) keep the stream open.
          close();
        }
      });
    }
  };

  wire(source);

  return {
    close,
    reconnect: (): void => {
      if (closed) return;
      source?.close();
      source = new sourceFactory(runEventsUrl(runId, baseUrl, lastSeq >= 0 ? lastSeq : undefined));
      wire(source);
      setState("connecting");
    },
    get lastSeq() {
      return lastSeq;
    },
    get state() {
      return state;
    },
  };
}
