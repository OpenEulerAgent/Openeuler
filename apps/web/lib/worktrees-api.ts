import type { RunStatus } from "@openeuler/core";
import { apiFetch } from "./api";

/**
 * Per-project worktree manager API client (#111): the listing behind the
 * ProjectSettingsDrawer's Worktrees section plus the prune actions.
 */

/** Lifecycle status of one worktree, derived by the daemon from its run row. */
export type WorktreeStatus = "active" | "inspectable" | "orphan";

/** One `GET /api/projects/:id/worktrees` row (#111). */
export interface WorktreeEntry {
  runId: string;
  branch: string;
  path: string;
  /** `du -sB1` of the store directory (60s-cached daemon-side); null when unknown. */
  diskUsageBytes: number | null;
  /** Run `updatedAt` when a run row exists, else the metadata `createdAt`. */
  lastActivity: string | null;
  status: WorktreeStatus;
  /** Present when a run row exists (drives the Inspect link). */
  runStatus?: RunStatus;
}

/** `GET /api/projects/:id/worktrees` payload (#111). */
export interface ProjectWorktrees {
  worktrees: WorktreeEntry[];
  totalBytes: number | null;
}

/** One removed entry of `POST …/worktrees/prune` (#111). */
export interface WorktreePruneRemoved {
  runId: string;
  path: string;
  warnings?: string[];
}

export interface WorktreePruneResult {
  removed: WorktreePruneRemoved[];
  kept: number;
}

/** Injectable transport so flows are testable without a browser. */
export type WorktreesFetcher = typeof apiFetch;

export async function fetchProjectWorktrees(
  projectId: string,
  fetcher: WorktreesFetcher = apiFetch,
  options: { refresh?: boolean } = {},
): Promise<ProjectWorktrees> {
  const query = options.refresh ? "?refresh=1" : "";
  return fetcher<ProjectWorktrees>(
    `/api/projects/${encodeURIComponent(projectId)}/worktrees${query}`,
  );
}

/** Prunes one non-active worktree (`{runId}`) or every orphan (`{orphans}`). */
export async function pruneProjectWorktrees(
  projectId: string,
  body: { runId: string } | { orphans: true },
  fetcher: WorktreesFetcher = apiFetch,
): Promise<WorktreePruneResult> {
  return fetcher<WorktreePruneResult>(
    `/api/projects/${encodeURIComponent(projectId)}/worktrees/prune`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/** Status → badge copy; the variant mapping lives with the section render. */
export const WORKTREE_STATUS_LABEL: Record<WorktreeStatus, string> = {
  active: "Active",
  inspectable: "Inspectable",
  orphan: "Orphan",
};
