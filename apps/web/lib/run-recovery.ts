import type { StepRun } from "@openeuler/core";

/**
 * Resume is possible when every started step recorded a sessionId (agent
 * context preserved). A run interrupted before any step started (no rows)
 * is trivially resumable — it simply executes from the beginning.
 */
export function resumePossible(steps: readonly StepRun[]): boolean {
  return steps.every((step) => step.sessionId !== undefined);
}

/** POST endpoint that resumes an interrupted run in place. */
export function resumeEndpoint(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/resume`;
}

/** POST endpoint that retries a finished run as a new, independent run. */
export function retryEndpoint(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/retry`;
}

/** Where the UI navigates after a retry: the new run's detail page. */
export function nextRunHref(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}
