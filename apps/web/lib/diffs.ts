import type { StepRun } from "@openeuler/core";
import { apiFetch } from "./api";

/**
 * Client for `GET /api/runs/:id/diff` (issue #20). Scope selection state is
 * modeled as pure data + reducers here so the Diffs tab stays presentational
 * and the switching logic is unit-testable without a DOM.
 */

/** Mirrors the daemon's `RunDiffBody`. */
export interface RunDiffResponse {
  scope: "step" | "cumulative";
  stat: string;
  patch: string;
  truncated: boolean;
  totalLines: number;
  maxLines: number;
  stepRunId?: string;
}

/** Which diff the tab is showing. */
export type DiffScope = { kind: "cumulative" } | { kind: "step"; stepRunId: string };

export function scopeToQuery(scope: DiffScope): string {
  return scope.kind === "cumulative"
    ? "scope=cumulative"
    : `scope=step&stepRunId=${encodeURIComponent(scope.stepRunId)}`;
}

/** Fetches a run diff; `fetcher` injectable for tests (defaults to apiFetch). */
export async function fetchRunDiff(
  runId: string,
  scope: DiffScope,
  fetcher: (path: string) => Promise<RunDiffResponse> = (path) => apiFetch<RunDiffResponse>(path),
): Promise<RunDiffResponse> {
  return fetcher(`/api/runs/${encodeURIComponent(runId)}/diff?${scopeToQuery(scope)}`);
}

/** Sidebar dropdown option for one step run. */
export interface StepScopeOption {
  stepRunId: string;
  /** Label showing step id + 1-based iteration, e.g. `implement (#2)`. */
  label: string;
  /** True when the step stored a diff at all (failed captures stay selectable but dimmed). */
  hasDiff: boolean;
}

/** Dropdown options in run order, labeled with their iteration. */
export function stepScopeOptions(steps: readonly StepRun[]): StepScopeOption[] {
  return steps.map((step) => ({
    stepRunId: step.id,
    label: `${step.stepId} (iter ${step.iteration})`,
    hasDiff: (step.diff ?? "").length > 0,
  }));
}

/** State machine for the scope switch + load, as a pure reducer. */
export type DiffLoadState =
  | { phase: "idle" }
  | { phase: "loading"; scope: DiffScope }
  | { phase: "ready"; scope: DiffScope; diff: RunDiffResponse }
  | { phase: "gone"; scope: DiffScope } // 410: cumulative worktree no longer exists
  | { phase: "error"; scope: DiffScope; message: string };

export type DiffLoadAction =
  | { type: "select"; scope: DiffScope }
  | { type: "loading"; scope: DiffScope }
  | {
      type: "loaded";
      scope: DiffScope;
      diff: RunDiffResponse;
    }
  | { type: "gone"; scope: DiffScope }
  | { type: "failed"; scope: DiffScope; status: number; message: string };

export function diffLoadReducer(state: DiffLoadState, action: DiffLoadAction): DiffLoadState {
  // Stale responses (a newer selection already landed) are dropped.
  const isCurrent = "scope" in action && sameScope(action.scope, state);
  switch (action.type) {
    case "select":
      return { phase: "loading", scope: action.scope };
    case "loading":
      return sameScope(action.scope, state) ? { phase: "loading", scope: action.scope } : state;
    case "loaded":
      return isCurrent ? { phase: "ready", scope: action.scope, diff: action.diff } : state;
    case "gone":
      return isCurrent ? { phase: "gone", scope: action.scope } : state;
    case "failed":
      return isCurrent ? { phase: "error", scope: action.scope, message: action.message } : state;
  }
}

function sameScope(scope: DiffScope, state: DiffLoadState): boolean {
  const stateScope: DiffScope | undefined =
    state.phase === "idle" ? undefined : (state as { scope: DiffScope }).scope;
  if (stateScope === undefined) return true;
  if (stateScope.kind !== scope.kind) return false;
  if (stateScope.kind === "step" && scope.kind === "step") {
    return stateScope.stepRunId === scope.stepRunId;
  }
  return true;
}
