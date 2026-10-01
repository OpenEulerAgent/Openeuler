import { describe, expect, it, vi } from "vitest";
import type { StepConfig, Workflow, WorkflowGraph } from "@openeuler/core";
import type { CanvasDocument } from "@/lib/graph/canvas-document";
import { toCanvasDocument } from "@/lib/graph/canvas-document";
import {
  fetchWorkflowRevision,
  liveEdgeVisuals,
  liveNodeVisuals,
  resolveRunGraphDocument,
  toRunFlowEdges,
  toRunFlowNodes,
  type RunGraphSource,
} from "./document";
import { buildRunGraphState, foldRunGraphEvent } from "./fold";
import { replayAsOf } from "./replay";
import { replayEdgeVisuals, replayNodeVisuals } from "./document";
import type { RunStreamEvent } from "@/lib/run-events";

const config: StepConfig = {
  driver: "fake",
  mode: "auto",
  promptTemplate: "{{task}}",
  continueSession: false,
};

const graph: WorkflowGraph = {
  entryNodeId: "a",
  nodes: [
    { id: "a", type: "agent", name: "Agent A", position: { x: 0, y: 0 }, config },
    { id: "b", type: "agent", name: "Agent B", position: { x: 280, y: 0 }, config },
    { id: "exit", type: "exit", name: "Exit", position: { x: 560, y: 0 } },
  ],
  edges: [
    { id: "e-a-b", source: "a", target: "b", condition: { type: "always" } },
    {
      id: "e-loop-b-a",
      source: "b",
      target: "a",
      condition: { type: "outputNotContains", pattern: "done" },
      order: 0,
      maxIterations: 3,
    },
    { id: "e-b-exit", source: "b", target: "exit", condition: { type: "always" } },
  ],
};

const legacyWorkflow: Workflow = {
  id: "wf-1",
  projectId: "p-1",
  name: "legacy",
  steps: [
    {
      id: "s1",
      name: "Step 1",
      driver: "fake",
      mode: "auto",
      promptTemplate: "x",
      continueSession: false,
    },
    {
      id: "s2",
      name: "Step 2",
      driver: "fake",
      mode: "auto",
      promptTemplate: "y",
      continueSession: false,
    },
  ],
  loopBack: { toStepIndex: 0, when: { type: "always" }, maxIterations: 2 },
};

describe("fetchWorkflowRevision", () => {
  it("GETs the revision snapshot and unwraps its graph", async () => {
    const fetcher = vi.fn().mockResolvedValue({ revision: { id: "r1", number: 2, graph } });
    const result = await fetchWorkflowRevision("wf-1", 2, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/workflows/wf-1/revisions/2");
    expect(result).toBe(graph);
  });
});

describe("resolveRunGraphDocument", () => {
  const fetchWorkflow = vi.fn(async () => legacyWorkflow);

  it("pins the run's revision snapshot (positions included)", async () => {
    const fetchRevision = vi.fn(async () => graph);
    const resolved = await resolveRunGraphDocument(
      { workflowId: "wf-1", workflowRevision: { id: "rev-1", number: 2 } },
      fetchWorkflow,
      fetchRevision,
    );
    expect(resolved).toMatchObject({ kind: "revision", revisionNumber: 2 });
    if (resolved.kind !== "revision") return;
    expect(resolved.doc.nodes.map((node) => node.id)).toEqual(["a", "b", "exit"]);
    expect(resolved.doc.edges).toHaveLength(3);
  });

  it("falls back to the workflow's current shape for legacy (unpinned) runs", async () => {
    const resolved = await resolveRunGraphDocument(
      { workflowId: "wf-1", workflowRevision: undefined },
      fetchWorkflow,
      vi.fn(),
    );
    expect(resolved.kind).toBe("legacy");
    if (resolved.kind !== "legacy") return;
    // linearToGraph: chain s1 → s2 → exit with a loop edge s2 → s1.
    expect(resolved.doc.nodes.map((node) => node.id)).toEqual(["s1", "s2", "exit"]);
    expect(resolved.doc.edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
      "s1->s2",
      "s2->s1",
      "s2->exit",
    ]);
  });

  it("degrades gracefully when the snapshot and the workflow both fail", async () => {
    const resolved = await resolveRunGraphDocument(
      { workflowId: "wf-1", workflowRevision: { id: "rev-1", number: 1 } },
      vi.fn().mockRejectedValue(new Error("gone")),
      vi.fn().mockRejectedValue(new Error("gone")),
    );
    expect(resolved).toEqual({ kind: "adhoc" });
  });

  it("reports ad-hoc runs (no workflow) as graph-less", async () => {
    const source: RunGraphSource = {};
    expect(await resolveRunGraphDocument(source, fetchWorkflow, vi.fn())).toEqual({
      kind: "adhoc",
    });
  });
});

// -------------------------------------------------------------------------
// React Flow projections.
//

const doc: CanvasDocument = toCanvasDocument(graph);

const runEvents: RunStreamEvent[] = [
  { type: "node.queued", seq: 0, nodeId: "a", nodeName: "Agent A", iteration: 1 },
  { type: "node.started", seq: 1, nodeId: "a", nodeName: "Agent A", iteration: 1 },
  {
    type: "node.completed",
    seq: 2,
    nodeId: "a",
    nodeName: "Agent A",
    iteration: 1,
    status: "success" as const,
    output: "ok",
    durationMs: 5,
  },
  {
    type: "edge.taken",
    seq: 3,
    edgeId: "e-a-b",
    source: "a",
    target: "b",
    matchedCondition: "always",
    iteration: 1,
  },
  { type: "node.queued", seq: 4, nodeId: "b", nodeName: "Agent B", iteration: 1 },
  { type: "node.started", seq: 5, nodeId: "b", nodeName: "Agent B", iteration: 1 },
  {
    type: "edge.cap-reached",
    seq: 6,
    edgeId: "e-loop-b-a",
    source: "b",
    target: "a",
    taken: 3,
    maxIterations: 3,
  },
];

describe("toRunFlowNodes", () => {
  it("marks every node read-only and carries its visual slice via data", () => {
    const state = buildRunGraphState(runEvents);
    const nodes = toRunFlowNodes(doc, liveNodeVisuals(state));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    expect(byId.get("a")).toMatchObject({
      type: "run-agent",
      draggable: false,
      connectable: false,
      deletable: false,
      data: { visual: { status: "success", executionCount: 1 } },
    });
    expect(byId.get("b")?.data).toMatchObject({ visual: { status: "running" } });
    expect(byId.get("exit")).toMatchObject({ type: "run-exit", data: { visual: null } });
  });

  it("keeps node data identity for untouched nodes (memoized cards)", () => {
    const state = buildRunGraphState(runEvents);
    const before = toRunFlowNodes(doc, liveNodeVisuals(state));
    // Fold one more event INTO THE SAME state (the live path): b changes,
    // a keeps its sub-state object and therefore its node data identity.
    const next = foldRunGraphEvent(state, {
      type: "node.queued",
      seq: 7,
      nodeId: "b",
      nodeName: "Agent B",
      iteration: 2,
    });
    const after = toRunFlowNodes(doc, liveNodeVisuals(next));
    const find = (nodes: typeof before, id: string) =>
      nodes.find((node) => node.id === id) as (typeof before)[number];
    expect(find(after, "a").data).toBe(find(before, "a").data);
    expect(find(after, "b").data).not.toBe(find(before, "b").data);
  });
});

describe("toRunFlowEdges", () => {
  it("styles untaken faint, taken solid, the last taken edge marching, cap edges warning", () => {
    const state = buildRunGraphState(runEvents);
    const edges = toRunFlowEdges(doc, liveEdgeVisuals(state));
    const byId = new Map(edges.map((edge) => [edge.id, edge]));
    expect(byId.get("e-a-b")).toMatchObject({
      className: "run-edge-active",
      style: { stroke: "var(--accent)", strokeWidth: 2.5, opacity: 1 },
    });
    expect(byId.get("e-b-exit")?.style).toMatchObject({ opacity: 0.35 });
    expect(byId.get("e-loop-b-a")).toMatchObject({
      className: "run-edge-cap",
      style: { stroke: "var(--warning)" },
    });
  });

  it("projects replay edge visuals the same way", () => {
    const state = buildRunGraphState(runEvents);
    const view = replayAsOf(state, 1); // at the e-a-b traversal
    expect(view).not.toBeNull();
    const edges = toRunFlowEdges(doc, replayEdgeVisuals(state, view!));
    const byId = new Map(edges.map((edge) => [edge.id, edge]));
    expect(byId.get("e-a-b")).toMatchObject({ className: "run-edge-active" });
    expect(byId.get("e-loop-b-a")?.style).toMatchObject({ opacity: 0.35 });
  });

  it("labels conditional edges with their condition summary", () => {
    const edges = toRunFlowEdges(doc, {});
    const loop = edges.find((edge) => edge.id === "e-loop-b-a");
    expect(loop?.label).toBe('not-contains "done"');
    expect(edges.find((edge) => edge.id === "e-a-b")?.label).toBeUndefined();
  });

  it("replay node visuals map back into node data", () => {
    const state = buildRunGraphState(runEvents);
    const view = replayAsOf(state, 1); // e-a-b taken: b queued ahead
    expect(view).not.toBeNull();
    const nodes = toRunFlowNodes(doc, replayNodeVisuals(view!));
    const b = nodes.find((node) => node.id === "b");
    expect(b?.data).toMatchObject({ visual: { status: "queued" } });
  });
});

describe("20-node render path (perf smoke, #52)", () => {
  /** Chain n01..n20 → exit, every node executing once (as the fake driver does). */
  const chain: WorkflowGraph = {
    entryNodeId: "n01",
    nodes: [
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `n${String(i + 1).padStart(2, "0")}`,
        type: "agent" as const,
        name: `Node ${i + 1}`,
        position: { x: i * 260, y: 160 },
        config,
      })),
      { id: "exit", type: "exit" as const, name: "Exit", position: { x: 20 * 260, y: 160 } },
    ],
    edges: [
      ...Array.from({ length: 19 }, (_, i) => ({
        id: `e-${i}`,
        source: `n${String(i + 1).padStart(2, "0")}`,
        target: `n${String(i + 2).padStart(2, "0")}`,
        condition: { type: "always" as const },
      })),
      { id: "e-exit", source: "n20", target: "exit", condition: { type: "always" as const } },
    ],
  };

  const chainDoc = toCanvasDocument(chain);
  const chainEvents: RunStreamEvent[] = [];
  let chainSeq = 0;
  const chainEdgeTaken = (edgeId: string, source: string, target: string): void => {
    chainEvents.push({
      type: "edge.taken",
      seq: chainSeq++,
      edgeId,
      source,
      target,
      matchedCondition: "always",
      iteration: 1,
    });
  };
  for (let i = 1; i <= 20; i += 1) {
    const id = `n${String(i).padStart(2, "0")}`;
    chainEvents.push(
      { type: "node.queued", seq: chainSeq++, nodeId: id, nodeName: `Node ${i}`, iteration: 1 },
      { type: "node.started", seq: chainSeq++, nodeId: id, nodeName: `Node ${i}`, iteration: 1 },
      {
        type: "node.completed",
        seq: chainSeq++,
        nodeId: id,
        nodeName: `Node ${i}`,
        iteration: 1,
        status: "success",
        output: "ok",
        durationMs: 5,
      },
    );
    if (i < 20) {
      chainEdgeTaken(`e-${i - 1}`, id, `n${String(i + 1).padStart(2, "0")}`);
    } else {
      chainEdgeTaken("e-exit", id, "exit");
    }
  }

  it("folds a 20-node execution stream and projects the full render path completely", () => {
    const state = buildRunGraphState(chainEvents);
    expect(state.totalExecutions).toBe(20);

    const nodes = toRunFlowNodes(chainDoc, liveNodeVisuals(state));
    const edges = toRunFlowEdges(chainDoc, liveEdgeVisuals(state));
    // Every node carries a visual slice; every chain edge is taken with the
    // last one animating; nothing dropped.
    const withVisuals = nodes.filter(
      (node) =>
        (node.data as { visual?: unknown }).visual !== null &&
        (node.data as { visual?: unknown }).visual !== undefined,
    );
    expect(withVisuals).toHaveLength(20);
    expect(nodes).toHaveLength(21); // + exit (visual null → not-reached until the exit edge)
    expect(edges.filter((edge) => edge.style?.opacity === 1)).toHaveLength(20);
    expect(edges.find((edge) => edge.id === "e-exit")).toMatchObject({
      className: "run-edge-active",
    });
  });
});
