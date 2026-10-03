import dagre from "@dagrejs/dagre";
import { CANVAS_NODE_SIZES } from "./canvas-geometry";
import type { CanvasDocument, CanvasNode } from "./canvas-document";

/**
 * Auto-layout (#46): a deterministic dagre wrapper producing left-to-right
 * positions for the canvas. Pure function over the document — same input,
 * same output — so it is unit-testable without a browser.
 */

/**
 * Rendered node bounding boxes. Re-exported from the geometry tokens
 * (#88) so dagre reserves exactly what the cards pin via their Tailwind
 * utilities — one source of truth, nothing kept in sync by hand.
 */
export const NODE_SIZES = CANVAS_NODE_SIZES;

export interface LayoutOptions {
  rankdir?: "LR" | "TB";
  /** Horizontal gap between ranks; vertical gap within a rank. */
  rankSep?: number;
  nodeSep?: number;
}

export const DEFAULT_LAYOUT_OPTIONS: Required<LayoutOptions> = {
  rankdir: "LR",
  rankSep: 80,
  nodeSep: 40,
};

function nodeSize(node: CanvasNode): { width: number; height: number } {
  if (node.data.kind === "agent") return NODE_SIZES.agent;
  if (node.data.kind === "join") return NODE_SIZES.join;
  if (node.data.kind === "subworkflow") return NODE_SIZES.subworkflow;
  return NODE_SIZES.exit;
}

/**
 * Left-to-right dagre layout: node id → new top-left position (dagre works
 * on centers; converted back). Nodes without edges keep a sensible position
 * (isolated nodes stack below the graph). Deterministic: dagre is seeded by
 * insertion order, so nodes/edges are fed in document order.
 */
export function layoutCanvasDocument(
  doc: CanvasDocument,
  options: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const config = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: config.rankdir,
    ranksep: config.rankSep,
    nodesep: config.nodeSep,
    marginx: 0,
    marginy: 0,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of doc.nodes) {
    const { width, height } = nodeSize(node);
    graph.setNode(node.id, { width, height });
  }
  const known = new Set(doc.nodes.map((node) => node.id));
  for (const edge of doc.edges) {
    if (known.has(edge.source) && known.has(edge.target)) graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  const positions = new Map<string, { x: number; y: number }>();
  let isolatedY: number | null = null;
  let connectedMaxY = 0;
  for (const node of doc.nodes) {
    const placed = graph.node(node.id);
    const { width, height } = nodeSize(node);
    if (placed === undefined || placed.x === undefined || placed.y === undefined) {
      continue;
    }
    const hasEdges = doc.edges.some((edge) => edge.source === node.id || edge.target === node.id);
    if (hasEdges) {
      connectedMaxY = Math.max(connectedMaxY, placed.y + height / 2);
      positions.set(node.id, { x: placed.x - width / 2, y: placed.y - height / 2 });
    } else {
      // Isolated nodes (not yet wired): stack them under the laid-out graph.
      isolatedY = isolatedY ?? connectedMaxY + 40;
      positions.set(node.id, { x: 0, y: isolatedY });
      isolatedY += height + 40;
    }
  }
  return positions;
}

/** Applies layout positions to a document (new objects, input untouched). */
export function applyLayout(doc: CanvasDocument, options: LayoutOptions = {}): CanvasDocument {
  const positions = layoutCanvasDocument(doc, options);
  return {
    nodes: doc.nodes.map((node) => {
      const position = positions.get(node.id);
      return position === undefined ? node : { ...node, position };
    }),
    edges: doc.edges,
  };
}
