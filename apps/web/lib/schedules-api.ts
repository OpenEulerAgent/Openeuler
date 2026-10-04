import type { WorkflowSchedule, WorkflowScheduleConfig } from "@openeuler/core";
import { ApiError, apiFetch } from "./api";

/**
 * Workflow schedule API client (#121). The schedule is a plain config
 * object — no secrets anywhere (unlike webhooks) — so every response is
 * freely re-fetchable; the daemon's ticker does the firing.
 */

/** Injectable transport so flows are testable without a browser. */
export type ScheduleFetcher = typeof apiFetch;

/** True when the daemon answered 404 SCHEDULE_NOT_FOUND (no schedule yet). */
export function isScheduleMissing(err: unknown): boolean {
  return err instanceof ApiError && err.code === "SCHEDULE_NOT_FOUND";
}

/** Loads the workflow's schedule; null when none exists. */
export async function fetchWorkflowSchedule(
  workflowId: string,
  fetcher: ScheduleFetcher = apiFetch,
): Promise<WorkflowSchedule | null> {
  try {
    const body = await fetcher<{ schedule: WorkflowSchedule }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/schedule`,
    );
    return body.schedule;
  } catch (cause) {
    if (isScheduleMissing(cause)) return null;
    throw cause;
  }
}

/**
 * Saves (creates or replaces) the workflow's schedule — the daemon upserts
 * by workflow, so exactly one schedule row can exist.
 */
export async function putWorkflowSchedule(options: {
  workflowId: string;
  config: WorkflowScheduleConfig;
  fetcher?: ScheduleFetcher;
}): Promise<WorkflowSchedule> {
  const { workflowId, config, fetcher = apiFetch } = options;
  const body = await fetcher<{ schedule: WorkflowSchedule }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/schedule`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    },
  );
  return body.schedule;
}

export async function deleteWorkflowSchedule(
  workflowId: string,
  fetcher: ScheduleFetcher = apiFetch,
): Promise<void> {
  await fetcher(`/api/workflows/${encodeURIComponent(workflowId)}/schedule`, {
    method: "DELETE",
  });
}

/** The browser's own IANA zone — the drawer's timezone default. */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
