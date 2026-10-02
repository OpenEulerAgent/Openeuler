"use client";

import { createContext, memo, useContext } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Node, NodeTypes } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { CANVAS_NODE_SIZE_CLASSES } from "@/lib/graph/canvas-geometry";
import type {
  AgentNodeData,
  CanvasNode,
  CanvasNodeData,
  ExitNodeData,
} from "@/lib/graph/canvas-document";

/** React Flow node types as used by the canvas editor. */
export type AgentFlowNode = Node<AgentNodeData, "agent">;
export type ExitFlowNode = Node<ExitNodeData, "exit">;
export type CanvasFlowNode = Node<CanvasNodeData, "agent" | "exit">;

/**
 * Validation blocker counts per node id, provided by the editor so the cards
 * render red badges without polluting the (serialized) node data.
 */
export const NodeIssueCountsContext = createContext<ReadonlyMap<string, number>>(new Map());

/**
 * Hint (structural WIP) issue counts per node id (#68) — amber badges for
 * findings like an unreachable freshly dropped node. Still blocks saving;
 * purely a calmer tone than blockers.
 */
export const NodeHintCountsContext = createContext<ReadonlyMap<string, number>>(new Map());

/**
 * Advisory warning counts per node id (e.g. a router with no `always`
 * fallback, #48) — amber badges, never blocking a save.
 */
export const NodeWarningCountsContext = createContext<ReadonlyMap<string, number>>(new Map());

/** Session-chaining icon (chain link glyph) shown when continueSession is on. */
function SessionIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn("size-3.5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M6.5 9.5 9.5 6.5" strokeLinecap="round" />
      <path d="M5 8 3.5 9.5a2.12 2.12 0 0 0 3 3L8 11" strokeLinecap="round" />
      <path d="M11 8l1.5-1.5a2.12 2.12 0 0 0-3-3L8 5" strokeLinecap="round" />
    </svg>
  );
}

function CountBadge({
  count,
  tone,
  label,
}: {
  count: number;
  tone: "danger" | "warning";
  label: string;
}) {
  if (count === 0) return null;
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        "flex size-5 items-center justify-center rounded-full border text-[10px] font-semibold shadow-2",
        tone === "danger"
          ? "border-danger bg-danger-strong text-white"
          : "border-warning bg-warning text-black",
      )}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

/**
 * Live validation badges for one node (#68): red dot(s) for blockers, amber
 * dot for hints (e.g. a freshly dropped, not-yet-connected node). Both
 * update as the document changes, before any save attempt.
 */
function IssueBadges({ blockers, hints }: { blockers: number; hints: number }) {
  if (blockers === 0 && hints === 0) return null;
  return (
    <span className="absolute -top-2 -right-2 flex gap-1" data-issue-badges>
      <CountBadge
        count={blockers}
        tone="danger"
        label={`${blockers} validation blocker${blockers === 1 ? "" : "s"}`}
      />
      <CountBadge
        count={hints}
        tone="warning"
        label={`${hints} validation hint${hints === 1 ? "" : "s"}`}
      />
    </span>
  );
}

/** Amber "no fallback" badge for a router node with no `always` edge (#48). */
function NoFallbackBadge() {
  return (
    <span
      role="status"
      title="Router has no always fallback edge"
      className="absolute -bottom-2 left-3 flex items-center gap-1 rounded-full border border-warning/60 bg-warning-subtle px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-warning uppercase shadow-2"
      data-no-fallback-badge
    >
      no fallback
    </span>
  );
}

/**
 * Agent node card: name, driver chip, model, mode badge, session icon; the
 * entry node additionally carries the pinned Entry badge and no target
 * handle (nothing may connect into it). The box is deterministic (#88):
 * width AND height pinned to the geometry tokens (240×72) with a nowrap,
 * truncating badge row — wrapping badges can never change the node size,
 * so dagre's reserved box always matches the painted card.
 */
function AgentNodeCard({ id, data, selected }: NodeProps<AgentFlowNode>) {
  const issueCounts = useContext(NodeIssueCountsContext);
  const hintCounts = useContext(NodeHintCountsContext);
  const warningCounts = useContext(NodeWarningCountsContext);
  const { config } = data;
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-lg border bg-surface p-3 shadow-2 transition-colors",
        CANVAS_NODE_SIZE_CLASSES.agent.width,
        CANVAS_NODE_SIZE_CLASSES.agent.height,
        selected ? "border-accent" : "border-border hover:border-muted-fg",
      )}
      data-canvas-node="agent"
    >
      <IssueBadges blockers={issueCounts.get(id) ?? 0} hints={hintCounts.get(id) ?? 0} />
      {(warningCounts.get(id) ?? 0) > 0 ? <NoFallbackBadge /> : null}
      {data.isEntry ? (
        <span className="absolute -top-2.5 left-3 rounded-full border border-accent/60 bg-accent px-2 py-0.5 text-[10px] font-semibold tracking-wide text-accent-fg uppercase">
          Entry
        </span>
      ) : null}
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", data.isEntry ? "bg-accent" : "bg-muted-fg")}
        />
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={data.name}>
          {data.name.length > 0 ? data.name : "Untitled agent"}
        </p>
      </div>
      <div className="mt-2 flex flex-nowrap items-center gap-1.5">
        <Badge
          variant="outline"
          className="min-w-0 truncate px-2 py-0 font-mono text-[10px]"
          title={config.driver}
        >
          {config.driver.length > 0 ? config.driver : "—"}
        </Badge>
        {config.model ? (
          <Badge variant="neutral" className="min-w-0 truncate px-2 py-0 font-mono text-[10px]">
            {config.model}
          </Badge>
        ) : null}
        <Badge
          variant={config.mode === "ask" ? "warning" : "info"}
          className="shrink-0 px-2 py-0 text-[10px] lowercase"
        >
          {config.mode}
        </Badge>
        {config.continueSession ? (
          <span
            title="Continues the previous session"
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-elevated px-2 py-0.5 text-[10px] font-medium text-muted-fg"
          >
            <SessionIcon className="size-3" /> session
          </span>
        ) : null}
      </div>
      {data.isEntry ? null : (
        <Handle type="target" position={Position.Left} className="!bg-muted-fg" />
      )}
      <Handle type="source" position={Position.Right} className="!bg-accent" />
    </div>
  );
}

/** Exit terminal marker: a stop-symbol card that accepts connections only. */
function ExitNodeCard({ id, data, selected }: NodeProps<ExitFlowNode>) {
  const issueCounts = useContext(NodeIssueCountsContext);
  const hintCounts = useContext(NodeHintCountsContext);
  return (
    <div
      className={cn(
        "relative flex items-center gap-2 rounded-lg border border-dashed bg-surface px-3 py-3 shadow-2 transition-colors",
        CANVAS_NODE_SIZE_CLASSES.exit.width,
        CANVAS_NODE_SIZE_CLASSES.exit.height,
        selected ? "border-accent" : "border-border",
      )}
      data-canvas-node="exit"
    >
      <IssueBadges blockers={issueCounts.get(id) ?? 0} hints={hintCounts.get(id) ?? 0} />
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

/**
 * Canvas nodes → React Flow nodes. The entry gets `deletable: false` so no
 * React Flow delete path can remove it (the editor's own delete planning
 * double-checks); the flag is runtime-only and never serialized.
 * Identity-preserving (#88): non-entry nodes pass through UNCHANGED, and
 * the entry's stamped object is cached against its document node — a drag
 * or single-field edit does not invalidate node references. Without this,
 * every recompute rebuilt the entry object, React Flow re-adopted it,
 * wiped its `measured` dimensions and flashed the card hidden until the
 * next ResizeObserver pass (the blank-node/flicker symptom).
 */
const entryFlowNodeCache = new WeakMap<CanvasNode, CanvasFlowNode>();

export function toFlowNodes(nodes: readonly CanvasNode[]): CanvasFlowNode[] {
  return nodes.map((node) => {
    if (node.data.kind !== "agent" || !node.data.isEntry) return node as CanvasFlowNode;
    const cached = entryFlowNodeCache.get(node);
    if (cached !== undefined) return cached;
    const stamped = { ...node, deletable: false } as CanvasFlowNode;
    entryFlowNodeCache.set(node, stamped);
    return stamped;
  });
}

export const canvasNodeTypes: NodeTypes = {
  agent: memo(AgentNodeCard) as unknown as NodeTypes["agent"],
  exit: memo(ExitNodeCard) as unknown as NodeTypes["exit"],
};
