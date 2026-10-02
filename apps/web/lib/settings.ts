import { apiFetch } from "./api";

/**
 * Client view of `GET /api/system/settings` (#95): the settings hub's
 * read-only daemon facts, plus the maintenance API client and pure display
 * helpers (byte/uptime formatting, toast copy).
 */

export interface SystemSettings {
  version: string;
  dbPath: string | null;
  dbBytes: number | null;
  worktreeRoot: string;
  worktreeBytes: number | null;
  drivers: Array<{ id: string }>;
  defaultDriver: string | null;
  maxConcurrentRuns: number;
  authEnabled: boolean;
  uptimeSeconds: number;
}

export type MaintenanceAction = "prune-worktrees" | "purge-events" | "vacuum";

/** `POST /api/system/maintenance` outcomes, keyed by `action`. */
export interface PruneWorktreesResult {
  action: "prune-worktrees";
  removed: number;
  remaining: number;
}

export interface PurgeEventsResult {
  action: "purge-events";
  deleted: number;
  dbBytes: number | null;
}

export interface VacuumResult {
  action: "vacuum";
  dbBytes: number | null;
}

export type MaintenanceResult = PruneWorktreesResult | PurgeEventsResult | VacuumResult;

export type SettingsFetcher = typeof apiFetch;

/** Default event-log age cutoff (days) offered by the purge dialog. */
export const DEFAULT_PURGE_DAYS = 30;

/** Word the purge dialog requires the user to type before confirming. */
export const PURGE_CONFIRM_WORD = "purge";

/** Fetches the settings hub payload; `refresh` bypasses the daemon's du cache. */
export async function fetchSystemSettings(
  fetcher: SettingsFetcher = apiFetch,
  options: { refresh?: boolean } = {},
): Promise<SystemSettings> {
  const query = options.refresh ? "?refresh=1" : "";
  return fetcher<SystemSettings>(`/api/system/settings${query}`);
}

/** Runs one danger-zone maintenance action; `days` parameterizes purge-events. */
export async function runMaintenance(
  action: MaintenanceAction,
  options: { days?: number } = {},
  fetcher: SettingsFetcher = apiFetch,
): Promise<MaintenanceResult> {
  return fetcher<MaintenanceResult>("/api/system/maintenance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      ...(action === "purge-events" && options.days !== undefined ? { days: options.days } : {}),
    }),
  });
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human byte size ("812 B", "1.5 KB", "2.0 MB"); "—" for null/unknown. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(1);
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/** Human uptime ("42s", "3m 12s", "2h 05m", "5d 3h"). */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

/** Share of `max` clamped to [0, 100], for the storage usage bars. */
export function usagePercent(value: number | null | undefined, max: number): number {
  if (value === null || value === undefined || !Number.isFinite(value) || max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / max) * 100)));
}

/** Toast copy for one maintenance outcome (title + optional description). */
export function maintenanceToast(result: MaintenanceResult): {
  title: string;
  description?: string;
} {
  switch (result.action) {
    case "prune-worktrees":
      return {
        title: "Worktrees pruned",
        description:
          result.remaining > 0
            ? `${result.removed} removed · ${result.remaining} could not be removed`
            : `${result.removed} orphaned ${result.removed === 1 ? "directory" : "directories"} removed`,
      };
    case "purge-events":
      return {
        title: "Event log purged",
        description: `${result.deleted} ${result.deleted === 1 ? "event" : "events"} deleted${
          result.dbBytes === null ? "" : ` · database now ${formatBytes(result.dbBytes)}`
        }`,
      };
    case "vacuum":
      return {
        title: "Database vacuumed",
        description:
          result.dbBytes === null ? undefined : `Database is now ${formatBytes(result.dbBytes)}`,
      };
  }
}
