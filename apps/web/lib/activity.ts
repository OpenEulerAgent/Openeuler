import { apiFetch, ApiError } from "./api";

/**
 * Activity feed client (#51): types + fetch for `GET /api/activity`.
 * Cursor-paginated by the last item's id, newest first.
 */

export type ActivityType =
  | "project.created"
  | "workflow.created"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.aborted"
  | "run.interrupted"
  | "ops.daemon-boot"
  | "ops.recovery-sweep"
  | "ops.gc"
  | "ops.image-pull"
  | "ops.image-build"
  | "ops.sandbox-kept"
  | "ops.hosting-expired"
  | "ops.schedule-skipped";
/**
 * ops.* rows (#94) are daemon-level system lines (boot, recovery sweep,
 * GC): rendered as small gray text without badge or run link.
 */
export function isOpsActivityType(type: ActivityType): boolean {
  return type.startsWith("ops.");
}

export interface ActivityItem {
  id: number;
  type: ActivityType;
  createdAt: string;
  project?: { id: string; name: string };
  run?: { id: string; status: string; branch: string };
  workflow?: { id: string; name: string };
  message: string;
}

export interface ActivityFeedPage {
  items: ActivityItem[];
  nextCursor?: number;
}

export const ACTIVITY_PAGE_SIZE = 20;

export async function fetchActivityFeed(
  cursor?: number,
  limit: number = ACTIVITY_PAGE_SIZE,
): Promise<ActivityFeedPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) params.set("cursor", String(cursor));
  return apiFetch<ActivityFeedPage>(`/api/activity?${params.toString()}`);
}

/** Whether the item links to a run detail page. */
export function activityRunHref(item: ActivityItem): string | null {
  return item.run === undefined ? null : `/runs/${encodeURIComponent(item.run.id)}`;
}

/** Collapses a feed error into a message (daemon down vs API error). */
export function activityErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Failed to load activity";
}
