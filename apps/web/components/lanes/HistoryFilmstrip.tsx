"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { TERMINAL_RUN_STATUSES } from "@openeuler/core";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonLines } from "@/components/ui/skeleton";
import { LanesIcon } from "@/components/shell/icons";
import { ApiError } from "@/lib/api";
import { fetchRuns, type RunsApiRow } from "@/lib/runs-stream";
import { formatDuration, formatRelativeAge } from "@/lib/time";
import { useRunDetail, type RunDetailCache } from "@/lib/lanes/detail-loader";
import {
  blockTone,
  filmstripBlocks,
  filmstripBlockTitle,
  filmstripRuler,
} from "@/lib/lanes/filmstrip";
import { cn } from "@/lib/cn";

/** How many terminal runs the filmstrip shows (#113). */
export const FILMSTRIP_RUN_COUNT = 20;

const TONE_CLASS: Record<ReturnType<typeof blockTone>, string> = {
  success: "bg-success",
  failed: "bg-danger",
  warning: "bg-warning",
  info: "bg-info",
};

function RunLabel({ run }: { run: RunsApiRow }) {
  const project = run.project?.name ?? run.projectId.slice(0, 8);
  const workflow =
    run.workflow !== undefined
      ? `${run.workflow.name}${run.workflowRevision !== undefined ? ` · r${run.workflowRevision.number}` : ""}`
      : (run.task ?? "ad-hoc");
  return (
    <Link
      href={`/runs/${encodeURIComponent(run.id)}`}
      title={`${project} / ${workflow} (${run.branch})`}
      className="block min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="block truncate text-sm font-medium text-fg transition-colors hover:text-link">
        {project}
      </span>
      <span className="block truncate text-xs text-muted-fg">{workflow}</span>
    </Link>
  );
}

/** One history swimlane: label | run-level ruler over the node blocks. */
function FilmstripRow({ run, cache }: { run: RunsApiRow; cache: RunDetailCache }) {
  const detail = useRunDetail(run.id, cache);
  const ruler = filmstripRuler(run);

  return (
    <li
      className="grid grid-cols-[minmax(160px,220px)_minmax(0,1fr)] items-center gap-4 border-b border-border py-3 last:border-b-0"
      data-filmstrip-run-id={run.id}
    >
      <div className="min-w-0">
        <RunLabel run={run} />
        <p className="mt-1 flex items-center gap-2 text-xs text-muted-fg">
          <StatusBadge status={run.status} />
          <span className="tabular-nums" title="Total wall-clock duration">
            {formatDuration(ruler.totalMs)}
          </span>
          <span>{formatRelativeAge(run.createdAt)}</span>
        </p>
      </div>
      <div className="min-w-0">
        {/* Run-level start→end ruler (#113). */}
        <div className="relative mb-1 h-4" data-filmstrip-ruler>
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" aria-hidden />
          {ruler.ticks.map((tick) => (
            <span
              key={tick.pct}
              className="absolute top-0 -translate-x-1/2 text-[10px] leading-4 text-muted-fg tabular-nums"
              style={{ left: `${tick.pct}%` }}
              data-ruler-tick
            >
              {tick.label}
            </span>
          ))}
        </div>
        {detail.phase === "loading" ? (
          <div className="h-6 animate-pulse rounded-md bg-elevated" data-filmstrip-loading />
        ) : detail.phase === "error" ? (
          <p className="text-xs text-danger">Failed to load node timings</p>
        ) : (
          <div className="flex h-6 items-stretch gap-[2px]" data-filmstrip-blocks>
            {filmstripBlocks(detail.detail.steps).map((block) => (
              <span
                key={block.stepRunId}
                className={cn("min-w-0 rounded-sm", TONE_CLASS[blockTone(block.status)])}
                style={{ width: `${block.widthPct}%` }}
                title={filmstripBlockTitle(block)}
                data-step-run-id={block.stepRunId}
                data-tone={blockTone(block.status)}
              >
                <span className="sr-only">{filmstripBlockTitle(block)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * History filmstrip (#113): the last {@link FILMSTRIP_RUN_COUNT} terminal
 * runs as horizontal swimlanes — per run a row of node-execution blocks
 * (width ∝ duration, colored by outcome, tooltip name+iteration+duration)
 * fetched lazily per visible row through the shared detail cache.
 */
export function HistoryFilmstrip({ cache }: { cache: RunDetailCache }) {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ready"; runs: RunsApiRow[] }
    | { phase: "error"; message: string }
  >({ phase: "loading" });

  const load = useCallback(async (): Promise<void> => {
    setState((current) => (current.phase === "ready" ? current : { phase: "loading" }));
    try {
      const page = await fetchRuns({
        statuses: [...TERMINAL_RUN_STATUSES],
        limit: FILMSTRIP_RUN_COUNT,
      });
      setState({ phase: "ready", runs: page.rows });
    } catch (cause) {
      setState({
        phase: "error",
        message: cause instanceof ApiError ? cause.message : "Failed to load run history",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card data-testid="history-filmstrip">
      <CardHeader>
        <div>
          <CardTitle>History filmstrip</CardTitle>
          <CardDescription>
            The last {FILMSTRIP_RUN_COUNT} finished runs as swimlanes — block width follows each
            node&rsquo;s duration.
          </CardDescription>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {state.phase === "loading" ? (
          <SkeletonLines rows={5} />
        ) : state.phase === "error" ? (
          <div className="flex flex-col items-start gap-3 py-2 text-sm">
            <p className="text-danger">{state.message}</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : state.runs.length === 0 ? (
          <EmptyState
            icon={<LanesIcon className="size-5" />}
            title="No finished runs yet"
            description="Once runs complete, their node timings land here as swimlanes."
          />
        ) : (
          <ul className="flex flex-col" data-filmstrip-rows>
            {state.runs.map((run) => (
              <FilmstripRow key={run.id} run={run} cache={cache} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
