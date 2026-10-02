"use client";

import { useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
} from "@xyflow/react";
import { Button } from "@/components/ui/button";
import type { CanvasDocument, CanvasEdgeData } from "@/lib/graph/canvas-document";
import { edgeChipLabel } from "@/lib/graph/edge-inspector";
import { isUnconditionalEdge } from "@/lib/graph/canvas-ops";
import { canvasNodeTypes, toFlowNodes } from "./canvas-nodes";

/**
 * Read-only revision snapshot (#77): the editor's own node cards and edge
 * labels, every editing affordance off (no drag, connect, select, or
 * delete), fit-to-view. The run-graph read-only projection is shaped by run
 * execution visuals, so this renders via the editor's plain conversion
 * instead. Escape and the bar button both return to editing — the editing
 * canvas (and its dirty state) is merely hidden, never touched.
 */

/** Editor edge styling minus every interactive concern: labels only. */
function toReadOnlyFlowEdges(doc: CanvasDocument): Edge<CanvasEdgeData>[] {
  const outgoing = new Map<string, number>();
  for (const edge of doc.edges) {
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  }
  return doc.edges.map((edge): Edge<CanvasEdgeData> => {
    const conditional = !isUnconditionalEdge(edge.data);
    const router = (outgoing.get(edge.source) ?? 0) > 1;
    const stroke = conditional ? "var(--info)" : "var(--muted-fg)";
    return {
      ...edge,
      interactionWidth: 0,
      label: conditional || router ? edgeChipLabel(edge.data) : undefined,
      labelBgStyle: { fill: "var(--surface)" },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      labelStyle: { fill: stroke, fontSize: "10px" },
      style: {
        stroke,
        strokeWidth: 2,
        ...(conditional ? { strokeDasharray: "6 4" } : {}),
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      focusable: false,
    };
  });
}

export function ReadOnlyRevisionView({
  revisionNumber,
  doc,
  onExit,
}: {
  revisionNumber: number;
  /** Null while the snapshot fetch is in flight. */
  doc: CanvasDocument | null;
  onExit: () => void;
}) {
  // Escape mirrors the bar button: back to editing, edits untouched.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onExit();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onExit]);

  const nodes = useMemo(() => (doc === null ? [] : toFlowNodes(doc.nodes)), [doc]);
  const edges = useMemo(() => (doc === null ? [] : toReadOnlyFlowEdges(doc)), [doc]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-readonly-revision={revisionNumber}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <span
          role="status"
          className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-info"
        >
          Viewing revision {revisionNumber} — read-only
        </span>
        <span className="text-xs text-muted-fg">
          Snapshots never change; the canvas is as saved.
        </span>
        <Button variant="secondary" size="sm" className="ml-auto" onClick={onExit}>
          Back to editor
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {doc === null ? (
          <p className="p-6 text-sm text-muted-fg" role="status">
            Loading revision {revisionNumber}…
          </p>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={canvasNodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesReconnectable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            onConnect={undefined}
            deleteKeyCode={null}
            multiSelectionKeyCode={null}
            selectionOnDrag={false}
            panOnScroll
            zoomOnDoubleClick={false}
            minZoom={0.2}
            maxZoom={2.5}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            colorMode="dark"
            attributionPosition="top-right"
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
            <Controls position="bottom-right" showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
