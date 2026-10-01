import type { ExitCondition } from "@openeuler/core";
import type { CanvasDocument, CanvasEdge } from "./canvas-document";
import { canvasEdgeId } from "./canvas-document";

/**
 * Pure canvas operations with UX rules beyond the schema (#46): connection
 * validation (entry is a pure source, no duplicate edges, exit is a
 * terminal), the always→conditional auto-conversion when a node gains a
 * second outgoing edge, and selection-aware deletion.
 */

export type ConnectFailureReason = "entry-target" | "duplicate" | "exit-source" | "unknown-node";

/** Outcome of {@link checkConnect}: either an edge to add, or why not. */
export type ConnectCheck =
  | { ok: true; edge: CanvasEdge; convertedEdgeId?: string }
  | { ok: false; reason: ConnectFailureReason; message: string };

/** Whether an edge is unconditional (a non-inverted `always`). */
export function isUnconditionalEdge(data: { condition: ExitCondition; invert?: boolean }): boolean {
  return data.condition.type === "always" && data.invert !== true;
}

/** The conditional an auto-converted `always` edge becomes until edited. */
export const AUTO_CONVERTED_CONDITION: ExitCondition = { type: "outputContains", pattern: "" };

export interface ConnectParams {
  source: string;
  target: string;
}

/**
 * Validates a pending connection and builds its edge. Rules:
 *
 * - the entry node is a pure source (no incoming edges)
 * - exit nodes are terminals (no outgoing edges)
 * - duplicate source→target edges are rejected
 * - when the source already has an unconditional outgoing edge, that edge is
 *   auto-converted to a conditional one (a node may keep only one `always`
 *   fallback) — `convertedEdgeId` tells the caller to announce it
 */
export function checkConnect(doc: CanvasDocument, params: ConnectParams): ConnectCheck {
  const sourceNode = doc.nodes.find((node) => node.id === params.source);
  const targetNode = doc.nodes.find((node) => node.id === params.target);
  if (sourceNode === undefined || targetNode === undefined) {
    return {
      ok: false,
      reason: "unknown-node",
      message: "Connect both ends to existing nodes.",
    };
  }

  if (targetNode.data.kind === "agent" && targetNode.data.isEntry) {
    return {
      ok: false,
      reason: "entry-target",
      message: "The entry node starts the workflow — connect it outward, not into it.",
    };
  }

  if (sourceNode.data.kind === "exit") {
    return {
      ok: false,
      reason: "exit-source",
      message: "Exit nodes end the workflow — they cannot have outgoing edges.",
    };
  }

  if (doc.edges.some((edge) => edge.source === params.source && edge.target === params.target)) {
    return {
      ok: false,
      reason: "duplicate",
      message: "These nodes are already connected.",
    };
  }

  const id = canvasEdgeId(params.source, params.target);
  const existingAlways = doc.edges.find(
    (edge) => edge.source === params.source && isUnconditionalEdge(edge.data),
  );

  return {
    ok: true,
    edge: {
      id,
      source: params.source,
      target: params.target,
      data: { condition: { type: "always" } },
    },
    ...(existingAlways === undefined ? {} : { convertedEdgeId: existingAlways.id }),
  };
}

/** Applies a successful {@link checkConnect}: adds the edge (+ conversion). */
export function applyConnect(
  doc: CanvasDocument,
  check: { ok: true; edge: CanvasEdge } & { convertedEdgeId?: string },
): CanvasDocument {
  const edges = check.convertedEdgeId
    ? doc.edges.map((edge) =>
        edge.id === check.convertedEdgeId
          ? { ...edge, data: { ...edge.data, condition: AUTO_CONVERTED_CONDITION } }
          : edge,
      )
    : doc.edges;
  return { nodes: doc.nodes, edges: [...edges, check.edge] };
}

export interface DeleteCheck {
  nodes: string[];
  edges: string[];
}

/**
 * Resolves a Delete-keypress against the selection: entry nodes survive
 * (they are pinned), everything else (nodes + their dangling edges) goes.
 */
export function planDelete(
  doc: CanvasDocument,
  selection: { nodeIds: readonly string[]; edgeIds: readonly string[] },
): DeleteCheck {
  const nodes = selection.nodeIds.filter(
    (id) =>
      !doc.nodes.some((node) => node.id === id && node.data.kind === "agent" && node.data.isEntry),
  );
  return { nodes, edges: [...selection.edgeIds] };
}

/** Whether deleting this selection would change anything. */
export function selectionHasDeletables(
  doc: CanvasDocument,
  selection: { nodeIds: readonly string[]; edgeIds: readonly string[] },
): boolean {
  const plan = planDelete(doc, selection);
  if (plan.edges.length > 0) return true;
  if (plan.nodes.length > 0) return true;
  // Dangling edges of deleted nodes count as deletable side effects.
  const doomed = new Set(plan.nodes);
  return doc.edges.some((edge) => doomed.has(edge.source) || doomed.has(edge.target));
}

/** Document after applying {@link planDelete} (nodes + dangling edges drop). */
export function applyDelete(doc: CanvasDocument, plan: DeleteCheck): CanvasDocument {
  const doomed = new Set(plan.nodes);
  return {
    nodes: doc.nodes.filter((node) => !doomed.has(node.id)),
    edges: doc.edges.filter(
      (edge) =>
        !plan.edges.includes(edge.id) && !doomed.has(edge.source) && !doomed.has(edge.target),
    ),
  };
}
