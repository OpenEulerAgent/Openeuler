import { describe, expect, it } from "vitest";
import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import {
  WorkflowGraphSchema,
  linearToGraph,
  type GraphEdge,
  type Step,
  type WorkflowGraph,
} from "@openeuler/core";
import {
  canvasDocsEquivalent,
  canvasEdgeId,
  fromCanvasDocument,
  starterGraph,
  toCanvasDocument,
  workflowToCanvasDocument,
  type CanvasDocument,
  type CanvasNode,
} from "./canvas-document";

function agent(
  id: string,
  name: string,
  position: { x: number; y: number },
  extra: {
    promptTemplate?: string;
    driver?: string;
    model?: string;
    continueSession?: boolean;
  } = {},
): WorkflowGraph["nodes"][number] {
  return {
    id,
    type: "agent",
    name,
    position,
    config: {
      driver: extra.driver ?? "opencode",
      ...(extra.model === undefined ? {} : { model: extra.model }),
      mode: "auto",
      promptTemplate: extra.promptTemplate ?? `do ${id}: {{task}}`,
      continueSession: extra.continueSession ?? false,
    },
  };
}

function exit(id: string, position: { x: number; y: number }): WorkflowGraph["nodes"][number] {
  return { id, type: "exit", name: "Exit", position };
}

function edge(
  source: string,
  target: string,
  extra: Partial<Omit<GraphEdge, "id" | "source" | "target">> = {},
): GraphEdge {
  return {
    id: canvasEdgeId(source, target),
    source,
    target,
    condition: { type: "always" },
    ...extra,
  };
}

/** "implement → review → conditional fix loop": the issue's canonical graph. */
function fixLoopGraph(): WorkflowGraph {
  return WorkflowGraphSchema.parse({
    entryNodeId: "implement",
    nodes: [
      agent("implement", "implement", { x: 0, y: 0 }),
      agent(
        "review",
        "review",
        { x: 300, y: 0 },
        { promptTemplate: "review: {{output:implement}}" },
      ),
      exit("exit", { x: 600, y: 0 }),
    ],
    edges: [
      edge("implement", "review"),
      edge("review", "exit", {
        condition: { type: "outputContains", pattern: "APPROVED" },
        order: 0,
      }),
      edge("review", "implement", {
        condition: { type: "outputNotContains", pattern: "APPROVED" },
        order: 1,
        maxIterations: 3,
      }),
    ],
  });
}

function chainGraph(): WorkflowGraph {
  return linearToGraph({
    steps: [
      {
        id: "s1",
        name: "one",
        driver: "opencode",
        mode: "auto",
        promptTemplate: "{{task}}",
        continueSession: false,
      },
      {
        id: "s2",
        name: "two",
        driver: "opencode",
        mode: "ask",
        promptTemplate: "check {{output:s1}}",
        continueSession: true,
      },
    ],
  });
}

/** Router: one node fanning out over conditionals with an always fallback. */
function routerGraph(): WorkflowGraph {
  return WorkflowGraphSchema.parse({
    entryNodeId: "triage",
    nodes: [
      agent("triage", "triage", { x: 0, y: 0 }),
      agent("fix", "fix", { x: 300, y: -120 }),
      agent("docs", "docs", { x: 300, y: 120 }, { model: "big" }),
      exit("done", { x: 600, y: 0 }),
    ],
    edges: [
      edge("triage", "fix", {
        condition: { type: "outputMatches", regex: "fail", flags: "i" },
        order: 0,
      }),
      edge("triage", "docs", {
        condition: { type: "outputContains", pattern: "docs" },
        order: 1,
        invert: true,
      }),
      edge("triage", "done"),
      edge("fix", "done", { maxIterations: 2 }),
      edge("docs", "done"),
    ],
  });
}

/** Self-loop: the tightest cycle shape. */
function selfLoopGraph(): WorkflowGraph {
  return WorkflowGraphSchema.parse({
    entryNodeId: "n1",
    nodes: [agent("n1", "refine", { x: 0, y: 0 }), exit("x", { x: 300, y: 0 })],
    edges: [
      edge("n1", "n1", {
        condition: { type: "outputNotContains", pattern: "done" },
        order: 0,
        maxIterations: 5,
      }),
      edge("n1", "x", { order: 1 }),
    ],
  });
}

const CASES: Array<[string, () => WorkflowGraph]> = [
  ["implement → review → conditional fix loop", fixLoopGraph],
  ["chain (legacy translation)", chainGraph],
  ["router with always fallback", routerGraph],
  ["self-loop", selfLoopGraph],
  ["single entry node", () => WorkflowGraphSchema.parse(starterGraph())],
];

describe("canvas serialization round-trip", () => {
  for (const [label, build] of CASES) {
    it(`graph → canvas → graph is identity (${label})`, () => {
      const graph = build();
      expect(fromCanvasDocument(toCanvasDocument(graph))).toEqual(graph);
    });

    it(`reload identity: canvas → graph → canvas is stable (${label})`, () => {
      const graph = build();
      const once = toCanvasDocument(graph);
      expect(toCanvasDocument(fromCanvasDocument(once))).toEqual(once);
    });

    it(`is deterministic across repeated cycles (${label})`, () => {
      const graph = build();
      const twice = toCanvasDocument(fromCanvasDocument(toCanvasDocument(graph)));
      const thrice = toCanvasDocument(fromCanvasDocument(twice));
      expect(twice).toEqual(thrice);
    });
  }

  it("marks exactly the entryNodeId agent as the entry", () => {
    const doc = toCanvasDocument(fixLoopGraph());
    const entries = doc.nodes.filter((node) => node.data.kind === "agent" && node.data.isEntry);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("implement");
  });

  it("preserves edge conditions, orders, iteration caps and inverts", () => {
    const doc = toCanvasDocument(routerGraph());
    const inverted = doc.edges.find((candidate) => candidate.data.invert === true);
    expect(inverted?.source).toBe("triage");
    expect(inverted?.data.condition).toEqual({ type: "outputContains", pattern: "docs" });
    const capped = doc.edges.find((candidate) => candidate.data.maxIterations === 2);
    expect(capped?.source).toBe("fix");
    expect(capped?.target).toBe("done");
  });

  it("workflowToCanvasDocument prefers the served graph revision", () => {
    const graph = fixLoopGraph();
    const legacySteps: Step[] = [
      {
        id: "legacy",
        name: "legacy mirror",
        driver: "opencode",
        mode: "auto",
        promptTemplate: "{{task}}",
        continueSession: false,
      },
    ];
    const doc = workflowToCanvasDocument({
      id: "w1",
      projectId: "p1",
      name: "w",
      steps: legacySteps,
      latestRevision: { id: "r1", number: 2 },
      graph,
    });
    expect(doc.nodes.map((node) => node.id)).toEqual(["implement", "review", "exit"]);
  });

  it("workflowToCanvasDocument falls back to the legacy steps translation", () => {
    const doc = workflowToCanvasDocument({
      id: "w1",
      projectId: "p1",
      name: "w",
      steps: [
        {
          id: "s1",
          name: "one",
          driver: "opencode",
          mode: "auto",
          promptTemplate: "{{task}}",
          continueSession: false,
        },
      ] satisfies Step[],
    });
    expect(fromCanvasDocument(doc).nodes[0]?.id).toBe("s1");
    expect(doc.nodes.some((node) => node.data.kind === "agent" && node.data.isEntry)).toBe(true);
  });
});

describe("editor dirty tracking (normalized projections)", () => {
  it("React Flow runtime keys from measured/select changes never read as dirty", () => {
    const saved = toCanvasDocument(fixLoopGraph());
    // What React Flow writes onto nodes: `measured`/`resizing` from dimension
    // changes, `selected` from clicks, `dragging` from position changes.
    const exitPosition = saved.nodes[2]!.position;
    const runtimeTouched = {
      nodes: applyNodeChanges(
        [
          {
            type: "dimensions",
            id: "implement",
            dimensions: { width: 240, height: 96 },
            measured: { width: 240, height: 96 },
            resizing: true,
          },
          { type: "select", id: "review", selected: true },
          { type: "position", id: "exit", position: exitPosition, dragging: false },
        ] as unknown as NodeChange<CanvasNode>[],
        saved.nodes,
      ),
      edges: saved.edges.map((edge) => ({ ...edge, selected: true })),
    } satisfies CanvasDocument;
    expect(canvasDocsEquivalent(runtimeTouched, saved)).toBe(true);
  });

  it("a real edit still reads as dirty", () => {
    const saved = toCanvasDocument(fixLoopGraph());
    const moved: CanvasDocument = {
      ...saved,
      nodes: saved.nodes.map((node) =>
        node.id === "review" ? { ...node, position: { x: 999, y: 999 } } : node,
      ),
    };
    expect(canvasDocsEquivalent(moved, saved)).toBe(false);

    const relabeled: CanvasDocument = {
      ...saved,
      edges: saved.edges.map((edge) =>
        edge.id === "e-review-exit"
          ? {
              ...edge,
              data: { ...edge.data, condition: { type: "outputContains", pattern: "APPROVED!" } },
            }
          : edge,
      ),
    };
    expect(canvasDocsEquivalent(relabeled, saved)).toBe(false);
  });
});
