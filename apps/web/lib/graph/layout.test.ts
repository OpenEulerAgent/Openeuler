import { describe, expect, it } from "vitest";
import { WorkflowGraphSchema } from "@openeuler/core";
import { createAgentNode, toCanvasDocument, type CanvasDocument } from "./canvas-document";
import { NODE_SIZES, applyLayout, layoutCanvasDocument } from "./layout";

function docFrom(raw: {
  entryNodeId: string;
  nodes: Array<{ id: string; type?: "agent" | "exit"; name?: string }>;
  edges: Array<{ source: string; target: string; condition?: "always" | "conditional" }>;
}): CanvasDocument {
  const graph = WorkflowGraphSchema.parse({
    entryNodeId: raw.entryNodeId,
    nodes: raw.nodes.map((node, index) => ({
      id: node.id,
      type: node.type ?? "agent",
      name: node.name ?? node.id,
      position: { x: 0, y: 0 },
      ...(node.type === "exit"
        ? {}
        : {
            config: {
              driver: "opencode",
              mode: "auto",
              promptTemplate: `p${index}: {{task}}`,
              continueSession: false,
            },
          }),
    })),
    edges: raw.edges.map((edge) => ({
      id: `e-${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      condition:
        edge.condition === "conditional"
          ? { type: "outputContains", pattern: "again" }
          : { type: "always" },
    })),
  });
  return toCanvasDocument(graph);
}

/** Bounding boxes (top-left + size) for overlap checks. */
function boxes(doc: CanvasDocument, positions: Map<string, { x: number; y: number }>) {
  return doc.nodes.map((node) => {
    const position = positions.get(node.id);
    if (position === undefined) throw new Error(`missing position for ${node.id}`);
    const size = node.data.kind === "agent" ? NODE_SIZES.agent : NODE_SIZES.exit;
    return { id: node.id, ...position, ...size };
  });
}

function assertNoOverlaps(doc: CanvasDocument, positions: Map<string, { x: number; y: number }>) {
  const rects = boxes(doc, positions);
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i] as (typeof rects)[number];
      const b = rects[j] as (typeof rects)[number];
      const overlaps =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlaps, `${a.id} overlaps ${b.id}`).toBe(false);
    }
  }
}

describe("layoutCanvasDocument", () => {
  const fixLoop = docFrom({
    entryNodeId: "implement",
    nodes: [{ id: "implement" }, { id: "review" }, { id: "x", type: "exit" }],
    edges: [
      { source: "implement", target: "review" },
      { source: "review", target: "x" },
      { source: "review", target: "implement", condition: "conditional" },
    ],
  });

  it("is deterministic for a fixed graph", () => {
    const first = layoutCanvasDocument(fixLoop);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(layoutCanvasDocument(fixLoop)).toEqual(first);
    }
  });

  it("lays out left-to-right: every forward edge points right in x", () => {
    const positions = layoutCanvasDocument(fixLoop);
    for (const edge of fixLoop.edges) {
      if (edge.data.condition.type !== "always") continue; // loop edges point back by design
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (source === undefined || target === undefined) throw new Error("missing position");
      expect(
        source.x + NODE_SIZES.agent.width <= target.x + 1,
        `${edge.source} should sit left of ${edge.target}`,
      ).toBe(true);
    }
    // The chain ranks strictly: entry < review < exit.
    const rank = (id: string): number => positions.get(id)?.x ?? -1;
    expect(rank("implement")).toBeLessThan(rank("review"));
    expect(rank("review")).toBeLessThan(rank("x"));
  });

  it("produces no overlapping bounding boxes for reasonable graphs", () => {
    const router = docFrom({
      entryNodeId: "triage",
      nodes: [
        { id: "triage" },
        { id: "fix" },
        { id: "docs" },
        { id: "lint" },
        { id: "x", type: "exit" },
      ],
      edges: [
        { source: "triage", target: "fix", condition: "conditional" },
        { source: "triage", target: "docs", condition: "conditional" },
        { source: "triage", target: "lint", condition: "conditional" },
        { source: "triage", target: "x" },
        { source: "fix", target: "x" },
        { source: "docs", target: "x" },
        { source: "lint", target: "x" },
      ],
    });
    assertNoOverlaps(router, layoutCanvasDocument(router));
    assertNoOverlaps(fixLoop, layoutCanvasDocument(fixLoop));
  });

  it("stacks isolated (unwired) nodes below the graph instead of on top", () => {
    // Built directly (not via the schema) — an isolated node is exactly the
    // mid-edit state auto-layout has to cope with.
    const wired = docFrom({
      entryNodeId: "a",
      nodes: [{ id: "a" }, { id: "x", type: "exit" }],
      edges: [{ source: "a", target: "x" }],
    });
    const isolated = createAgentNode({ id: "b", position: { x: 0, y: 0 } });
    const doc: CanvasDocument = { nodes: [...wired.nodes, isolated], edges: wired.edges };

    const positions = layoutCanvasDocument(doc);
    const wiredA = positions.get("a");
    const isolatedB = positions.get("b");
    if (wiredA === undefined || isolatedB === undefined) throw new Error("missing position");
    expect(isolatedB.y).toBeGreaterThan(wiredA.y);
    expect(isolatedB.x).toBe(0);
  });

  it("applyLayout returns a new document with updated positions", () => {
    const before = fixLoop;
    const after = applyLayout(before);
    expect(after.nodes.map((node) => node.id)).toEqual(before.nodes.map((node) => node.id));
    expect(after.edges).toEqual(before.edges);
    expect(after.nodes.some((node) => node.position.x !== 0)).toBe(true);
    expect(before.nodes.every((node) => node.position.x === 0)).toBe(true);
  });

  it("respects a top-to-bottom rank direction when asked", () => {
    const tb = layoutCanvasDocument(fixLoop, { rankdir: "TB" });
    const lr = layoutCanvasDocument(fixLoop);
    const first = tb.get("implement");
    const second = tb.get("review");
    if (first === undefined || second === undefined) throw new Error("missing position");
    expect(second.y).toBeGreaterThan(first.y);
    expect(second.x).toBeCloseTo(first.x, 5);
    expect(tb.get("review")).not.toEqual(lr.get("review"));
  });
});
