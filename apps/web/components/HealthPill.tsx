"use client";

import { formatUptime, useHealth, type HealthState } from "@/lib/health";

export function HealthPill() {
  const health = useHealth();
  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium ${pillClassName(health)}`}
    >
      <span aria-hidden className={`size-2 rounded-full ${dotClassName(health)}`} />
      {pillLabel(health)}
    </span>
  );
}

function pillClassName(health: HealthState): string {
  switch (health.status) {
    case "healthy":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "degraded":
      return "border-red-200 bg-red-50 text-red-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-600";
  }
}

function dotClassName(health: HealthState): string {
  switch (health.status) {
    case "healthy":
      return "bg-emerald-500";
    case "degraded":
      return "bg-red-500";
    default:
      return "animate-pulse bg-slate-400";
  }
}

function pillLabel(health: HealthState): string {
  switch (health.status) {
    case "healthy":
      return `Daemon healthy · v${health.version} · up ${formatUptime(health.uptime)}`;
    case "degraded":
      return "Daemon unreachable";
    default:
      return "Checking daemon…";
  }
}
