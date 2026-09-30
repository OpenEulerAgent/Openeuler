"use client";

import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { useRunStats } from "@/lib/runs-stats";

/**
 * Live "Active runs" content for the dashboard: polls `GET /api/runs/stats`
 * (alongside the health polling cadence) and shows queued/running counts.
 */
export function ActiveRunsCard() {
  const state = useRunStats();

  if (state.status === "loading") {
    return <p className="py-6 text-sm text-slate-400">Loading run stats…</p>;
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3 py-6 text-sm">
        <p className="text-red-600">{state.message}</p>
        <p className="text-xs text-slate-400">
          Run counts will appear once the daemon is reachable.
        </p>
      </div>
    );
  }

  const { queued, running } = state.stats;
  if (queued === 0 && running === 0) {
    return (
      <div className="flex flex-col items-start gap-3 py-6 text-sm text-slate-500">
        <p>No active runs.</p>
        <p className="text-xs">Runs appear here once you start a workflow.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex items-center gap-2">
        <StatusBadge status="running">Running · {running}</StatusBadge>
        <StatusBadge status="queued">Queued · {queued}</StatusBadge>
      </div>
      <Link href="/runs" className="text-sm font-medium text-slate-600 hover:text-slate-900">
        View runs →
      </Link>
    </div>
  );
}
