"use client";

import { useEffect, useRef, useState } from "react";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { RunDetailCache } from "@/lib/lanes/detail-loader";
import { HistoryFilmstrip } from "./HistoryFilmstrip";
import { LiveLanes } from "./LiveLanes";

type LanesMode = "live" | "history";

const MODE_TABS: ReadonlyArray<TabItem<LanesMode>> = [
  { id: "live", label: "Live" },
  { id: "history", label: "History" },
];

/**
 * Workmux lanes (#113): the "watch your team" surface for parallelism.
 * Live board (one column per active run, patched by the global run-status
 * stream) with a toggle to the history filmstrip (last terminal runs as
 * duration-proportional swimlanes). One detail cache spans the whole visit —
 * flipping Live ⇄ History never refetches a row already seen.
 */
export function LanesView() {
  const [mode, setMode] = useState<LanesMode>("live");
  const cacheRef = useRef<RunDetailCache | null>(null);
  if (cacheRef.current === null) cacheRef.current = new RunDetailCache();
  const cache = cacheRef.current;

  // Unmount cleanup: the whole cache (and its lazy per-run fetches) goes.
  useEffect(() => () => cacheRef.current?.dispose(), []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-fg">
          Every active run in flight side by side — raise{" "}
          <code className="rounded bg-elevated px-1 py-0.5 font-mono text-xs text-fg">
            MAX_CONCURRENT_RUNS
          </code>{" "}
          on the daemon to watch wider batches.
        </p>
        <Tabs tabs={MODE_TABS} active={mode} onChange={setMode} label="Lanes mode" />
      </div>
      {mode === "live" ? <LiveLanes /> : <HistoryFilmstrip cache={cache} />}
    </div>
  );
}
