"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Project, RunStatus } from "@openeuler/core";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonLines } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { PlayIcon } from "@/components/shell/icons";
import { apiFetch, ApiError } from "@/lib/api";
import { isRunHosted } from "@/lib/hosting";
import { fetchRuns, useRunStatusStream, type RunsApiRow } from "@/lib/runs-stream";
import { compareHref } from "@/lib/run-compare";
import {
  compareSelectionComplete,
  decodeRunsFilters,
  encodeRunsFilters,
  filterRuns,
  nextStopConfirmState,
  newTempRunId,
  rowActionFor,
  RUNS_FILTER_STATUSES,
  runsTableReducer,
  toggleCompareSelection,
  type StopConfirmState,
} from "@/lib/runs-table";
import { formatDuration, formatRelativeAge, isLiveStatus, runDuration } from "@/lib/time";

/** Refresh ages/durations of live rows without waiting for a stream event. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

type LoadState = { phase: "loading" } | { phase: "ready" } | { phase: "error"; message: string };

/** Iterations column: graph runs count completed node executions, else the loop pass. */
function iterationCount(run: RunsApiRow): number {
  const breadcrumb = Array.isArray(run.breadcrumb) ? run.breadcrumb : [];
  const nodes = breadcrumb.filter(
    (entry) =>
      typeof entry === "object" && entry !== null && (entry as { kind?: string }).kind === "node",
  ).length;
  return nodes > 0 ? nodes : run.iteration;
}

function StopCell({
  state,
  onArm,
  onConfirm,
  onCancel,
}: {
  state: StopConfirmState;
  onArm: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (state === "idle") {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-danger hover:bg-danger-subtle hover:text-danger"
        onClick={onArm}
      >
        Stop
      </Button>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5"
      onKeyDown={(event) => {
        if (event.key === "Escape" && state !== "stopping") onCancel();
      }}
    >
      <Button variant="danger" size="sm" loading={state === "stopping"} onClick={onConfirm}>
        {state === "stopping" ? "Stopping…" : "Confirm stop"}
      </Button>
      {state !== "stopping" ? (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </span>
  );
}

/**
 * Dashboard runs table (#51): project, workflow (+revision), status,
 * iterations, duration, age; status × project filters kept in the URL;
 * inline Stop (arm-confirm) and Retry (optimistic) actions; rows patched
 * live by the global run-status stream. Per-row compare checkboxes (#114)
 * unlock a Compare button at exactly two selections → `/runs/compare`.
 */
export function DashboardRunsTable() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const now = useNow();

  const filters = useMemo(() => decodeRunsFilters(searchParams), [searchParams]);

  const [rows, dispatch] = useReducer(runsTableReducer, [] as RunsApiRow[]);
  const [loadState, setLoadState] = useState<LoadState>({ phase: "loading" });
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [stop, setStop] = useState<{ runId: string; state: StopConfirmState } | null>(null);
  const retryingRef = useRef(new Set<string>());
  /** Compare selection (#114): ticked run ids in click order (A first, B second). */
  const [compareSelection, setCompareSelection] = useState<string[]>([]);

  const toggleCompare = useCallback((runId: string): void => {
    setCompareSelection((current) => toggleCompareSelection(current, runId));
  }, []);

  const setFilters = useCallback(
    (next: { statuses?: RunStatus[]; projectId?: string | undefined }) => {
      const merged = {
        statuses: next.statuses ?? filters.statuses,
        projectId: "projectId" in next ? next.projectId : filters.projectId,
      };
      const query = encodeRunsFilters(merged);
      router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
    },
    [filters, pathname, router],
  );

  const toggleStatus = useCallback(
    (status: RunStatus) => {
      const active = filters.statuses.includes(status);
      const statuses = active
        ? filters.statuses.filter((candidate) => candidate !== status)
        : [...filters.statuses, status];
      setFilters({ statuses });
    },
    [filters, setFilters],
  );

  const loadRuns = useCallback(async (): Promise<void> => {
    setLoadState((current) => (current.phase === "ready" ? current : { phase: "loading" }));
    try {
      const page = await fetchRuns({
        projectId: filters.projectId,
        statuses: filters.statuses.length > 0 ? filters.statuses : undefined,
      });
      dispatch({ type: "rowsLoaded", rows: page.rows });
      setNextCursor(page.nextCursor);
      setLoadState({ phase: "ready" });
    } catch (cause: unknown) {
      setLoadState({
        phase: "error",
        message: cause instanceof ApiError ? cause.message : "Failed to load runs",
      });
    }
  }, [filters]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  /** Load-more: appends the next (older) page behind the current rows. */
  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === undefined) return;
    setLoadingMore(true);
    try {
      const page = await fetchRuns({
        projectId: filters.projectId,
        statuses: filters.statuses.length > 0 ? filters.statuses : undefined,
        before: nextCursor,
      });
      dispatch({ type: "rowsAppended", rows: page.rows });
      setNextCursor(page.nextCursor);
    } catch {
      // Keep the current page; the next Load-more click retries.
    } finally {
      setLoadingMore(false);
    }
  }, [filters, nextCursor]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ projects: Project[] }>("/api/projects")
      .then((body) => {
        if (!cancelled) setProjects(body.projects);
      })
      .catch(() => {
        // Filter dropdown stays empty; the table itself surfaces errors.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live patches: known rows update in place; unknown ids mean a new run —
  // refetch (debounced) so its project/workflow columns render correctly.
  // `useRunStatusStream` dispatches through the CURRENT render's handlers
  // (latest-ref), and the known-check reads a row mirror so events landing
  // between renders never see a stale table; the patch itself is functional
  // (reducer dispatch), never a captured `rows` array.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefetch = useCallback((): void => {
    if (refetchTimer.current !== null) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void loadRuns();
    }, 300);
  }, [loadRuns]);

  useRunStatusStream({
    onEvent: (event) => {
      if (rowsRef.current.some((row) => row.id === event.runId)) {
        dispatch({ type: "streamEvent", event });
      } else {
        scheduleRefetch();
      }
    },
    onOpen: () => {
      void loadRuns();
    },
  });

  useEffect(
    () => () => {
      if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
    },
    [],
  );

  const confirmStop = useCallback(
    async (run: RunsApiRow): Promise<void> => {
      const previous = run.status;
      setStop({ runId: run.id, state: "stopping" });
      dispatch({ type: "stopOptimistic", runId: run.id });
      try {
        await apiFetch(`/api/runs/${encodeURIComponent(run.id)}/abort`, { method: "POST" });
      } catch (cause: unknown) {
        if (cause instanceof ApiError && cause.status === 409) {
          // Ended on its own mid-click: the optimistic row is already right.
        } else {
          dispatch({ type: "stopFailed", runId: run.id, previous });
          toast(
            {
              title: "Stop failed",
              description: cause instanceof ApiError ? cause.message : "Unknown error",
              variant: "danger",
            },
            0,
          );
        }
      } finally {
        setStop(null);
      }
    },
    [toast],
  );

  const retry = useCallback(
    async (run: RunsApiRow): Promise<void> => {
      if (retryingRef.current.has(run.id)) return;
      retryingRef.current.add(run.id);
      const tempId = newTempRunId();
      dispatch({ type: "retryQueued", tempId, from: run });
      try {
        const body = await apiFetch<{ run: RunsApiRow }>(
          `/api/runs/${encodeURIComponent(run.id)}/retry`,
          { method: "POST" },
        );
        dispatch({ type: "retryResolved", tempId, run: body.run });
      } catch (cause: unknown) {
        dispatch({ type: "retryFailed", tempId });
        toast(
          {
            title: "Retry failed",
            description: cause instanceof ApiError ? cause.message : "Unknown error",
            variant: "danger",
          },
          0,
        );
      } finally {
        retryingRef.current.delete(run.id);
      }
    },
    [toast],
  );

  const visible = useMemo(() => filterRuns(rows, filters), [rows, filters]);
  const hasAnyRun = loadState.phase === "ready" && rows.length > 0;

  return (
    <Card data-testid="runs-table">
      <CardHeader>
        <div>
          <CardTitle>Runs</CardTitle>
          <CardDescription>
            Every run on the daemon, newest first — updated live as statuses change.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {/* #114: compare entry point — appears once a row is ticked and
              navigates at exactly two selected runs. */}
          {compareSelection.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={!compareSelectionComplete(compareSelection)}
              title={
                compareSelectionComplete(compareSelection)
                  ? "Open the side-by-side comparison"
                  : "Select exactly two runs to compare"
              }
              data-testid="compare-runs-button"
              onClick={() => {
                const [a, b] = compareSelection;
                if (a === undefined || b === undefined) return;
                router.push(compareHref(a, b));
              }}
            >
              Compare ({compareSelection.length})
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => void loadRuns()}>
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label="Filter by status"
          >
            {RUNS_FILTER_STATUSES.map((status) => {
              const active = filters.statuses.includes(status);
              return (
                <button
                  key={status}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleStatus(status)}
                  className={
                    "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
                    (active
                      ? "border-accent bg-accent text-accent-fg"
                      : "border-border text-muted-fg hover:bg-elevated hover:text-fg")
                  }
                >
                  {status}
                </button>
              );
            })}
            {filters.statuses.length > 0 ? (
              <button
                type="button"
                onClick={() => setFilters({ statuses: [] })}
                className="rounded-full px-2 py-0.5 text-xs text-muted-fg transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Clear
              </button>
            ) : null}
          </div>
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-fg">
            <span>Project</span>
            <select
              value={filters.projectId ?? ""}
              onChange={(event) =>
                setFilters({
                  projectId: event.target.value === "" ? undefined : event.target.value,
                })
              }
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <option value="">All</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {loadState.phase === "loading" ? (
          <SkeletonLines rows={6} />
        ) : loadState.phase === "error" ? (
          <div className="flex flex-col items-start gap-3 py-2 text-sm">
            <p className="text-danger">{loadState.message}</p>
            <Button variant="secondary" size="sm" onClick={() => void loadRuns()}>
              Retry
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<PlayIcon className="size-5" />}
            title={hasAnyRun ? "No runs match these filters" : "No runs yet"}
            description={
              hasAnyRun
                ? "Loosen the status or project filters to see more runs."
                : "Start a workflow or an ad-hoc task from one of your projects."
            }
            action={
              hasAnyRun ? (
                <button
                  type="button"
                  onClick={() => setFilters({ statuses: [], projectId: undefined })}
                  className="text-sm font-medium text-link transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Clear filters
                </button>
              ) : (
                <Link
                  href="/projects"
                  className="text-sm font-medium text-link transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Pick a project →
                </Link>
              )
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <span className="sr-only">Select to compare</span>
                </TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Workflow</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead className="w-20 text-right">Iters</TableHead>
                <TableHead className="w-24 text-right">Duration</TableHead>
                <TableHead className="w-24 text-right">Age</TableHead>
                <TableHead className="w-44 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((run) => {
                const action = rowActionFor(run.status);
                return (
                  <TableRow key={run.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="size-4 cursor-pointer rounded border-border accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        checked={compareSelection.includes(run.id)}
                        aria-label={`Compare ${run.branch}`}
                        data-compare-check={run.id}
                        onChange={() => toggleCompare(run.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/projects/${encodeURIComponent(run.projectId)}`}
                        className="rounded-sm text-sm text-fg transition-colors hover:text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        {run.project?.name ?? run.projectId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/runs/${encodeURIComponent(run.id)}`}
                        className="block max-w-56 truncate rounded-sm text-sm text-fg transition-colors hover:text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        title={run.workflow?.name ?? run.task ?? run.branch}
                      >
                        {run.workflow !== undefined
                          ? `${run.workflow.name}${run.workflowRevision !== undefined ? ` · r${run.workflowRevision.number}` : ""}`
                          : (run.task ?? "ad-hoc")}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/runs/${encodeURIComponent(run.id)}`}
                        className="inline-flex items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <StatusBadge status={run.status}>
                          {run.status === "queued" && run.queuePosition !== undefined
                            ? `Queued · #${run.queuePosition}`
                            : undefined}
                        </StatusBadge>
                        {/* #110: hosted past success — the sandbox (and its
                            previews) is still alive on a TTL. */}
                        {isRunHosted(run) ? (
                          <span
                            className="rounded-full border border-success/50 bg-success-subtle px-2 py-0.5 text-xs font-medium text-success"
                            title="Sandbox kept alive for previews (hosting)"
                            data-hosted-badge
                          >
                            hosted
                          </span>
                        ) : null}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-fg">
                      {iterationCount(run)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-fg">
                      {isLiveStatus(run.status) ? (
                        <span title="Still running">…</span>
                      ) : (
                        formatDuration(runDuration(run, now))
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-fg">
                      {formatRelativeAge(run.createdAt, now)}
                    </TableCell>
                    <TableCell className="text-right">
                      {action === "stop" ? (
                        <StopCell
                          state={stop?.runId === run.id ? stop.state : "idle"}
                          onArm={() =>
                            setStop({ runId: run.id, state: nextStopConfirmState("idle", "click") })
                          }
                          onConfirm={() => void confirmStop(run)}
                          onCancel={() => setStop({ runId: run.id, state: "idle" })}
                        />
                      ) : action === "retry" ? (
                        <Button variant="ghost" size="sm" onClick={() => void retry(run)}>
                          Retry
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {loadState.phase === "ready" && nextCursor !== undefined ? (
          <Button
            variant="secondary"
            size="sm"
            className="mt-4"
            loading={loadingMore}
            onClick={() => void loadMore()}
          >
            Load more
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
