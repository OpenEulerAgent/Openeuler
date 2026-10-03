"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonLines } from "@/components/ui/skeleton";
import { LanesIcon } from "@/components/shell/icons";
import { ApiError } from "@/lib/api";
import { isRunHosted } from "@/lib/hosting";
import { fetchRuns, useRunStatusStream, type RunsApiRow } from "@/lib/runs-stream";
import { formatDuration, runDuration } from "@/lib/time";
import {
  isLaneActiveStatus,
  LANES_REFETCH_DEBOUNCE_MS,
  lanesReducer,
  type LaneCard,
} from "@/lib/lanes/lanes-reducer";
import { cn } from "@/lib/cn";

/** Seed page size for `GET /api/runs?status=running,queued` (#113). */
export const LANES_SEED_LIMIT = 50;

/** Elapsed timers tick once per second while the board is mounted. */
const ELAPSED_TICK_MS = 1_000;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Node executions off the breadcrumb (graph runs), else the loop pass. */
function iterationCount(run: RunsApiRow): number {
  const breadcrumb = Array.isArray(run.breadcrumb) ? run.breadcrumb : [];
  const nodes = breadcrumb.filter(
    (entry) =>
      typeof entry === "object" && entry !== null && (entry as { kind?: string }).kind === "node",
  ).length;
  return nodes > 0 ? nodes : run.iteration;
}

/** Hosted (#110) / sandboxed (#107) pills — the run row's own badges. */
function LaneBadges({ run }: { run: LaneCard }) {
  return (
    <span className="flex items-center gap-1.5">
      {run.ports !== undefined && run.ports.length > 0 ? (
        <span
          className="rounded-full border border-info/50 bg-info-subtle px-2 py-0.5 text-xs font-medium text-info"
          title="Sandboxed run (declared preview ports)"
        >
          sandbox
        </span>
      ) : null}
      {isRunHosted(run) ? (
        <span
          className="rounded-full border border-success/50 bg-success-subtle px-2 py-0.5 text-xs font-medium text-success"
          title="Sandbox kept alive for previews (hosting)"
          data-hosted-badge
        >
          hosted
        </span>
      ) : null}
    </span>
  );
}

function LaneCardView({ run, now }: { run: LaneCard; now: number }) {
  return (
    <Link
      href={`/runs/${encodeURIComponent(run.id)}`}
      aria-label={`Open run ${run.project?.name ?? run.projectId.slice(0, 8)} ${run.workflow?.name ?? run.task ?? run.branch}`}
      data-lane-run-id={run.id}
      data-exiting={run.exiting === true ? "true" : undefined}
      className={cn(
        "block rounded-xl border border-border bg-surface p-4 shadow-1 transition-all duration-700",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        run.exiting === true ? "scale-[0.97] opacity-30 saturate-50" : "opacity-100",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">
            {run.project?.name ?? run.projectId.slice(0, 8)}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-fg" title={run.task ?? run.branch}>
            {run.workflow !== undefined
              ? `${run.workflow.name}${run.workflowRevision !== undefined ? ` · r${run.workflowRevision.number}` : ""}`
              : (run.task ?? run.branch ?? "ad-hoc")}
          </p>
        </div>
        <StatusBadge status={run.status}>
          {run.status === "queued" && run.queuePosition !== undefined
            ? `Queued · #${run.queuePosition}`
            : undefined}
        </StatusBadge>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-fg">
        <span className="tabular-nums" data-lane-stats>
          {iterationCount(run)} execs
        </span>
        <span className="flex items-center gap-1.5">
          <LaneBadges run={run} />
          <span className="tabular-nums" data-lane-elapsed title="Elapsed">
            {formatDuration(runDuration(run, now))}
          </span>
        </span>
      </div>
    </Link>
  );
}

type LoadState = { phase: "loading" } | { phase: "ready" } | { phase: "error"; message: string };

/**
 * Live lanes board (#113): one column per ACTIVE run (queued/running),
 * seeded from the runs table and patched in place by the page-wide shared
 * run-status stream — new runs appear as they queue (placeholder + debounced
 * seed refetch), terminal runs fade and exit after 5s.
 */
export function LiveLanes() {
  const [lanes, dispatch] = useReducer(lanesReducer, [] as LaneCard[]);
  const [loadState, setLoadState] = useState<LoadState>({ phase: "loading" });
  const now = useNow(ELAPSED_TICK_MS);

  const seed = useCallback(async (): Promise<void> => {
    setLoadState((current) => (current.phase === "ready" ? current : { phase: "loading" }));
    try {
      const page = await fetchRuns({ statuses: ["running", "queued"], limit: LANES_SEED_LIMIT });
      dispatch({ type: "seeded", rows: page.rows });
      setLoadState({ phase: "ready" });
    } catch (cause) {
      setLoadState({
        phase: "error",
        message: cause instanceof ApiError ? cause.message : "Failed to load lanes",
      });
    }
  }, []);

  useEffect(() => {
    void seed();
  }, [seed]);

  // Unknown-id transitions add a placeholder lane; a debounced seed refetch
  // fills it with the full row (project/workflow names, queue position).
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefetch = useCallback((): void => {
    if (refetchTimer.current !== null) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void seed();
    }, LANES_REFETCH_DEBOUNCE_MS);
  }, [seed]);

  useRunStatusStream({
    onEvent: (event) => {
      const known = lanesRef.current.some((lane) => lane.id === event.runId);
      dispatch({ type: "streamEvent", event });
      if (!known && isLaneActiveStatus(event.status)) scheduleRefetch();
    },
    onOpen: () => {
      void seed();
    },
  });

  useEffect(
    () => () => {
      if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
    },
    [],
  );

  // Exit-fade pruning: one timer to the earliest pending exit.
  const nextExitMs = lanes.reduce<number>(
    (earliest, lane) =>
      lane.exitAtMs !== undefined && lane.exiting === true
        ? Math.min(earliest, lane.exitAtMs)
        : earliest,
    Number.POSITIVE_INFINITY,
  );
  useEffect(() => {
    if (!Number.isFinite(nextExitMs)) return;
    const delay = Math.max(0, nextExitMs - Date.now());
    const timer = setTimeout(() => dispatch({ type: "pruneExpired", nowMs: Date.now() }), delay);
    return () => clearTimeout(timer);
  }, [nextExitMs]);

  return (
    <Card data-testid="live-lanes">
      <CardHeader>
        <div>
          <CardTitle>Live lanes</CardTitle>
          <CardDescription>
            One column per active run — new runs appear as they queue, finished runs fade out.
          </CardDescription>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void seed()}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {loadState.phase === "loading" ? (
          <SkeletonLines rows={3} />
        ) : loadState.phase === "error" ? (
          <div className="flex flex-col items-start gap-3 py-2 text-sm">
            <p className="text-danger">{loadState.message}</p>
            <Button variant="secondary" size="sm" onClick={() => void seed()}>
              Retry
            </Button>
          </div>
        ) : lanes.length === 0 ? (
          <EmptyState
            icon={<LanesIcon className="size-5" />}
            title="No active runs"
            description="Start a workflow or an ad-hoc task — its lane lights up here the moment it queues."
          />
        ) : (
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            data-lane-count={lanes.length}
          >
            {lanes.map((lane) => (
              <LaneCardView key={lane.id} run={lane} now={now} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
