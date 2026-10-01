"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  FEED_FILTERS,
  FEED_WINDOW_SIZE,
  FEED_WINDOW_STEP,
  filterFeed,
  windowFeed,
  type FeedEntry,
  type FeedFilter,
} from "@/lib/run-feed";
import type { RunStreamState } from "@/lib/run-events";
import { FeedItem } from "./FeedItem";

/** Pixels from the bottom still counted as "following" the feed. */
const NEAR_BOTTOM_PX = 48;

const STREAM_STATE_STYLES: Record<RunStreamState, { label: string; className: string }> = {
  connecting: { label: "Connecting…", className: "bg-warning-subtle text-warning" },
  open: { label: "Live", className: "bg-success-subtle text-success" },
  reconnecting: { label: "Reconnecting…", className: "bg-warning-subtle text-warning" },
  error: { label: "Stream error", className: "bg-danger-subtle text-danger" },
  closed: { label: "Stream closed", className: "bg-elevated text-muted-fg" },
};

/**
 * Scrollable run event feed: filters, last-N windowing with a scroll-
 * compensated load-earlier affordance, and auto-scroll that pauses when the
 * user scrolls up (resumed via the "jump to latest" button).
 */
export function EventFeed({
  entries,
  streamState,
  onReconnect,
}: {
  entries: FeedEntry[];
  streamState: RunStreamState;
  onReconnect: () => void;
}) {
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [extra, setExtra] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prependHeightRef = useRef<number | null>(null);

  const filtered = useMemo(() => filterFeed(entries, filter), [entries, filter]);
  const { visible, hiddenCount } = useMemo(
    () => windowFeed(filtered, FEED_WINDOW_SIZE, extra),
    [filtered, extra],
  );
  const counts = useMemo(
    () => ({
      all: entries.length,
      messages: filterFeed(entries, "messages").length,
      tools: filterFeed(entries, "tools").length,
    }),
    [entries],
  );

  // Follow the feed unless the user has scrolled away from the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [visible, atBottom]);

  // Prepending rows grows the content above the viewport; keep the anchor
  // stable where the browser lacks scroll anchoring (Safari).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const beforeHeight = prependHeightRef.current;
    if (!el || beforeHeight === null) return;
    prependHeightRef.current = null;
    el.scrollTop += el.scrollHeight - beforeHeight;
  }, [visible]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX);
  };

  const jumpToLatest = (): void => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };

  const loadEarlier = (): void => {
    const el = scrollRef.current;
    prependHeightRef.current = el ? el.scrollHeight : null;
    setExtra((current) => current + FEED_WINDOW_STEP);
  };

  const streamStyle = STREAM_STATE_STYLES[streamState];

  return (
    <section className="rounded-xl border border-border bg-surface shadow-1">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-title font-semibold text-fg">Events</h2>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
              streamStyle.className,
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                streamState === "open" ? "animate-pulse bg-success" : "bg-current",
              )}
            />
            {streamStyle.label}
          </span>
        </div>
        <div role="group" aria-label="Event filter" className="flex items-center gap-1">
          {FEED_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                filter === id
                  ? "bg-accent text-accent-fg"
                  : "text-muted-fg hover:bg-elevated hover:text-fg",
              )}
            >
              {label}
              <span className={cn("ml-1", filter === id ? "text-accent-fg/70" : "text-muted-fg")}>
                {counts[id]}
              </span>
            </button>
          ))}
        </div>
      </header>

      {streamState === "error" ? (
        <div className="flex items-center justify-between gap-3 border-b border-danger/40 bg-danger-subtle px-5 py-2.5">
          <p className="text-sm text-danger">Stream connection lost — events may be incomplete.</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onReconnect}
            className="border-danger/40 bg-surface text-danger hover:bg-danger-subtle"
          >
            Reconnect
          </Button>
        </div>
      ) : null}

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex h-[28rem] flex-col gap-2 overflow-y-auto px-5 py-4"
        >
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={loadEarlier}
              className="mx-auto rounded-md border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-muted-fg transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Showing last {visible.length} of {filtered.length} — load earlier
            </button>
          ) : null}

          {visible.map((entry) => (
            <FeedItem key={entry.id} entry={entry} />
          ))}

          {visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-fg">
              {filter === "all" ? "No events yet." : `No ${filter} yet.`}
            </p>
          ) : null}
        </div>

        {!atBottom ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-2"
          >
            Jump to latest
          </Button>
        ) : null}
      </div>
    </section>
  );
}
