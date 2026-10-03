"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonLines } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, ApiError } from "@/lib/api";
import { parsePatch } from "@/lib/diff-parse";
import { fetchRunDiff, type RunDiffResponse } from "@/lib/diffs";
import {
  alignRunSteps,
  clipToLines,
  eventSpark,
  filesOnlyIn,
  runCompareStats,
  type CompareRunDetail,
  type CompareStepRow,
  type CompareStepRun,
  type RunCompareStats,
} from "@/lib/run-compare";
import { formatDuration } from "@/lib/time";

/**
 * Run compare (#114): two runs side by side at `/runs/compare?a=&b=` —
 * header stat cards (status, duration, executions/iterations, ports,
 * workflow revision, sandbox mode), the aligned node-by-node execution
 * table (union of both runs' StepRuns keyed by node + iteration), both
 * cumulative patches with files-only-in-A/B chips, and event-count
 * sparkbars. Answers "what changed between attempts".
 */

type SideState =
  | { phase: "loading" }
  | { phase: "ready"; detail: CompareRunDetail }
  | { phase: "notfound" }
  | { phase: "error"; message: string };

type DiffState =
  | { phase: "loading" }
  | { phase: "ready"; diff: RunDiffResponse }
  | { phase: "missing"; message: string };

async function fetchRunDetail(runId: string): Promise<SideState> {
  try {
    const detail = await apiFetch<CompareRunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
    return { phase: "ready", detail };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return { phase: "notfound" };
    return {
      phase: "error",
      message: cause instanceof ApiError ? cause.message : "Failed to load run",
    };
  }
}

async function fetchCumulativeDiff(runId: string): Promise<DiffState> {
  try {
    return { phase: "ready", diff: await fetchRunDiff(runId, { kind: "cumulative" }) };
  } catch (cause) {
    const message = cause instanceof ApiError ? cause.message : "Failed to load diff";
    return { phase: "missing", message };
  }
}

function StatRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-b-0">
      <dt className="text-xs uppercase tracking-wide text-muted-fg">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-fg">{children}</dd>
    </div>
  );
}

function RunStatCard({
  side,
  stats,
  workflowName,
  spark,
}: {
  side: "A" | "B";
  stats: RunCompareStats;
  workflowName: string | null;
  spark: { fraction: number; count: number };
}) {
  return (
    <Card data-testid={`compare-card-${side.toLowerCase()}`}>
      <CardHeader>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-fg">
            <Badge variant={side === "A" ? "accent" : "info"}>Run {side}</Badge>
          </p>
          <CardTitle className="mt-1 truncate font-mono text-base">
            <Link
              href={`/runs/${encodeURIComponent(stats.runId)}`}
              className="rounded-sm transition-colors hover:text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {stats.branch}
            </Link>
          </CardTitle>
          {workflowName !== null ? (
            <CardDescription className="truncate">{workflowName}</CardDescription>
          ) : (
            <CardDescription>ad-hoc task</CardDescription>
          )}
        </div>
        <StatusBadge status={stats.status} />
      </CardHeader>
      <CardContent>
        <dl>
          <StatRow label="Duration">
            {formatDuration(stats.durationMs)}
            {stats.live ? " (running)" : ""}
          </StatRow>
          <StatRow label="Executions">{stats.executions}</StatRow>
          <StatRow label="Iterations">{stats.iterations}</StatRow>
          <StatRow label="Ports">{stats.ports.length > 0 ? stats.ports.join(", ") : "—"}</StatRow>
          <StatRow label="Workflow rev">
            {stats.workflowRevision === null ? "—" : `r${stats.workflowRevision}`}
          </StatRow>
          <StatRow label="Sandbox">
            <span
              title={
                stats.sandboxed
                  ? "Live sandbox while the run executes"
                  : "No live sandbox (local run or ended)"
              }
            >
              {stats.sandboxed ? `Sandboxed · ${stats.sandboxImage}` : "Local"}
            </span>
          </StatRow>
          <StatRow label="Events">
            <span className="inline-flex w-full max-w-48 items-center justify-end gap-2">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-elevated" aria-hidden>
                <span
                  className={
                    side === "A"
                      ? "block h-full rounded-full bg-accent"
                      : "block h-full rounded-full bg-info"
                  }
                  style={{ width: `${Math.round(spark.fraction * 100)}%` }}
                  data-testid={`compare-spark-${side.toLowerCase()}`}
                />
              </span>
              <span className="tabular-nums">{spark.count}</span>
            </span>
          </StatRow>
        </dl>
      </CardContent>
    </Card>
  );
}

function StepSideCell({ step }: { step: CompareStepRun | null }) {
  if (step === null) {
    return (
      <span className="text-xs text-muted-fg" title="Not executed in this run">
        —
      </span>
    );
  }
  const output = clipToLines(step.output, 2);
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-2">
        <StatusBadge status={step.status} />
        <span className="text-xs tabular-nums text-muted-fg" title="Step duration">
          {step.durationMs === undefined ? "—" : formatDuration(step.durationMs)}
        </span>
      </span>
      {output.text.length > 0 ? (
        <p className="whitespace-pre-line text-xs text-muted-fg" data-step-output>
          {output.text}
          {output.clipped ? " …" : ""}
        </p>
      ) : null}
    </div>
  );
}

function DiffPanel({ side, branch, state }: { side: "A" | "B"; branch: string; state: DiffState }) {
  return (
    <section
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface"
      data-testid={`compare-diff-${side.toLowerCase()}`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border bg-elevated px-3 py-2">
        <span className="truncate font-mono text-xs font-semibold text-fg">
          {side} · {branch}
        </span>
        {state.phase === "ready" ? (
          <span className="shrink-0 text-xs text-muted-fg">
            {state.diff.patch.length === 0
              ? "no changes"
              : `${parsePatch(state.diff.patch).length} file(s)`}
          </span>
        ) : null}
      </header>
      <div className="min-w-0">
        {state.phase === "loading" ? (
          <p className="px-3 py-3 text-xs text-muted-fg">Loading cumulative diff…</p>
        ) : state.phase === "missing" ? (
          <p className="px-3 py-3 text-xs text-muted-fg" data-diff-missing>
            Cumulative diff unavailable — {state.message}
          </p>
        ) : state.diff.patch.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-fg">No changes recorded for this run.</p>
        ) : (
          <>
            {state.diff.truncated ? (
              <p className="border-b border-border bg-warning-subtle px-3 py-1.5 text-xs text-warning">
                Showing the first {state.diff.maxLines.toLocaleString()} of{" "}
                {state.diff.totalLines.toLocaleString()} patch lines (server cap).
              </p>
            ) : null}
            <pre className="max-h-96 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed text-fg">
              {state.diff.patch}
            </pre>
          </>
        )}
      </div>
    </section>
  );
}

export function RunCompareView({ aId, bId }: { aId: string; bId: string }) {
  const [sideA, setSideA] = useState<SideState>({ phase: "loading" });
  const [sideB, setSideB] = useState<SideState>({ phase: "loading" });
  const [diffA, setDiffA] = useState<DiffState>({ phase: "loading" });
  const [diffB, setDiffB] = useState<DiffState>({ phase: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async (): Promise<void> => {
    void fetchRunDetail(aId).then(setSideA);
    void fetchRunDetail(bId).then(setSideB);
    void fetchCumulativeDiff(aId).then(setDiffA);
    void fetchCumulativeDiff(bId).then(setDiffB);
  }, [aId, bId]);

  useEffect(() => {
    setSideA({ phase: "loading" });
    setSideB({ phase: "loading" });
    setDiffA({ phase: "loading" });
    setDiffB({ phase: "loading" });
    void load();
  }, [load, reloadKey]);

  const retry = useCallback((): void => setReloadKey((key) => key + 1), []);

  if (sideA.phase === "loading" || sideB.phase === "loading") {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Loading comparison…</CardTitle>
            <CardDescription>Fetching both runs from the daemon.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <SkeletonLines rows={6} />
        </CardContent>
      </Card>
    );
  }

  for (const [side, state, runId] of [
    ["A", sideA, aId],
    ["B", sideB, bId],
  ] as const) {
    if (state.phase === "notfound") {
      return (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Run {side} not found</CardTitle>
              <CardDescription>The daemon has no record of this run.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="py-2 text-sm text-muted-fg">
              Run <span className="font-mono text-fg">{runId}</span> does not exist — it may have
              been removed, or the compare link is stale.
            </p>
          </CardContent>
        </Card>
      );
    }
    if (state.phase === "error") {
      return (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Could not load run {side}</CardTitle>
              <CardDescription>The daemon did not answer as expected.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-start gap-3 py-2 text-sm">
              <p className="text-danger">{state.message}</p>
              <Button variant="secondary" onClick={retry}>
                Retry
              </Button>
            </div>
          </CardContent>
        </Card>
      );
    }
  }

  const detailA = (sideA as { phase: "ready"; detail: CompareRunDetail }).detail;
  const detailB = (sideB as { phase: "ready"; detail: CompareRunDetail }).detail;
  const statsA = runCompareStats(detailA);
  const statsB = runCompareStats(detailB);
  const spark = eventSpark(statsA.eventCount, statsB.eventCount);
  const rows = alignRunSteps(detailA.steps, detailB.steps);
  const patchA = diffA.phase === "ready" ? diffA.diff.patch : "";
  const patchB = diffB.phase === "ready" ? diffB.diff.patch : "";
  const fileSets =
    diffA.phase === "ready" && diffB.phase === "ready" ? filesOnlyIn(patchA, patchB) : null;

  return (
    <div className="flex flex-col gap-6" data-run-compare>
      <div>
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
          Compare
        </p>
        <h1 className="mt-1 text-display font-semibold text-fg">What changed between attempts</h1>
        <p className="mt-1 text-sm text-muted-fg">
          Side-by-side stats, aligned node executions and cumulative diffs of runs A and B.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RunStatCard
          side="A"
          stats={statsA}
          workflowName={detailA.run.workflow?.name ?? null}
          spark={{ fraction: spark.aFraction, count: spark.a }}
        />
        <RunStatCard
          side="B"
          stats={statsB}
          workflowName={detailB.run.workflow?.name ?? null}
          spark={{ fraction: spark.bFraction, count: spark.b }}
        />
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Node executions</CardTitle>
            <CardDescription>
              Aligned by node and iteration — the union of both runs. “—” marks a node that did not
              execute in that run.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState
              title="No step runs in either run"
              description="Both runs completed without recorded node executions."
            />
          ) : (
            <Table data-compare-steps>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">Node</TableHead>
                  <TableHead className="w-14 text-right">Iter</TableHead>
                  <TableHead>Run A</TableHead>
                  <TableHead>Run B</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row: CompareStepRow) => (
                  <TableRow key={row.key} data-compare-row={row.key}>
                    <TableCell className="font-medium text-fg" title={row.stepId}>
                      <span className="block max-w-40 truncate">{row.label}</span>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-fg">
                      {row.iteration}
                    </TableCell>
                    <TableCell data-compare-cell="a">
                      <StepSideCell step={row.a} />
                    </TableCell>
                    <TableCell data-compare-cell="b">
                      <StepSideCell step={row.b} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Cumulative diffs</CardTitle>
            <CardDescription>
              Each run&apos;s whole-change patch; the chips call out files changed by only one of
              the two attempts.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {fileSets === null ? (
            <p className="text-sm text-muted-fg">
              File comparison appears once both cumulative diffs load.
            </p>
          ) : fileSets.onlyInA.length === 0 &&
            fileSets.onlyInB.length === 0 &&
            fileSets.inBoth.length === 0 ? (
            <p className="text-sm text-muted-fg">Neither run changed any files.</p>
          ) : (
            <div className="flex flex-col gap-2" data-compare-file-chips>
              {fileSets.onlyInA.length > 0 ? (
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-fg">
                  <span className="font-medium text-fg">Only in A:</span>
                  {fileSets.onlyInA.map((path) => (
                    <span
                      key={path}
                      className="rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 font-mono text-fg"
                      data-file-only="a"
                    >
                      {path}
                    </span>
                  ))}
                </p>
              ) : null}
              {fileSets.onlyInB.length > 0 ? (
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-fg">
                  <span className="font-medium text-fg">Only in B:</span>
                  {fileSets.onlyInB.map((path) => (
                    <span
                      key={path}
                      className="rounded-full border border-info/50 bg-info-subtle px-2 py-0.5 font-mono text-fg"
                      data-file-only="b"
                    >
                      {path}
                    </span>
                  ))}
                </p>
              ) : null}
              {fileSets.inBoth.length > 0 ? (
                <p className="text-xs text-muted-fg">
                  Changed in both: <span className="tabular-nums">{fileSets.inBoth.length}</span>{" "}
                  file{fileSets.inBoth.length === 1 ? "" : "s"}
                </p>
              ) : null}
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <DiffPanel side="A" branch={statsA.branch} state={diffA} />
            <DiffPanel side="B" branch={statsB.branch} state={diffB} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
