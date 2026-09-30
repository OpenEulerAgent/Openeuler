import type {
  AgentMessageDeltaEvent,
  AgentEvent,
  Run,
  RunStatus,
  RunStatusEvent,
  TerminalRunStatus,
} from "@openeuler/core";
import type { RunStreamEvent } from "./run-events";

/** Events rendered as their own row in the feed (message-deltas get merged instead). */
export type NonDeltaFeedEvent = Exclude<AgentEvent, AgentMessageDeltaEvent>;

/**
 * One renderable feed row. Consecutive `message-delta` events are merged into
 * a single growing `message` entry; everything else stays a discrete `event`.
 */
export type FeedEntry =
  | { kind: "message"; id: string; text: string }
  | { kind: "event"; id: string; event: NonDeltaFeedEvent | RunStatusEvent };

export type FeedFilter = "all" | "messages" | "tools";

export const FEED_FILTERS: ReadonlyArray<{ id: FeedFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "messages", label: "Messages" },
  { id: "tools", label: "Tools" },
];

/** How many feed rows render in the DOM at once (responsiveness on long runs). */
export const FEED_WINDOW_SIZE = 200;
/** How many extra rows each "load earlier" click reveals. */
export const FEED_WINDOW_STEP = 200;

/** `true` while a run can still produce events (elapsed time keeps ticking). */
export function isLiveRun(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * End timestamp to anchor the elapsed label when the stream reports a
 * terminal status: the run row's `updatedAt` once that row is itself
 * terminal (authoritative, so replayed runs keep their true duration),
 * otherwise the moment the live→terminal transition was observed (the row
 * is stale until it is refetched).
 */
export function terminalEndMs(run: Run | null, observedAtMs: number): number {
  if (run === null || isLiveRun(run.status)) return observedAtMs;
  const rowEndMs = Date.parse(run.updatedAt);
  return Number.isNaN(rowEndMs) ? observedAtMs : rowEndMs;
}

/**
 * Append one stream event to the feed. Consecutive message-deltas merge into
 * the previous `message` entry; any other event starts a new row (so a delta
 * after a tool-call opens a fresh message block).
 */
export function appendFeedEvent(entries: readonly FeedEntry[], event: RunStreamEvent): FeedEntry[] {
  if (event.type === "message-delta") {
    const last = entries[entries.length - 1];
    if (last?.kind === "message") {
      const merged = { ...last, text: last.text + event.delta };
      return entries.length === 1 ? [merged] : [...entries.slice(0, -1), merged];
    }
    return [...entries, { kind: "message", id: `seq-${event.seq}`, text: event.delta }];
  }
  return [...entries, { kind: "event", id: `seq-${event.seq}`, event }];
}

/** Fold a whole batch of stream events into feed entries (bulk replay). */
export function buildFeed(events: readonly RunStreamEvent[]): FeedEntry[] {
  return events.reduce<FeedEntry[]>((entries, event) => appendFeedEvent(entries, event), []);
}

/** Does this row appear under the given filter? */
export function entryMatchesFilter(entry: FeedEntry, filter: FeedFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "messages":
      return entry.kind === "message";
    case "tools":
      return (
        entry.kind === "event" &&
        (entry.event.type === "tool-call" || entry.event.type === "tool-output")
      );
  }
}

export function filterFeed(entries: readonly FeedEntry[], filter: FeedFilter): FeedEntry[] {
  return filter === "all"
    ? [...entries]
    : entries.filter((entry) => entryMatchesFilter(entry, filter));
}

export interface FeedWindow {
  /** Rows to actually render. */
  visible: FeedEntry[];
  /** Rows before the window (hidden from the DOM). */
  hiddenCount: number;
}

/**
 * Keep only the last `limit + extra` rows in the DOM. `extra` grows by
 * FEED_WINDOW_STEP per "load earlier" click so long runs stay responsive.
 */
export function windowFeed(
  entries: readonly FeedEntry[],
  limit: number = FEED_WINDOW_SIZE,
  extra: number = 0,
): FeedWindow {
  const size = Math.max(1, limit + Math.max(0, extra));
  const hiddenCount = Math.max(0, entries.length - size);
  return { visible: entries.slice(hiddenCount), hiddenCount };
}

/** Compact elapsed-time label: `7s`, `2m 04s`, `1h 02m 03s`. */
export function formatElapsed(fromMs: number, toMs: number): string {
  const total = Math.max(0, Math.floor((toMs - fromMs) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Terminal label/colors for the `run.status` banner (mirrors StatusBadge tones). */
export const TERMINAL_STATUS_STYLES: Record<
  TerminalRunStatus,
  { label: string; className: string }
> = {
  success: {
    label: "Run finished: success",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  failed: { label: "Run failed", className: "border-red-200 bg-red-50 text-red-700" },
  aborted: { label: "Run aborted", className: "border-amber-200 bg-amber-50 text-amber-700" },
  interrupted: {
    label: "Run interrupted",
    className: "border-violet-200 bg-violet-50 text-violet-700",
  },
};
