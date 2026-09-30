import { describe, expect, it } from "vitest";
import type { AgentEvent, Run, RunStatusEvent } from "@openeuler/core";
import {
  appendFeedEvent,
  buildFeed,
  entryMatchesFilter,
  FEED_WINDOW_SIZE,
  FEED_WINDOW_STEP,
  filterFeed,
  formatElapsed,
  isLiveRun,
  terminalEndMs,
  windowFeed,
  type FeedEntry,
} from "./run-feed";

const delta = (seq: number, text: string): AgentEvent => ({
  type: "message-delta",
  seq,
  delta: text,
});

/** A non-delta event so every call becomes its own feed row. */
const row = (seq: number): AgentEvent => ({ type: "session", seq, sessionId: `s-${seq}` });

describe("appendFeedEvent", () => {
  it("merges consecutive message-deltas into one growing block", () => {
    let entries = appendFeedEvent([], delta(1, "Hello"));
    entries = appendFeedEvent(entries, delta(2, " "));
    entries = appendFeedEvent(entries, delta(3, "world"));

    expect(entries).toEqual([{ kind: "message", id: "seq-1", text: "Hello world" }]);
  });

  it("starts a new message block after any non-delta event", () => {
    let entries = appendFeedEvent([], delta(1, "first"));
    entries = appendFeedEvent(entries, {
      type: "tool-call",
      seq: 2,
      tool: "bash",
      input: { cmd: "ls" },
    });
    entries = appendFeedEvent(entries, delta(3, "second"));

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "event", "message"]);
    expect(entries[0]).toMatchObject({ kind: "message", text: "first" });
    expect(entries[2]).toMatchObject({ kind: "message", text: "second" });
  });

  it("keeps every non-delta event as its own row", () => {
    const events: Array<AgentEvent | RunStatusEvent> = [
      { type: "started", seq: 0 },
      { type: "session", seq: 1, sessionId: "s" },
      { type: "error", seq: 2, message: "boom" },
      { type: "run.status", seq: 3, status: "failed" },
    ];
    const entries = buildFeed(events);
    expect(entries).toEqual(
      events.map((event) => ({ kind: "event", id: `seq-${event.seq}`, event })),
    );
  });

  it("buildFeed folds a realistic mixed stream", () => {
    const entries = buildFeed([
      { type: "started", seq: 0 },
      { type: "session", seq: 1, sessionId: "s" },
      delta(2, "thinking "),
      delta(3, "…"),
      { type: "tool-call", seq: 4, tool: "edit", input: { file: "a.ts" } },
      { type: "tool-output", seq: 5, output: "ok" },
      delta(6, "done "),
      delta(7, "here"),
      { type: "done", seq: 8 },
      { type: "run.status", seq: 9, status: "success" },
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "event",
      "event",
      "message",
      "event",
      "event",
      "message",
      "event",
      "event",
    ]);
    expect(entries[2]).toMatchObject({ text: "thinking …" });
    expect(entries[5]).toMatchObject({ text: "done here" });
  });
});

describe("windowFeed", () => {
  it("shows everything when the feed fits the window", () => {
    const entries = buildFeed([delta(1, "a"), { type: "done", seq: 2 }]);
    expect(windowFeed(entries)).toEqual({ visible: entries, hiddenCount: 0 });
  });

  it("windows exactly at the boundary", () => {
    const entries = buildFeed(Array.from({ length: FEED_WINDOW_SIZE }, (_, i) => row(i)));
    const result = windowFeed(entries);
    expect(result.visible).toHaveLength(FEED_WINDOW_SIZE);
    expect(result.hiddenCount).toBe(0);
  });

  it("keeps only the last N rows for long feeds", () => {
    const entries = buildFeed(Array.from({ length: 500 }, (_, i) => row(i)));
    const { visible, hiddenCount } = windowFeed(entries);
    expect(visible).toHaveLength(200);
    expect(hiddenCount).toBe(300);
    // The newest events stay visible.
    expect(visible[visible.length - 1]).toMatchObject({ id: "seq-499" });
    expect(visible[0]).toMatchObject({ id: "seq-300" });
  });

  it("load-earlier grows the window by the step", () => {
    const entries = buildFeed(Array.from({ length: 500 }, (_, i) => row(i)));
    const step1 = windowFeed(entries, FEED_WINDOW_SIZE, FEED_WINDOW_STEP);
    expect(step1.visible).toHaveLength(400);
    expect(step1.hiddenCount).toBe(100);
    const step2 = windowFeed(entries, FEED_WINDOW_SIZE, FEED_WINDOW_STEP * 2);
    expect(step2.visible).toHaveLength(500);
    expect(step2.hiddenCount).toBe(0);
  });

  it("windows merged message blocks together with other rows", () => {
    const entries = buildFeed([
      ...Array.from({ length: 250 }, (_, i) => row(i)),
      delta(250, "merged "),
      delta(251, "message"),
    ]);
    const { visible, hiddenCount } = windowFeed(entries);
    expect(entries).toHaveLength(251);
    expect(visible).toHaveLength(200);
    expect(hiddenCount).toBe(51);
    expect(visible[visible.length - 1]).toMatchObject({ kind: "message", text: "merged message" });
  });
});

describe("filters", () => {
  const entries = buildFeed([
    { type: "started", seq: 0 },
    delta(1, "hello"),
    { type: "tool-call", seq: 2, tool: "bash", input: {} },
    { type: "tool-output", seq: 3, output: "out" },
    delta(4, "bye"),
    { type: "error", seq: 5, message: "nope" },
  ]);

  it("all keeps every entry", () => {
    expect(filterFeed(entries, "all")).toHaveLength(entries.length);
  });

  it("messages keeps only merged message blocks", () => {
    expect(filterFeed(entries, "messages")).toEqual([
      { kind: "message", id: "seq-1", text: "hello" },
      { kind: "message", id: "seq-4", text: "bye" },
    ]);
  });

  it("tools keeps tool calls and tool outputs", () => {
    const tools = filterFeed(entries, "tools");
    expect(tools.map((entry) => (entry as { event: { type: string } }).event.type)).toEqual([
      "tool-call",
      "tool-output",
    ]);
  });

  it("entryMatchesFilter handles every kind", () => {
    const message: FeedEntry = { kind: "message", id: "m", text: "x" };
    const toolCall: FeedEntry = {
      kind: "event",
      id: "t",
      event: { type: "tool-call", seq: 1, tool: "t" },
    };
    const error: FeedEntry = {
      kind: "event",
      id: "e",
      event: { type: "error", seq: 2, message: "x" },
    };
    expect(entryMatchesFilter(message, "messages")).toBe(true);
    expect(entryMatchesFilter(toolCall, "messages")).toBe(false);
    expect(entryMatchesFilter(toolCall, "tools")).toBe(true);
    expect(entryMatchesFilter(error, "tools")).toBe(false);
    expect(entryMatchesFilter(error, "all")).toBe(true);
  });
});

describe("formatElapsed", () => {
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;

  it("formats seconds", () => {
    expect(formatElapsed(0, 0)).toBe("0s");
    expect(formatElapsed(0, 7 * SECOND)).toBe("7s");
    expect(formatElapsed(0, 59 * SECOND + 999)).toBe("59s");
  });

  it("formats minutes with zero-padded seconds", () => {
    expect(formatElapsed(0, MINUTE)).toBe("1m 00s");
    expect(formatElapsed(0, 2 * MINUTE + 4 * SECOND)).toBe("2m 04s");
  });

  it("formats hours with padded minutes and seconds", () => {
    expect(formatElapsed(0, HOUR + MINUTE + SECOND)).toBe("1h 01m 01s");
    expect(formatElapsed(0, 5 * HOUR + 2 * MINUTE + 3 * SECOND)).toBe("5h 02m 03s");
  });

  it("clamps negative spans to zero", () => {
    expect(formatElapsed(10_000, 0)).toBe("0s");
  });

  it("floors partial seconds", () => {
    expect(formatElapsed(0, 1_500)).toBe("1s");
  });
});

describe("isLiveRun", () => {
  it("is live only while queued or running", () => {
    expect(isLiveRun("queued")).toBe(true);
    expect(isLiveRun("running")).toBe(true);
    expect(isLiveRun("success")).toBe(false);
    expect(isLiveRun("failed")).toBe(false);
    expect(isLiveRun("aborted")).toBe(false);
    expect(isLiveRun("interrupted")).toBe(false);
  });
});

describe("terminalEndMs", () => {
  const completedRun: Run = {
    id: "run-1",
    projectId: "proj-1",
    status: "success",
    branch: "openeuler/run-1",
    iteration: 0,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:07:30.000Z",
  };

  it("prefers the run row's updatedAt for an already-terminal row", () => {
    expect(terminalEndMs(completedRun, Date.parse("2026-10-01T09:00:00.000Z"))).toBe(
      Date.parse("2026-09-30T10:07:30.000Z"),
    );
  });

  it("falls back to the observed time while the row is still live", () => {
    const liveRun: Run = { ...completedRun, status: "running" };
    expect(terminalEndMs(liveRun, 1234)).toBe(1234);
  });

  it("falls back to the observed time without a run row", () => {
    expect(terminalEndMs(null, 1234)).toBe(1234);
  });

  it("falls back to the observed time when updatedAt is unparseable", () => {
    expect(terminalEndMs({ ...completedRun, updatedAt: "yesterday" }, 1234)).toBe(1234);
  });

  it("anchors a completed run's duration at createdAt→updatedAt, not now", () => {
    const startedMs = Date.parse(completedRun.createdAt);
    const endMs = terminalEndMs(completedRun, Date.now());
    expect(formatElapsed(startedMs, endMs)).toBe("7m 30s");
  });
});
