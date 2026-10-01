"use client";

import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonLines } from "@/components/ui/skeleton";
import { PlayIcon } from "@/components/shell/icons";
import { useRunStats } from "@/lib/runs-stats";

/**
 * Live "Active runs" content for the dashboard: polls `GET /api/runs/stats`
 * (alongside the health polling cadence) and shows queued/running counts.
 */
export function ActiveRunsCard() {
  const state = useRunStats();

  if (state.status === "loading") {
    return <SkeletonLines rows={2} />;
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3 py-2 text-sm">
        <p className="text-danger">{state.message}</p>
        <p className="text-xs text-muted-fg">
          Run counts will appear once the daemon is reachable.
        </p>
      </div>
    );
  }

  const { queued, running } = state.stats;
  if (queued === 0 && running === 0) {
    return (
      <EmptyState
        icon={<PlayIcon className="size-5" />}
        title="No active runs"
        description="Runs appear here once you start a workflow or an ad-hoc task."
        action={
          <Link
            href="/runs"
            className="text-sm font-medium text-link transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            View runs →
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="flex items-center gap-2">
        <StatusBadge status="running">Running · {running}</StatusBadge>
        <StatusBadge status="queued">Queued · {queued}</StatusBadge>
      </div>
      <Link
        href="/runs"
        className="text-sm font-medium text-link transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        View runs →
      </Link>
    </div>
  );
}
