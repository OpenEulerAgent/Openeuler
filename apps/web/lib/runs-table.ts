import type { RunStatus } from "@openeuler/core";
import { applyRunStatusEvent, type RunStatusStreamEvent, type RunsApiRow } from "./runs-stream";

/**
 * Dashboard runs table logic (#51): URL-state filter codec + the pure table
 * reducer covering live stream patches and optimistic Stop/Retry updates.
 * The component is a thin shell over these.
 */

export const RUNS_FILTER_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "success",
  "failed",
  "aborted",
  "interrupted",
];

export interface RunsFilters {
  /** Empty = all statuses. Order follows {@link RUNS_FILTER_STATUSES}. */
  statuses: RunStatus[];
  projectId?: string;
}

const normalizeStatuses = (statuses: readonly string[]): RunStatus[] =>
  RUNS_FILTER_STATUSES.filter((status) => statuses.includes(status));

/**
 * Serializes filters to a query string (`status=a,b&projectId=x`). Only
 * non-default state is emitted, so the all-filters-cleared dashboard keeps
 * its canonical `/` URL.
 */
export function encodeRunsFilters(filters: RunsFilters): string {
  const params = new URLSearchParams();
  const statuses = normalizeStatuses(filters.statuses);
  if (statuses.length > 0) params.set("status", statuses.join(","));
  if (filters.projectId !== undefined && filters.projectId !== "") {
    params.set("projectId", filters.projectId);
  }
  return params.toString();
}

/** Parses filters back from a query string / URLSearchParams; invalid values drop. */
export function decodeRunsFilters(input: URLSearchParams | string): RunsFilters {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  const rawStatus = params.get("status");
  const statuses = rawStatus === null ? [] : normalizeStatuses(rawStatus.split(","));
  const rawProject = params.get("projectId");
  return {
    statuses,
    projectId: rawProject === null || rawProject === "" ? undefined : rawProject,
  };
}

/** Round-trips filters through a URL query string (what reload preserves). */
export function filtersToSearch(filters: RunsFilters): string {
  const query = encodeRunsFilters(filters);
  return query === "" ? "" : `?${query}`;
}

/** Client-side re-application of the filters over loaded rows. */
export function filterRuns(rows: readonly RunsApiRow[], filters: RunsFilters): RunsApiRow[] {
  const statuses = normalizeStatuses(filters.statuses);
  return rows.filter(
    (row) =>
      (statuses.length === 0 || statuses.includes(row.status)) &&
      (filters.projectId === undefined || row.projectId === filters.projectId),
  );
}

// ---------------------------------------------------------------------------
// Table reducer: live stream patches + optimistic inline actions.

export type RunsTableAction =
  | { type: "rowsLoaded"; rows: RunsApiRow[] }
  /** Load-more page appended (older rows); ids already present are skipped. */
  | { type: "rowsAppended"; rows: RunsApiRow[] }
  | { type: "streamEvent"; event: RunStatusStreamEvent }
  /** Stop clicked + confirmed: row flips to `aborted` before the POST resolves. */
  | { type: "stopOptimistic"; runId: string }
  /** Stop failed on a non-409: row reverts to its previous status. */
  | { type: "stopFailed"; runId: string; previous: RunStatus }
  /** Retry dispatched: a temporary queued row stands in until the API answers. */
  | { type: "retryQueued"; tempId: string; from: RunsApiRow }
  /** Retry answered: the temporary row is replaced by the real one. */
  | { type: "retryResolved"; tempId: string; run: RunsApiRow }
  /** Retry failed: the temporary row disappears again. */
  | { type: "retryFailed"; tempId: string };

/** Ids minted for optimistic retry rows (`crypto.randomUUID` when available). */
export function newTempRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function optimisticRetryRow(tempId: string, from: RunsApiRow): RunsApiRow {
  const next: RunsApiRow = {
    ...from,
    id: tempId,
    status: "queued",
    iteration: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  delete next.queuePosition;
  return next;
}

/**
 * Pure reducer over the table rows. New/unknown-id stream events are ignored
 * here — the component schedules a refetch for those (row detail like the
 * workflow name is not in the event payload).
 */
export function runsTableReducer(
  rows: readonly RunsApiRow[],
  action: RunsTableAction,
): RunsApiRow[] {
  switch (action.type) {
    case "rowsLoaded":
      return action.rows;
    case "rowsAppended": {
      const seen = new Set(rows.map((row) => row.id));
      return [...rows, ...action.rows.filter((row) => !seen.has(row.id))];
    }
    case "streamEvent":
      // Delegates to the shared stream→row reducer (#62): unknown ids and
      // no-op transitions return the SAME array — no re-render churn.
      return applyRunStatusEvent(rows, action.event);
    case "stopOptimistic":
      return rows.map((row) => (row.id === action.runId ? { ...row, status: "aborted" } : row));
    case "stopFailed":
      return rows.map((row) =>
        row.id === action.runId ? { ...row, status: action.previous } : row,
      );
    case "retryQueued":
      return [optimisticRetryRow(action.tempId, action.from), ...rows];
    case "retryResolved": {
      // Replace-or-prepend: a refetch may have already added the real row
      // while the retry POST was in flight — replace it in place instead of
      // stacking a duplicate id (and its duplicate React key).
      const exists = rows.some((row) => row.id === action.run.id);
      if (exists) {
        return rows
          .map((row) => (row.id === action.run.id ? action.run : row))
          .filter((row) => row.id !== action.tempId);
      }
      return [action.run, ...rows.filter((row) => row.id !== action.tempId)];
    }
    case "retryFailed":
      return rows.filter((row) => row.id !== action.tempId);
  }
}

// ---------------------------------------------------------------------------
// Stop arm-confirm state machine (inline, StopRunButton pattern).

export type StopConfirmState = "idle" | "armed" | "stopping";

/**
 * First click arms the confirm, second confirms; Escape/cancel disarms;
 * `done` returns to idle whether the abort landed or the row reverted.
 */
export function nextStopConfirmState(
  state: StopConfirmState,
  event: "click" | "confirm" | "cancel" | "escape" | "done",
): StopConfirmState {
  switch (event) {
    case "click":
      return state === "idle" ? "armed" : state;
    case "confirm":
      return state === "armed" ? "stopping" : state;
    case "cancel":
    case "escape":
      return state === "stopping" ? state : "idle";
    case "done":
      return "idle";
  }
}

/** Which inline action a row offers, by status. */
export function rowActionFor(status: RunStatus): "stop" | "retry" | null {
  if (status === "queued" || status === "running") return "stop";
  if (
    status === "success" ||
    status === "failed" ||
    status === "aborted" ||
    status === "interrupted"
  ) {
    return "retry";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Compare selection (#114): per-row checkboxes → Compare at exactly two.

/**
 * Toggles one run id in the compare selection, keeping click order (the
 * first ticked row becomes side A, the second side B). No cap — a third
 * pick is allowed and simply disables the button until one is unticked.
 */
export function toggleCompareSelection(selected: readonly string[], runId: string): string[] {
  return selected.includes(runId) ? selected.filter((id) => id !== runId) : [...selected, runId];
}

/** The Compare button navigates only at exactly two selected runs. */
export function compareSelectionComplete(selected: readonly string[]): boolean {
  return selected.length === 2;
}
