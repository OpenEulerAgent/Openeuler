"use client";

import { useState } from "react";
import type { StepRun } from "@openeuler/core";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { formatElapsed } from "@/lib/run-feed";
import type { NodeFoldState, NodeExecutionInfo } from "@/lib/run-graph/fold";

/** Output preview line cap — longer outputs collapse behind a toggle. */
const OUTPUT_PREVIEW_LINES = 12;

export interface NodeIterationRow {
  iteration: number;
  status: NodeExecutionInfo["status"];
  durationMs?: number;
  output: string;
  error?: string;
  /** Matching StepRun row, when one exists (sessionId + diff link). */
  stepRun?: StepRun;
}

/**
 * Joins the fold's per-iteration executions with the run's StepRun rows for
 * one node: fold rows carry status/output/duration (live-fresh), rows carry
 * sessionId + the stepRunId the diff deep link needs.
 */
export function nodeIterationRows(
  node: NodeFoldState | null,
  steps: readonly StepRun[],
): NodeIterationRow[] {
  const rowsByIteration = new Map(steps.map((step) => [step.iteration, step]));
  if (node === null) {
    // Not announced through events (or a legacy edge case): rows only.
    return steps.map((step) => ({
      iteration: step.iteration,
      status: step.status,
      output: step.output,
      stepRun: step,
    }));
  }
  return node.executions.map((execution) => {
    const stepRun = rowsByIteration.get(execution.iteration);
    return {
      iteration: execution.iteration,
      status: execution.status,
      ...(execution.durationMs === undefined ? {} : { durationMs: execution.durationMs }),
      // Prefer the fold's copy (live); fall back to the recorded row.
      output: execution.output ?? stepRun?.output ?? "",
      ...(execution.error === undefined ? {} : { error: execution.error }),
      ...(stepRun === undefined ? {} : { stepRun }),
    };
  });
}

function OutputBlock({ output }: { output: string }) {
  const [expanded, setExpanded] = useState(false);
  if (output.length === 0) {
    return <p className="text-xs text-muted-fg">No output recorded.</p>;
  }
  const lines = output.split("\n");
  const clipped = !expanded && lines.length > OUTPUT_PREVIEW_LINES;
  const shown = clipped ? lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n") : output;
  return (
    <div className="flex flex-col gap-1.5">
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg p-3 font-mono text-mono text-fg">
        {shown}
      </pre>
      {clipped ? (
        <Button variant="secondary" size="sm" onClick={() => setExpanded(true)}>
          Show all {lines.length} lines
        </Button>
      ) : null}
    </div>
  );
}

function IterationSection({
  row,
  onOpenDiff,
}: {
  row: NodeIterationRow;
  onOpenDiff: (stepRunId: string) => void;
}) {
  return (
    <details
      open={row.iteration === 1}
      className="group rounded-lg border border-border bg-surface"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <span className="font-medium text-fg">Iteration {row.iteration}</span>
        <StatusBadge status={row.status} />
        {row.durationMs !== undefined ? (
          <span className="text-xs text-muted-fg" title="Duration">
            {formatElapsed(0, row.durationMs)}
          </span>
        ) : null}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
        {row.stepRun?.sessionId ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-fg">
            <span>session</span>
            <code
              className="max-w-full truncate rounded bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-fg"
              title={row.stepRun.sessionId}
            >
              {row.stepRun.sessionId}
            </code>
          </p>
        ) : null}
        {row.error ? (
          <p className="rounded-lg border border-danger/40 bg-danger-subtle px-3 py-2 text-xs text-danger">
            {row.error}
          </p>
        ) : null}
        <OutputBlock output={row.output} />
        {row.stepRun ? (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => onOpenDiff(row.stepRun?.id ?? "")}
          >
            View diff
            {(row.stepRun.diff ?? "").length === 0 ? " (none)" : ""}
          </Button>
        ) : (
          <p className="text-xs text-muted-fg">No StepRun row recorded for this execution.</p>
        )}
      </div>
    </details>
  );
}

/**
 * Node execution drawer (#52): click a node on the graph to inspect its
 * StepRuns grouped by iteration — status, duration, final output (mono,
 * collapsed past a preview cap), sessionId for context continuity, and a
 * deep link into the Diff tab scoped to that step run.
 */
export function NodeRunDrawer({
  open,
  onClose,
  nodeId,
  nodeName,
  node,
  steps,
  onOpenDiff,
}: {
  open: boolean;
  onClose: () => void;
  nodeId: string | null;
  nodeName: string | null;
  node: NodeFoldState | null;
  steps: readonly StepRun[];
  onOpenDiff: (stepRunId: string) => void;
}) {
  if (nodeId === null) return null;
  const rows = nodeIterationRows(
    node,
    steps.filter((step) => step.stepId === nodeId),
  );
  return (
    <Drawer open={open} onClose={onClose} label={`Node executions: ${nodeName ?? nodeId}`}>
      <div className="flex flex-col gap-4">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-muted-fg uppercase">
              Node executions
            </p>
            <h2 className="truncate text-title font-semibold text-fg" title={nodeName ?? nodeId}>
              {nodeName ?? nodeId}
            </h2>
            <code className="mt-0.5 block truncate font-mono text-xs text-muted-fg">{nodeId}</code>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </header>

        {rows.length === 0 ? (
          <p className="text-sm text-muted-fg">
            This node has not executed yet — it will appear here once the run reaches it.
          </p>
        ) : (
          <div className="flex flex-col gap-2" data-node-drawer-iterations>
            {rows.map((row) => (
              <IterationSection key={row.iteration} row={row} onOpenDiff={onOpenDiff} />
            ))}
          </div>
        )}
      </div>
    </Drawer>
  );
}
