import type { Run } from "@openeuler/core";
import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { formatElapsed, isLiveRun } from "@/lib/run-feed";
import { StopRunButton } from "./StopRunButton";

/**
 * Run header: project name, branch, status badge, elapsed time (ticking while
 * live — parent supplies a fresh `nowMs`) and the stop control. `endedMs`
 * overrides the terminal timestamp when the stream observed the end before
 * the run row was refetched.
 */
export function RunHeader({
  run,
  projectName,
  nowMs,
  endedMs,
  onAborted,
}: {
  run: Run;
  projectName: string | null;
  nowMs: number;
  endedMs?: number | null;
  onAborted: () => void;
}) {
  const live = isLiveRun(run.status);
  const startedMs = Date.parse(run.createdAt);
  const endMs = live ? nowMs : (endedMs ?? Date.parse(run.updatedAt));
  const elapsed =
    Number.isNaN(startedMs) || Number.isNaN(endMs) ? "—" : formatElapsed(startedMs, endMs);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            <Link href="/runs" className="hover:text-slate-600">
              Runs
            </Link>
            <span aria-hidden className="mx-1">
              /
            </span>
            {projectName ?? "…"}
          </p>
          <h1 className="mt-1 truncate font-mono text-lg font-semibold text-slate-900">
            {run.branch}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={run.status} />
          <span className="text-sm text-slate-500" title="Elapsed time">
            <span className="font-medium text-slate-700">{elapsed}</span>
            {live ? " (running)" : ""}
          </span>
          {live ? <StopRunButton runId={run.id} onAborted={onAborted} /> : null}
        </div>
      </div>
      {run.task ? (
        <p className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600">{run.task}</p>
      ) : null}
    </section>
  );
}
