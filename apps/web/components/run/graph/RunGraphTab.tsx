"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StepRun } from "@openeuler/core";
import { Background, BackgroundVariant, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./run-graph.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CanvasDocument } from "@/lib/graph/canvas-document";
import type { RunGraphDocument } from "@/lib/run-graph/document";
import {
  liveEdgeVisuals,
  liveNodeVisuals,
  replayEdgeVisuals,
  replayNodeVisuals,
  toRunFlowEdges,
  toRunFlowNodes,
} from "@/lib/run-graph/document";
import type { RunGraphFoldState } from "@/lib/run-graph/fold";
import { replayAsOf, replayRange } from "@/lib/run-graph/replay";
import { cn } from "@/lib/cn";
import { NodeRunDrawer } from "./NodeRunDrawer";
import { runGraphNodeTypes } from "./run-graph-nodes";

/** Replay auto-advance interval (play button, nice-to-have). */
const REPLAY_PLAY_INTERVAL_MS = 800;

const LEGEND = [
  { status: "running", label: "running" },
  { status: "queued", label: "queued" },
  { status: "success", label: "success" },
  { status: "failed", label: "failed" },
  { status: "not-reached", label: "not reached" },
] as const;

function LegendDot({ status }: { status: (typeof LEGEND)[number]["status"] }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 rounded-full",
        status === "running" && "animate-pulse bg-accent",
        status === "queued" && "bg-muted-fg",
        status === "success" && "bg-success",
        status === "failed" && "bg-danger",
        status === "not-reached" && "bg-muted-fg/50",
      )}
    />
  );
}

/**
 * Replay scrubber for finished runs (#52): slider + prev/next through the
 * execution breadcrumb; `null` position means "latest" (the full folded
 * final state). Play auto-advances every {@link REPLAY_PLAY_INTERVAL_MS}.
 */
function ReplayControls({
  state,
  position,
  onPosition,
}: {
  state: RunGraphFoldState;
  position: number | null;
  onPosition: (position: number | null) => void;
}) {
  const range = replayRange(state);
  const [playing, setPlaying] = useState(false);
  const positionRef = useRef<number | null>(position);
  positionRef.current = position;

  // Auto-advance while playing; stops (and resets to latest) at the end.
  useEffect(() => {
    if (!playing || range === null) return;
    const timer = setInterval(() => {
      const current = positionRef.current;
      if (current === null) {
        onPosition(0);
        return;
      }
      if (current >= range.max) {
        setPlaying(false);
        onPosition(null);
        return;
      }
      onPosition(current + 1);
    }, REPLAY_PLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, onPosition, range]);

  if (range === null) return null;

  const scrubbing = position !== null;
  const at = scrubbing ? (position as number) : range.max;

  const step = (delta: number): void => {
    setPlaying(false);
    const base = scrubbing ? (position as number) : range.max;
    const next = Math.min(range.max, Math.max(range.min, base + delta));
    onPosition(next >= range.max ? null : next);
  };

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 shadow-1"
      data-replay-controls
    >
      <span className="text-xs font-medium text-muted-fg">Replay</span>
      <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" onClick={() => step(-1)} disabled={!scrubbing}>
          ‹ Prev
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setPlaying((prev) => !prev)}
          aria-pressed={playing}
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => step(1)} disabled={at >= range.max}>
          Next ›
        </Button>
      </div>
      <label className="flex min-w-40 flex-1 items-center gap-2 text-xs text-muted-fg">
        <span className="w-14 text-right tabular-nums">
          {scrubbing ? `${at + 1} / ${state.breadcrumb.length}` : "latest"}
        </span>
        <input
          type="range"
          className="h-1.5 flex-1 accent-[var(--accent)]"
          min={range.min}
          max={range.max}
          value={at}
          aria-label="Execution position"
          onChange={(event) => {
            setPlaying(false);
            const next = Number(event.target.value);
            onPosition(next >= range.max ? null : next);
          }}
        />
      </label>
      {scrubbing ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setPlaying(false);
            onPosition(null);
          }}
        >
          Latest
        </Button>
      ) : (
        <Badge variant="neutral">final state</Badge>
      )}
    </div>
  );
}

function GraphCanvas({
  doc,
  state,
  replayPosition,
  steps,
  onOpenDiff,
}: {
  doc: CanvasDocument;
  state: RunGraphFoldState;
  replayPosition: number | null;
  steps: readonly StepRun[];
  onOpenDiff: (stepRunId: string) => void;
}) {
  const [drawerNodeId, setDrawerNodeId] = useState<string | null>(null);

  const view = useMemo(
    () => (replayPosition === null ? null : replayAsOf(state, replayPosition)),
    [state, replayPosition],
  );
  const nodes = useMemo(
    () => toRunFlowNodes(doc, view ? replayNodeVisuals(view) : liveNodeVisuals(state)),
    [doc, state, view],
  );
  const edges = useMemo(
    () => toRunFlowEdges(doc, view ? replayEdgeVisuals(state, view) : liveEdgeVisuals(state)),
    [doc, state, view],
  );
  const nodeNames = useMemo(
    () => new Map(doc.nodes.map((node) => [node.id, node.data.name])),
    [doc],
  );
  const drawerNode = drawerNodeId === null ? null : (state.nodes[drawerNodeId] ?? null);

  return (
    <div className="flex flex-col gap-3" data-run-graph-canvas>
      <div className="relative h-[32rem] overflow-hidden rounded-xl border border-border bg-surface shadow-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={runGraphNodeTypes}
          onNodeClick={(_, node) => setDrawerNodeId(node.id)}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          edgesFocusable={false}
          elementsSelectable
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          selectionOnDrag={false}
          panOnScroll
          zoomOnDoubleClick={false}
          minZoom={0.15}
          maxZoom={2.5}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          colorMode="dark"
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
          <Controls showInteractive={false} />
        </ReactFlow>

        <div className="pointer-events-none absolute top-3 left-3 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface/90 px-3 py-1.5 text-xs text-muted-fg shadow-1">
          {LEGEND.map(({ status, label }) => (
            <span key={status} className="flex items-center gap-1.5">
              <LegendDot status={status} />
              {label}
            </span>
          ))}
        </div>
      </div>

      <NodeRunDrawer
        open={drawerNodeId !== null}
        onClose={() => setDrawerNodeId(null)}
        nodeId={drawerNodeId}
        nodeName={drawerNodeId === null ? null : (nodeNames.get(drawerNodeId) ?? drawerNodeId)}
        node={drawerNode}
        steps={steps}
        onOpenDiff={onOpenDiff}
      />
    </div>
  );
}

/**
 * Graph tab of the run detail page (#52): the run's pinned revision graph
 * rendered read-only, node/edge states driven by the folded event stream,
 * replay scrubbing for finished runs, and a per-node execution drawer.
 */
export function RunGraphTab({
  graph,
  state,
  live,
  steps,
  onOpenDiff,
}: {
  graph: RunGraphDocument;
  state: RunGraphFoldState;
  live: boolean;
  steps: readonly StepRun[];
  onOpenDiff: (stepRunId: string) => void;
}) {
  const [replayPosition, setReplayPosition] = useState<number | null>(null);

  if (graph.kind === "adhoc") {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Graph unavailable</CardTitle>
            <CardDescription>
              This run has no workflow graph to render (ad-hoc task run, or its workflow is gone).
              Follow along in the Events tab.
            </CardDescription>
          </div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-run-graph-tab>
      <div className="flex flex-wrap items-center gap-2">
        {graph.kind === "revision" ? (
          <Badge variant="neutral">pinned revision {graph.revisionNumber}</Badge>
        ) : (
          <Badge
            variant="neutral"
            title="Run predates graph revisions — showing the workflow's current shape"
          >
            legacy workflow
          </Badge>
        )}
        <span className="text-xs text-muted-fg">Click a node for its executions.</span>
      </div>

      {!live && state.breadcrumb.length > 0 ? (
        <ReplayControls state={state} position={replayPosition} onPosition={setReplayPosition} />
      ) : null}

      <GraphCanvas
        doc={graph.doc}
        state={state}
        replayPosition={replayPosition}
        steps={steps}
        onOpenDiff={onOpenDiff}
      />
    </div>
  );
}
