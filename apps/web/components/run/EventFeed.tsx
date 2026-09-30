"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/Button";
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
  connecting: { label: "Connecting…", className: "bg-amber-50 text-amber-700" },
  open: { label: "Live", className: "bg-emerald-50 text-emerald-700" },
  reconnecting: { label: "Reconnecting…", className: "bg-amber-50 text-amber-700" },
  closed: { label: "Stream closed", className: "bg-slate-100 text-slate-500" },
};

/**
 * Scrollable run event feed: filters, last-N windowing with a load-earlier
 * affordance, and auto-scroll that pauses when the user scrolls up (resumed
 * via the "jump to latest" button).
 */
export function EventFeed({
  entries,
  streamState,
}: {
  entries: FeedEntry[];
  streamState: RunStreamState;
}) {
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [extra, setExtra] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  const streamStyle = STREAM_STATE_STYLES[streamState];

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-slate-900">Events</h2>
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
                streamState === "open" ? "animate-pulse bg-emerald-500" : "bg-current",
              )}
            />
            {streamStyle.label}
          </span>
        </div>
        <div role="tablist" aria-label="Event filter" className="flex items-center gap-1">
          {FEED_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              onClick={() => setFilter(id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                filter === id
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
              )}
            >
              {label}
              <span className={cn("ml-1", filter === id ? "text-slate-300" : "text-slate-400")}>
                {counts[id]}
              </span>
            </button>
          ))}
        </div>
      </header>

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex h-[28rem] flex-col gap-2 overflow-y-auto px-5 py-4"
        >
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setExtra((current) => current + FEED_WINDOW_STEP)}
              className="mx-auto rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              Showing last {visible.length} of {filtered.length} — load earlier
            </button>
          ) : null}

          {visible.map((entry) => (
            <FeedItem key={entry.id} entry={entry} />
          ))}

          {visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">
              {filter === "all" ? "No events yet." : `No ${filter} yet.`}
            </p>
          ) : null}
        </div>

        {!atBottom ? (
          <Button
            variant="secondary"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
          >
            Jump to latest
          </Button>
        ) : null}
      </div>
    </section>
  );
}
