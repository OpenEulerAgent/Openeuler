import { describe, expect, it } from "vitest";
import type { AgentEvent, RunEvent, RunStatusEvent } from "@openeuler/core";
import {
  connectRunEvents,
  parseRunStreamEvent,
  runEventsUrl,
  RUN_EVENT_TYPES,
  type RunEventSource,
  type RunStreamEvent,
  type RunStreamState,
} from "./run-events";

/** EventSource test double mirroring the parts of the spec the client relies on. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  // -- test helpers ---------------------------------------------------------
  simulateOpen(): void {
    this.readyState = 1;
    this.dispatch("open", {});
  }

  simulateEvent(event: AgentEvent | RunEvent): void {
    this.dispatch(event.type, { data: JSON.stringify(event) });
  }

  simulateRaw(type: string, data: unknown): void {
    this.dispatch(type, { data });
  }

  simulateError(reconnecting: boolean): void {
    this.readyState = reconnecting ? 0 : 2;
    this.dispatch("error", {});
  }

  private dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function connect(mock: {
  runId?: string;
  afterSeq?: number;
  events: RunStreamEvent[];
  states?: RunStreamState[];
}): { handle: ReturnType<typeof connectRunEvents>; source: MockEventSource } {
  MockEventSource.instances = [];
  const events = mock.events;
  const states = mock.states ?? [];
  const statesWanted = mock.states !== undefined;
  const handle = connectRunEvents({
    runId: mock.runId ?? "run-1",
    ...(mock.afterSeq === undefined ? {} : { afterSeq: mock.afterSeq }),
    baseUrl: "http://daemon.test:8787",
    sourceFactory: MockEventSource as new (url: string) => RunEventSource,
    onEvent: (event) => events.push(event),
    onStateChange: statesWanted ? (state) => states.push(state) : undefined,
  });
  const source = MockEventSource.instances[0];
  if (!source) throw new Error("EventSource was not constructed");
  return { handle, source };
}

describe("runEventsUrl", () => {
  it("builds the stream URL for a run", () => {
    expect(runEventsUrl("run/1", "http://d:8787")).toBe("http://d:8787/api/runs/run%2F1/events");
  });

  it("appends an explicit cursor when given", () => {
    expect(runEventsUrl("run-1", "http://d:8787", 42)).toBe(
      "http://d:8787/api/runs/run-1/events?afterSeq=42",
    );
  });

  it("appends the token (EventSource cannot set headers, #92) beside the cursor", () => {
    expect(runEventsUrl("run-1", "http://d:8787", 42, "tok-en")).toBe(
      "http://d:8787/api/runs/run-1/events?afterSeq=42&token=tok-en",
    );
    expect(runEventsUrl("run-1", "http://d:8787", undefined, "tok-en")).toBe(
      "http://d:8787/api/runs/run-1/events?token=tok-en",
    );
  });

  it("omits the token param when there is none", () => {
    expect(runEventsUrl("run-1", "http://d:8787", 42, null)).toBe(
      "http://d:8787/api/runs/run-1/events?afterSeq=42",
    );
  });
});

describe("parseRunStreamEvent", () => {
  it("parses each agent event variant", () => {
    const samples: AgentEvent[] = [
      { type: "started", seq: 0 },
      { type: "session", seq: 1, sessionId: "s1" },
      { type: "message-delta", seq: 2, delta: "hi" },
      { type: "tool-call", seq: 3, tool: "bash", input: { cmd: "ls" } },
      { type: "tool-output", seq: 4, output: "file" },
      { type: "done", seq: 5 },
      { type: "error", seq: 6, message: "boom" },
    ];
    for (const sample of samples) {
      expect(parseRunStreamEvent(JSON.stringify(sample))).toEqual(sample);
    }
  });

  it("parses the run.status event", () => {
    const event: RunStatusEvent = { type: "run.status", seq: 9, status: "success" };
    expect(parseRunStreamEvent(JSON.stringify(event))).toEqual(event);
  });

  it("parses engine step events", () => {
    const started = {
      type: "step.started",
      seq: 2,
      stepId: "s1",
      stepName: "implement",
      iteration: 1,
    };
    const completed = {
      type: "step.completed",
      seq: 7,
      stepId: "s1",
      stepName: "implement",
      iteration: 2,
      status: "failed" as const,
    };
    expect(parseRunStreamEvent(JSON.stringify(started))).toEqual(started);
    expect(parseRunStreamEvent(JSON.stringify(completed))).toEqual(completed);
  });

  it("parses loop.iteration events and registers them on the stream", () => {
    const loop = {
      type: "loop.iteration",
      seq: 5,
      iteration: 2,
      verdict: "continue",
      detail: 'outputContains "DONE" unmet',
    };
    expect(parseRunStreamEvent(JSON.stringify(loop))).toEqual(loop);

    // The stream wires one listener per RUN_EVENT_TYPES entry; the loop event
    // type must be among them so live verdicts reach the feed.
    expect(RUN_EVENT_TYPES).toContain("loop.iteration");
    const events: RunStreamEvent[] = [];
    const { source } = connect({ events });
    source.simulateOpen();
    source.simulateEvent({
      type: "loop.iteration",
      seq: 6,
      iteration: 1,
      verdict: "exit-condition-met",
    });
    expect(events).toHaveLength(1);
  });

  it("returns null for malformed or unknown payloads", () => {
    expect(parseRunStreamEvent("not json")).toBeNull();
    expect(parseRunStreamEvent(JSON.stringify({ type: "mystery", seq: 1 }))).toBeNull();
    expect(parseRunStreamEvent(JSON.stringify({ type: "done", seq: "x" }))).toBeNull();
  });
});

describe("connectRunEvents", () => {
  it("connects to the run events URL and registers every event type", () => {
    const { source } = connect({ events: [] });
    expect(source.url).toBe("http://daemon.test:8787/api/runs/run-1/events");
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("passes the explicit cursor as afterSeq", () => {
    const { source } = connect({ events: [], afterSeq: 7 });
    expect(source.url).toBe("http://daemon.test:8787/api/runs/run-1/events?afterSeq=7");
  });

  it("delivers parsed events in order and tracks the last seq", () => {
    const events: RunStreamEvent[] = [];
    const states: RunStreamState[] = [];
    const { handle, source } = connect({ events, states });

    source.simulateOpen();
    source.simulateEvent({ type: "started", seq: 0 });
    source.simulateEvent({ type: "session", seq: 1, sessionId: "abc" });
    source.simulateEvent({ type: "message-delta", seq: 2, delta: "hello" });

    expect(events.map((event) => event.type)).toEqual(["started", "session", "message-delta"]);
    expect(handle.lastSeq).toBe(2);
    expect(states).toEqual(["open"]);
    expect(handle.state).toBe("open");
  });

  it("closes the stream after the terminal run.status event", () => {
    const events: RunStreamEvent[] = [];
    const states: RunStreamState[] = [];
    const { source } = connect({ events, states });

    source.simulateOpen();
    source.simulateEvent({ type: "done", seq: 3 });
    source.simulateEvent({ type: "run.status", seq: 4, status: "aborted" });

    expect(events.map((event) => event.type)).toEqual(["done", "run.status"]);
    expect(source.closed).toBe(true);
    expect(states).toEqual(["open", "closed"]);

    // Nothing further is delivered once terminal.
    source.simulateEvent({ type: "message-delta", seq: 5, delta: "late" });
    expect(events).toHaveLength(2);
  });

  it("keeps the stream open on non-terminal run.status frames (engine `running`)", () => {
    const events: RunStreamEvent[] = [];
    const states: RunStreamState[] = [];
    const { handle, source } = connect({ events, states });

    source.simulateOpen();
    source.simulateEvent({ type: "run.status", seq: 1, status: "running" });
    source.simulateEvent({
      type: "step.started",
      seq: 2,
      stepId: "s1",
      stepName: "implement",
      iteration: 1,
    });
    source.simulateEvent({ type: "session", seq: 3, sessionId: "s1" });

    expect(handle.state).toBe("open");
    expect(source.closed).toBe(false);
    expect(events.map((event) => event.type)).toEqual(["run.status", "step.started", "session"]);
  });

  it("reports reconnecting (not fatal) when the browser retries", () => {
    const events: RunStreamEvent[] = [];
    const states: RunStreamState[] = [];
    const { source } = connect({ events, states });

    source.simulateOpen();
    source.simulateEvent({ type: "message-delta", seq: 1, delta: "a" });
    source.simulateError(true);

    expect(source.closed).toBe(false);
    expect(states).toEqual(["open", "reconnecting"]);

    // Native retry replays from Last-Event-ID; the client keeps the same source.
    source.simulateOpen();
    source.simulateEvent({ type: "message-delta", seq: 2, delta: "b" });
    expect(states).toEqual(["open", "reconnecting", "open"]);
    expect(events).toHaveLength(2);
  });

  it("moves to error (not closed) on a fatal error and keeps the handle", () => {
    const events: RunStreamEvent[] = [];
    const states: RunStreamState[] = [];
    const { handle, source } = connect({ events, states });

    source.simulateError(false);
    expect(source.closed).toBe(true);
    expect(states).toEqual(["error"]);
    expect(handle.state).toBe("error");
    expect(handle.lastSeq).toBe(-1);
  });

  it("reconnect() dials a fresh source resuming from the last delivered seq", () => {
    const events: RunStreamEvent[] = [];
    const states: RunStreamState[] = [];
    const { handle, source } = connect({ events, states });

    source.simulateOpen();
    source.simulateEvent({ type: "message-delta", seq: 2, delta: "a" });
    source.simulateError(false);
    expect(handle.state).toBe("error");

    handle.reconnect();
    const next = MockEventSource.instances[1];
    if (!next) throw new Error("reconnect did not construct a new EventSource");
    expect(next.url).toBe("http://daemon.test:8787/api/runs/run-1/events?afterSeq=2");
    expect(next.closed).toBe(false);
    expect(handle.state).toBe("connecting");
    expect(states).toEqual(["open", "error", "connecting"]);

    next.simulateOpen();
    next.simulateEvent({ type: "message-delta", seq: 3, delta: "b" });
    next.simulateEvent({ type: "message-delta", seq: 2, delta: "replayed" });
    expect(handle.state).toBe("open");
    expect(handle.lastSeq).toBe(3);
    expect(events).toEqual([
      { type: "message-delta", seq: 2, delta: "a" },
      { type: "message-delta", seq: 3, delta: "b" },
    ]);
  });

  it("reconnect() omits the cursor when nothing was delivered yet", () => {
    const { handle, source } = connect({ events: [] });

    source.simulateError(false);
    handle.reconnect();
    const next = MockEventSource.instances[1];
    if (!next) throw new Error("reconnect did not construct a new EventSource");
    expect(next.url).toBe("http://daemon.test:8787/api/runs/run-1/events");
  });

  it("reconnect() is a no-op once the stream closed for good", () => {
    const events: RunStreamEvent[] = [];
    const states: RunStreamState[] = [];
    const { handle, source } = connect({ events, states });

    source.simulateOpen();
    source.simulateEvent({ type: "run.status", seq: 1, status: "success" });
    expect(handle.state).toBe("closed");

    handle.reconnect();
    expect(MockEventSource.instances).toHaveLength(1);
    expect(states).toEqual(["open", "closed"]);
  });

  it("ignores malformed frames without throwing", () => {
    const events: RunStreamEvent[] = [];
    const { source } = connect({ events });

    source.simulateOpen();
    source.simulateRaw("message-delta", "{{{not json");
    source.simulateRaw("tool-call", JSON.stringify({ type: "nope", seq: 1 }));
    expect(events).toEqual([]);
  });

  it("skips events at or before the cursor (replay dedupe)", () => {
    const events: RunStreamEvent[] = [];
    const { handle, source } = connect({ events });

    source.simulateOpen();
    source.simulateEvent({ type: "message-delta", seq: 2, delta: "a" });
    source.simulateEvent({ type: "message-delta", seq: 2, delta: "a" });
    source.simulateEvent({ type: "message-delta", seq: 1, delta: "old" });
    source.simulateEvent({ type: "message-delta", seq: 3, delta: "b" });

    expect(events).toEqual([
      { type: "message-delta", seq: 2, delta: "a" },
      { type: "message-delta", seq: 3, delta: "b" },
    ]);
    expect(handle.lastSeq).toBe(3);
  });

  it("honors an initial afterSeq cursor", () => {
    const events: RunStreamEvent[] = [];
    const { source } = connect({ events, afterSeq: 10 });

    source.simulateEvent({ type: "message-delta", seq: 10, delta: "replayed" });
    source.simulateEvent({ type: "message-delta", seq: 11, delta: "new" });
    expect(events).toEqual([{ type: "message-delta", seq: 11, delta: "new" }]);
  });

  it("close() stops delivery and closes the source", () => {
    const events: RunStreamEvent[] = [];
    const states: RunStreamState[] = [];
    const { handle, source } = connect({ events, states });

    handle.close();
    expect(source.closed).toBe(true);
    expect(states).toEqual(["closed"]);

    source.simulateEvent({ type: "error", seq: 1, message: "late" });
    expect(events).toEqual([]);
  });

  it("registers a listener for every documented event type", () => {
    const { source } = connect({ events: [] });
    for (const type of RUN_EVENT_TYPES) {
      source.simulateRaw(type, "not json"); // listener exists → no throw
    }
  });
});
