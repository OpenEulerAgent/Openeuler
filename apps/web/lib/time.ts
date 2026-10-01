/** Duration/age formatting for the dashboard runs table (#51). */

/**
 * Compact duration: `450ms`, `12s`, `3m 20s`, `1h 04m`, `2d 3h`. Values are
 * clamped at zero (clock skew must not render negative durations).
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  if (total < 1_000) return `${total}ms`;
  const seconds = Math.floor(total / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${String(rest).padStart(2, "0")}m`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Relative age: `just now`, `4m ago`, `3h ago`, `2d ago`, then a date. */
export function formatRelativeAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const delta = Math.max(0, now - then);
  const seconds = Math.floor(delta / 1_000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/**
 * A run's wall-clock span: createdAt → updatedAt for terminal rows (both
 * timestamps are stable), createdAt → now for live rows.
 */
export function runDuration(
  run: { createdAt: string; updatedAt: string; status: string },
  now: number = Date.now(),
): number {
  const end = isLiveStatus(run.status) ? now : Date.parse(run.updatedAt);
  return end - Date.parse(run.createdAt);
}

export function isLiveStatus(status: string): boolean {
  return status === "queued" || status === "running";
}
