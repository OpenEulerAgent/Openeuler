import type { AgentEvent, RunStatusEvent } from "@openeuler/core";
import { AgentEventSchema, RunStatusEventSchema } from "@openeuler/core";
import { daemonBaseUrl } from "./api";

/** Every event type the daemon may send on a run stream (incl. synthetic `run.status`). */
export const RUN_EVENT_TYPES = [
  "started",
  "session",
  "message-delta",
  "tool-call",
  "tool-output",
  "done",
  "error",
  "run.status",
] as const;

/** One frame off the wire: an agent event or the synthetic terminal status event. */
export type RunStreamEvent = AgentEvent | RunStatusEvent;

/**
 * Connection lifecycle as seen by the client. `reconnecting` means the browser
 * is retrying on its own (it resends `Last-Event-ID` so the daemon resumes
 * from our cursor); `closed` is permanent (terminal event, fatal error, or
 * explicit cleanup).
 */
export type RunStreamState = "connecting" | "open" | "reconnecting" | "closed";

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
  const status = RunStatusEventSchema.safeParse(data);
  if (status.success) return status.data;
  return null;
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
 * cursor. The stream ends for good when a terminal `run.status` arrives, the
 * source fails fatally (readyState CLOSED), or the caller invokes `close()`.
 */
export function connectRunEvents(options: RunEventsOptions): RunEventsHandle {
  const { runId, afterSeq, onEvent, onStateChange } = options;
  const baseUrl = options.baseUrl ?? daemonBaseUrl();
  const sourceFactory: RunEventSourceFactory = options.sourceFactory ?? BrowserEventSource;

  let state: RunStreamState = "connecting";
  let lastSeq = afterSeq ?? -1;
  let closed = false;

  const source = new sourceFactory(runEventsUrl(runId, baseUrl, afterSeq));

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
    source.close();
  };

  source.addEventListener("open", () => {
    setState("open");
  });

  source.addEventListener("error", () => {
    if (closed) return;
    // readyState CONNECTING (0): the browser is already retrying with
    // Last-Event-ID — surface it and wait. readyState CLOSED (2): fatal
    // (HTTP error, unknown run, stream cap) — the source gave up for good.
    if (source.readyState === 2) close();
    else setState("reconnecting");
  });

  for (const type of RUN_EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      if (closed || typeof event.data !== "string") return;
      const parsed = parseRunStreamEvent(event.data);
      // Skip malformed frames and replays the cursor already covers (e.g. an
      // overlapping resend after a reconnect).
      if (!parsed || parsed.seq <= lastSeq) return;
      lastSeq = parsed.seq;
      onEvent(parsed);
      if (parsed.type === "run.status") {
        // Terminal: the daemon closes the stream; mirror that locally so the
        // browser does not reconnect against a finished run.
        close();
      }
    });
  }

  return {
    close,
    get lastSeq() {
      return lastSeq;
    },
    get state() {
      return state;
    },
  };
}
