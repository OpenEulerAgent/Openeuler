import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { WorkflowGraph } from "@openeuler/core";
import { apiFetch } from "@/lib/api";
import {
  toCanvasDocument,
  workflowToCanvasDocument,
  type CanvasDocument,
  type CanvasEdgeData,
  type CanvasNode,
} from "@/lib/graph/canvas-document";
import { conditionSummary } from "@/lib/graph/edge-inspector";
import { isUnconditionalEdge } from "@/lib/graph/canvas-ops";
import type { NodeFoldState, NodeVisualStatus, RunGraphFoldState } from "./fold";
import type { ReplayView } from "./replay";

/**
 * Graph document resolution + React Flow projection for the run view (#52).
 *
 * The canvas renders the run's PINNED revision graph (read-only reuse of the
 * #46 canvas-document conversion); runs from before graph revisions fold a
 * chain graph from the workflow's legacy steps+loopBack via
 * `linearToGraph`. Ad-hoc runs have no graph at all.
 */

/** What a run's graph tab can show. */
export type RunGraphDocument =
  | { kind: "revision"; doc: CanvasDocument; revisionNumber: number }
  | { kind: "legacy"; doc: CanvasDocument }
  | { kind: "adhoc" };

/** Run fields the resolver needs (the decorated RunApiBody slice). */
export interface RunGraphSource {
  workflowId?: string | undefined;
  workflowRevision?: { id: string; number: number } | undefined;
}

/** Revision snapshot body of `GET /api/workflows/:id/revisions/:number`. */
interface RevisionSnapshotBody {
  revision: { id: string; number: number; graph: WorkflowGraph };
}

/** Injectable transport for {@link fetchWorkflowRevision} (tests). */
export type RevisionFetcher = (path: string) => Promise<RevisionSnapshotBody>;

export async function fetchWorkflowRevision(
  workflowId: string,
  number_: number,
  fetcher: RevisionFetcher = (path) => apiFetch<RevisionSnapshotBody>(path),
): Promise<WorkflowGraph> {
  const body = await fetcher(
    `/api/workflows/${encodeURIComponent(workflowId)}/revisions/${number_}`,
  );
  return body.revision.graph;
}

/** Injectable revision-graph loader for {@link resolveRunGraphDocument}. */
export type RevisionGraphFetcher = (
  workflowId: string,
  revisionNumber: number,
) => Promise<WorkflowGraph>;

/**
 * Resolves the graph document a run's Graph tab should render:
 *
 * 1. pinned revision snapshot (positions included) when the run pins one,
 * 2. else the workflow's current shape (graph, or `linearToGraph` over the
 *    legacy steps mirror) for pre-revision runs,
 * 3. `adhoc` (no graph) for task-only runs — and as a graceful degradation
 *    when both lookups fail (deleted workflow, older daemon).
 */
export async function resolveRunGraphDocument(
  run: RunGraphSource,
  fetchWorkflow: (workflowId: string) => Promise<Parameters<typeof workflowToCanvasDocument>[0]>,
  fetchRevision: RevisionGraphFetcher = (workflowId, number_) =>
    fetchWorkflowRevision(workflowId, number_),
): Promise<RunGraphDocument> {
  if (run.workflowId === undefined) return { kind: "adhoc" };
  // Pinned snapshot first; any failure (404 snapshot on an older daemon,
  // transient error) degrades to the workflow's current shape below rather
  // than losing the graph tab entirely.
  if (run.workflowRevision !== undefined) {
    try {
      const graph = await fetchRevision(run.workflowId, run.workflowRevision.number);
      return {
        kind: "revision",
        doc: toCanvasDocument(graph),
        revisionNumber: run.workflowRevision.number,
      };
    } catch {
      // fall through
    }
  }
  try {
    const workflow = await fetchWorkflow(run.workflowId);
    return { kind: "legacy", doc: workflowToCanvasDocument(workflow) };
  } catch {
    return { kind: "adhoc" };
  }
}

// ---------------------------------------------------------------------------
// React Flow projections (pure).
//

/** Per-node visual slice React Flow node data carries (memo key input). */
export interface NodeVisualSlice {
  status: NodeVisualStatus;
  executionCount: number;
}

export type RunGraphNodeData = Record<string, unknown> & {
  visual: NodeVisualSlice | null;
};

export type RunFlowNode = Node<RunGraphNodeData>;

/**
 * Node data cache: `{...base, visual}` objects are keyed by (base data,
 * visual slice) so unchanged nodes keep their data IDENTITY across folds —
 * React Flow's memoized cards re-render only when their visual actually
 * changed. Absent visuals reuse a per-base `visual: null` object.
 */
const nodeDataCache = new WeakMap<object, WeakMap<object, RunGraphNodeData>>();
const absentDataCache = new WeakMap<object, RunGraphNodeData>();

function runNodeData(
  base: Record<string, unknown>,
  visual: NodeVisualSlice | null,
): RunGraphNodeData {
  if (visual === null) {
    let absent = absentDataCache.get(base);
    if (absent === undefined) {
      absent = { ...base, visual: null };
      absentDataCache.set(base, absent);
    }
    return absent;
  }
  let byVisual = nodeDataCache.get(base);
  if (byVisual === undefined) {
    byVisual = new WeakMap();
    nodeDataCache.set(base, byVisual);
  }
  let data = byVisual.get(visual);
  if (data === undefined) {
    data = { ...base, visual };
    byVisual.set(visual, data);
  }
  return data;
}

/** Live-mode node visuals straight off the fold (references are stable). */
export function liveNodeVisuals(state: RunGraphFoldState): Readonly<Record<string, NodeFoldState>> {
  return state.nodes;
}

/** Replay-mode node visuals for a scrub position. */
export function replayNodeVisuals(view: ReplayView): Readonly<Record<string, NodeVisualSlice>> {
  const visuals: Record<string, NodeVisualSlice> = {};
  for (const [id, node] of Object.entries(view.nodes)) {
    visuals[id] = { status: node.status, executionCount: node.executionCount };
  }
  return visuals;
}

/** Projects canvas nodes + visuals into React Flow nodes (read-only render). */
export function toRunFlowNodes(
  doc: CanvasDocument,
  visuals: Readonly<Record<string, NodeVisualSlice | NodeFoldState>>,
): RunFlowNode[] {
  return doc.nodes.map((node: CanvasNode) => ({
    id: node.id,
    type:
      node.type === "agent"
        ? "run-agent"
        : node.type === "join"
          ? "run-join"
          : node.type === "subworkflow"
            ? "run-subworkflow"
            : "run-exit",
    position: node.position,
    data: runNodeData(node.data, (visuals[node.id] as NodeVisualSlice | undefined) ?? null),
    draggable: false,
    connectable: false,
    deletable: false,
  }));
}

/** Per-edge visual slice for either mode. */
export interface EdgeVisualSlice {
  taken: boolean;
  animated: boolean;
  takeCount: number;
  cap: { taken: number; maxIterations: number } | null;
}

/** Live-mode edge visuals off the fold. */
export function liveEdgeVisuals(
  state: RunGraphFoldState,
): Readonly<Record<string, EdgeVisualSlice>> {
  const visuals: Record<string, EdgeVisualSlice> = {};
  for (const [id, edge] of Object.entries(state.edges)) {
    visuals[id] = {
      taken: edge.takeCount > 0,
      animated: id === state.lastTakenEdgeId,
      takeCount: edge.takeCount,
      cap:
        edge.cap === null ? null : { taken: edge.cap.taken, maxIterations: edge.cap.maxIterations },
    };
  }
  return visuals;
}

/** Replay-mode edge visuals for a scrub position. */
export function replayEdgeVisuals(
  state: RunGraphFoldState,
  view: ReplayView,
): Readonly<Record<string, EdgeVisualSlice>> {
  const visuals: Record<string, EdgeVisualSlice> = {};
  for (const [id, edge] of Object.entries(view.edges)) {
    const cap = state.edges[id]?.cap ?? null;
    visuals[id] = {
      taken: edge.taken,
      animated: edge.animated,
      takeCount: edge.takeCount,
      cap: cap === null ? null : { taken: cap.taken, maxIterations: cap.maxIterations },
    };
  }
  return visuals;
}

/** Faint for untaken edges, full once traversed. */
export const RUN_EDGE_UNTAKEN_OPACITY = 0.35;

/**
 * Canvas edges → React Flow edges with execution styling: taken edges render
 * at full opacity (untaken faint), the last taken edge marches (CSS class
 * `run-edge-active`), cap-warned edges flash warning color
 * (`run-edge-cap`). Conditional edges keep the editor's condition labels.
 */
export function toRunFlowEdges(
  doc: CanvasDocument,
  visuals: Readonly<Record<string, EdgeVisualSlice>>,
): Edge<CanvasEdgeData>[] {
  return doc.edges.map((edge): Edge<CanvasEdgeData> => {
    const visual = visuals[edge.id];
    const taken = visual?.taken === true;
    const animated = visual?.animated === true;
    const capped = visual?.cap != null;

    let stroke = "var(--muted-fg)";
    let strokeWidth = taken ? 2 : 1.5;
    let opacity = taken ? 1 : RUN_EDGE_UNTAKEN_OPACITY;
    let className = "";
    if (animated) {
      stroke = "var(--accent)";
      strokeWidth = 2.5;
      className = "run-edge-active";
    } else if (capped) {
      stroke = "var(--warning)";
      strokeWidth = 2.5;
      opacity = 1;
      className = "run-edge-cap";
    }

    const conditional = !isUnconditionalEdge(edge.data);
    return {
      ...edge,
      className,
      label: conditional ? conditionSummary(edge.data) : undefined,
      labelBgStyle: { fill: "var(--surface)" },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      labelStyle: {
        fill: capped ? "var(--warning)" : stroke,
        fontSize: "10px",
      },
      style: { stroke, strokeWidth, opacity },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: stroke,
        width: 22,
        height: 22,
      } as const,
      animated: false,
      focusable: false,
    };
  });
}
