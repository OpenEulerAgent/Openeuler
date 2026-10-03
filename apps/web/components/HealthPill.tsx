"use client";

import { formatUptime, useHealth, type HealthState } from "@/lib/health";
import { cn } from "@/lib/cn";

/** Daemon health pill for the top bar (issue #50). */
export function HealthPill() {
  const health = useHealth();
  return (
    <span
      role="status"
      aria-live="polite"
      title={health.status === "degraded" ? health.message : undefined}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium",
        pillClassName(health),
      )}
    >
      <span aria-hidden className={cn("size-2 rounded-full", dotClassName(health))} />
      {pillLabel(health)}
    </span>
  );
}

function pillClassName(health: HealthState): string {
  switch (health.status) {
    case "healthy":
      return "border-success/40 bg-success-subtle text-success";
    case "degraded":
      return "border-danger/40 bg-danger-subtle text-danger";
    default:
      return "border-border bg-elevated text-muted-fg";
  }
}

function dotClassName(health: HealthState): string {
  switch (health.status) {
    case "healthy":
      return "bg-success";
    case "degraded":
      return "bg-danger";
    default:
      return "animate-pulse bg-muted-fg";
  }
}

function pillLabel(health: HealthState): string {
  if (health.status === "healthy") {
    // Uptime is absent when the daemon runs with auth enabled (minimal
    // `/health`, #92) — version only then.
    return health.uptime === undefined
      ? `Daemon v${health.version}`
      : `Daemon v${health.version} · up ${formatUptime(health.uptime)}`;
  }
  if (health.status === "degraded") return "Daemon unreachable";
  return "Checking daemon…";
}
