"use client";

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import type { AgentNodeData, ExitNodeData, JoinNodeData } from "@/lib/graph/canvas-document";
import type { NodeVisualSlice } from "@/lib/run-graph/document";
import { cn } from "@/lib/cn";

/**
 * Read-only execution node cards for the run graph view (#52): the #46
 * canvas cards, slimmed down (name + driver + state) and driven by the
 * folded execution state passed through node `data.visual` — the fold keeps
 * sub-object identity for untouched nodes, so React Flow's `memo` skips
 * re-rendering every card except the ones whose state changed.
 */

export type RunAgentFlowNode = Node<
  AgentNodeData & { visual: NodeVisualSlice | null },
  "run-agent"
>;
export type RunExitFlowNode = Node<ExitNodeData & { visual: NodeVisualSlice | null }, "run-exit">;
export type RunJoinFlowNode = Node<JoinNodeData & { visual: NodeVisualSlice | null }, "run-join">;

/** Card frame per visual status (ring color + surface treatment). */
const STATUS_CARD_CLASSES: Record<NodeVisualSlice["status"], string> = {
  "not-reached": "border-border opacity-55",
  queued: "border-border bg-elevated text-muted-fg",
  running: "run-node-running bg-surface",
  success: "border-success/70 bg-success-subtle/40",
  failed: "border-danger bg-danger-subtle/50",
  aborted: "border-warning/70 bg-surface",
  interrupted: "border-warning/70 border-dashed bg-surface",
};

/** Status dot color per visual status. */
const STATUS_DOT_CLASSES: Record<NodeVisualSlice["status"], string> = {
  "not-reached": "bg-muted-fg/50",
  queued: "bg-muted-fg",
  running: "bg-accent",
  success: "bg-success",
  failed: "bg-danger",
  aborted: "bg-warning",
  interrupted: "bg-warning",
};

export function statusCardClasses(status: NodeVisualSlice["status"]): string {
  return STATUS_CARD_CLASSES[status];
}

function StatusDot({ status }: { status: NodeVisualSlice["status"] }) {
  return (
    <span
      aria-hidden
      data-run-node-dot={status}
      className={cn(
        "size-2 shrink-0 rounded-full",
        STATUS_DOT_CLASSES[status],
        status === "running" && "animate-pulse",
      )}
    />
  );
}

/** Iteration badge: how many times this node has executed (loops). */
function IterationBadge({ count }: { count: number }) {
  if (count < 1) return null;
  return (
    <span
      title={`${count} execution${count === 1 ? "" : "s"}`}
      className={cn(
        "absolute -top-2 -right-2 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums shadow-2",
        count > 1
          ? "border-accent/60 bg-accent text-accent-fg"
          : "border-border bg-elevated text-muted-fg",
      )}
    >
      ×{count}
    </span>
  );
}

function AgentExecutionCard({ data }: NodeProps<RunAgentFlowNode>) {
  const { visual } = data;
  const status = visual?.status ?? "not-reached";
  return (
    <div
      className={cn(
        "relative w-56 cursor-pointer rounded-lg border bg-surface p-3 shadow-2 transition-colors",
        statusCardClasses(status),
      )}
      data-run-node="agent"
      data-run-node-status={status}
    >
      <IterationBadge count={visual?.executionCount ?? 0} />
      {data.isEntry ? (
        <span className="absolute -top-2.5 left-3 rounded-full border border-accent/60 bg-accent px-2 py-0.5 text-[10px] font-semibold tracking-wide text-accent-fg uppercase">
          Entry
        </span>
      ) : null}
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={data.name}>
          {data.name.length > 0 ? data.name : "Untitled agent"}
        </p>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <span className="max-w-full truncate rounded-full bg-elevated px-2 py-0.5 font-mono text-[10px] text-muted-fg">
          {data.config.driver}
        </span>
      </div>
      {data.isEntry ? null : (
        <Handle type="target" position={Position.Left} className="!bg-muted-fg" />
      )}
      <Handle type="source" position={Position.Right} className="!bg-accent" />
    </div>
  );
}

function ExitExecutionCard({ data }: NodeProps<RunExitFlowNode>) {
  const { visual } = data;
  const status = visual?.status ?? "not-reached";
  return (
    <div
      className={cn(
        "relative flex w-35 cursor-pointer items-center gap-2 rounded-lg border border-dashed bg-surface px-3 py-3 shadow-2 transition-colors",
        statusCardClasses(status),
      )}
      data-run-node="exit"
      data-run-node-status={status}
    >
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded-sm border-2 border-danger bg-danger-subtle"
      />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-fg" title={data.name}>
          {data.name.length > 0 ? data.name : "Exit"}
        </p>
        <p className="text-[10px] tracking-wide text-muted-fg uppercase">terminal</p>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-danger" />
    </div>
  );
}

/** Join/merge marker card (#115): a synchronizer, not a terminal. */
function JoinExecutionCard({ data }: NodeProps<RunJoinFlowNode>) {
  const { visual } = data;
  const status = visual?.status ?? "not-reached";
  return (
    <div
      className={cn(
        "relative flex w-35 cursor-pointer items-center gap-2 rounded-lg border border-dashed bg-surface px-3 py-3 shadow-2 transition-colors",
        statusCardClasses(status),
      )}
      data-run-node="join"
      data-run-node-status={status}
    >
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded-full border-2 border-accent bg-accent-subtle"
      />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-fg" title={data.name}>
          {data.name.length > 0 ? data.name : "Join"}
        </p>
        <p className="text-[10px] tracking-wide text-muted-fg uppercase">
          join · {data.config.mode}
        </p>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-muted-fg" />
      <Handle type="source" position={Position.Right} className="!bg-accent" />
    </div>
  );
}

export const runGraphNodeTypes: NodeTypes = {
  "run-agent": memo(AgentExecutionCard) as unknown as NodeTypes["run-agent"],
  "run-exit": memo(ExitExecutionCard) as unknown as NodeTypes["run-exit"],
  "run-join": memo(JoinExecutionCard) as unknown as NodeTypes["run-join"],
};
