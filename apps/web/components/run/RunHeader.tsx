import type { Run } from "@openeuler/core";
import type { ReactNode } from "react";
import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { Card } from "@/components/ui/card";
import { formatElapsed, isLiveRun } from "@/lib/run-feed";
import { StopRunButton } from "./StopRunButton";

/**
 * Run header (#52): project, branch, status badge, total node executions,
 * elapsed time (ticking while live — parent supplies a fresh `nowMs`) and
 * the action row (Stop while live, Retry on failed/aborted/interrupted —
 * passed in via `extraActions`). `endedMs` overrides the terminal timestamp
 * when the stream observed the end before the run row was refetched.
 */
export function RunHeader({
  run,
  projectName,
  nowMs,
  endedMs,
  executions,
  extraActions,
  onAborted,
}: {
  run: Run;
  projectName: string | null;
  nowMs: number;
  endedMs?: number | null;
  /** Total node executions announced so far (graph fold); null = none. */
  executions?: number | null;
  /** Extra action controls (Retry button). */
  extraActions?: ReactNode;
  onAborted: () => void;
}) {
  const live = isLiveRun(run.status);
  const startedMs = Date.parse(run.createdAt);
  const endMs = live ? nowMs : (endedMs ?? Date.parse(run.updatedAt));
  const elapsed =
    Number.isNaN(startedMs) || Number.isNaN(endMs) ? "—" : formatElapsed(startedMs, endMs);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-fg">
            <Link
              href="/runs"
              className="transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Runs
            </Link>
            <span aria-hidden className="mx-1">
              /
            </span>
            {projectName ?? "…"}
          </p>
          <h1 className="mt-1 truncate font-mono text-title font-semibold text-fg">{run.branch}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={run.status} />
          {executions !== null && executions !== undefined && executions > 0 ? (
            <span className="text-sm text-muted-fg" title="Total node executions">
              <span className="font-medium text-fg">{executions}</span> execution
              {executions === 1 ? "" : "s"}
            </span>
          ) : null}
          <span className="text-sm text-muted-fg" title="Elapsed time">
            <span className="font-medium text-fg">{elapsed}</span>
            {live ? " (running)" : ""}
          </span>
          {extraActions}
          {live ? <StopRunButton runId={run.id} onAborted={onAborted} /> : null}
        </div>
      </div>
      {run.task ? (
        <p className="mt-3 border-t border-border pt-3 text-sm text-muted-fg">{run.task}</p>
      ) : null}
    </Card>
  );
}
