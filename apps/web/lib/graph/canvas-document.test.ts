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
  createAgentNode,
  createJoinNode,
  createPresetAgentNode,
  DEFAULT_AGENT_PROMPT_TEMPLATE,
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

/**
 * Diamond (#116): entry fans out unconditionally over two branches that
 * converge at a `join` (mode any) before the exit — the canonical
 * fan-out/join shape the canvas has to serialize, persist and re-serve.
 */
function diamondGraph(mode: "all" | "any" = "any"): WorkflowGraph {
  return WorkflowGraphSchema.parse({
    entryNodeId: "split",
    nodes: [
      agent("split", "split", { x: 0, y: 0 }),
      agent("left", "left", { x: 300, y: -120 }),
      agent("right", "right", { x: 300, y: 120 }),
      {
        id: "j",
        type: "join",
        name: "Merge",
        position: { x: 600, y: 0 },
        config: { mode },
      },
      exit("x", { x: 900, y: 0 }),
    ],
    edges: [
      edge("split", "left"),
      edge("split", "right"),
      edge("left", "j"),
      edge("right", "j"),
      edge("j", "x"),
    ],
  });
}

const CASES: Array<[string, () => WorkflowGraph]> = [
  ["implement → review → conditional fix loop", fixLoopGraph],
  ["chain (legacy translation)", chainGraph],
  ["router with always fallback", routerGraph],
  ["self-loop", selfLoopGraph],
  ["diamond fan-out → join (mode any)", () => diamondGraph("any")],
  ["diamond fan-out → join (mode all)", () => diamondGraph("all")],
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

  it("join mode survives the round-trip and re-parsing (persist path, #116)", () => {
    for (const mode of ["all", "any"] as const) {
      const graph = diamondGraph(mode);
      // graph → canvas: the join keeps kind, name and its mode config.
      const doc = toCanvasDocument(graph);
      const join = doc.nodes.find((node) => node.data.kind === "join");
      expect(join).toMatchObject({
        id: "j",
        type: "join",
        data: { kind: "join", name: "Merge", config: { mode } },
      });
      // canvas → graph → schema: the persisted shape re-validates and the
      // mode is still there (what the daemon stores and re-serves).
      const roundTrip = fromCanvasDocument(doc);
      expect(roundTrip).toEqual(graph);
      const reparsed = WorkflowGraphSchema.parse(roundTrip);
      expect(reparsed.nodes.find((node) => node.type === "join")).toMatchObject({
        config: { mode },
      });
    }
  });

  it("createJoinNode: palette defaults are mode all, name/position/mode overridable (#116)", () => {
    const drop = createJoinNode();
    expect(drop.type).toBe("join");
    expect(drop.data).toEqual({ kind: "join", name: "Join", config: { mode: "all" } });
    expect(drop.id).toMatch(/[\w-]{36}/); // crypto.randomUUID

    const spot = { x: 480, y: 120 };
    const named = createJoinNode(spot, "Merge 2", "any");
    expect(named.position).toEqual(spot);
    expect(named.data).toEqual({ kind: "join", name: "Merge 2", config: { mode: "any" } });

    // A dropped join is one wiring step from valid: it passes the save-time
    // schema as soon as its edges exist (two in, one unconditional out).
    const wired = WorkflowGraphSchema.parse({
      entryNodeId: "a",
      nodes: [
        agent("a", "a", { x: 0, y: 0 }),
        agent("b", "b", { x: 300, y: -120 }),
        agent("c", "c", { x: 300, y: 120 }),
        {
          id: "j",
          type: "join",
          name: named.data.name,
          position: { x: 600, y: 0 },
          config: named.data.config,
        },
        exit("x", { x: 900, y: 0 }),
      ],
      edges: [edge("a", "b"), edge("a", "c"), edge("b", "j"), edge("c", "j"), edge("j", "x")],
    });
    expect(wired.nodes.find((node) => node.id === "j")).toMatchObject({
      type: "join",
      config: { mode: "any" },
    });
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

describe("palette-drop prompt prefill (#68)", () => {
  it("createAgentNode prefills a {{task}}-based default prompt", () => {
    const node = createAgentNode();
    expect(node.data.kind).toBe("agent");
    if (node.data.kind !== "agent") throw new Error("unreachable");
    expect(node.data.config.promptTemplate).toBe(DEFAULT_AGENT_PROMPT_TEMPLATE);
    expect(node.data.config.promptTemplate).toContain("{{task}}");
  });

  it("the default prompt parses under the save-time schema (one connection from valid)", () => {
    const doc: CanvasDocument = {
      nodes: [createAgentNode({ id: "entry", isEntry: true }), createAgentNode({ id: "next" })],
      edges: [
        {
          id: "e-entry-next",
          source: "entry",
          target: "next",
          data: { condition: { type: "always" } },
        },
      ],
    };
    expect(() => WorkflowGraphSchema.parse(fromCanvasDocument(doc))).not.toThrow();
  });

  it("preset drops keep the preset's prompt, but fall back to the default when empty", () => {
    const withPrompt = createPresetAgentNode({
      preset: {
        id: "p1",
        name: "Reviewer",
        config: {
          driver: "opencode",
          mode: "auto",
          promptTemplate: "review: {{task}}",
          continueSession: false,
        },
      },
    });
    if (withPrompt.data.kind !== "agent") throw new Error("unreachable");
    expect(withPrompt.data.config.promptTemplate).toBe("review: {{task}}");

    const withEmpty = createPresetAgentNode({
      preset: {
        id: "p2",
        name: "Blank",
        config: {
          driver: "opencode",
          mode: "auto",
          promptTemplate: "",
          continueSession: false,
        },
      },
    });
    if (withEmpty.data.kind !== "agent") throw new Error("unreachable");
    expect(withEmpty.data.config.promptTemplate).toBe(DEFAULT_AGENT_PROMPT_TEMPLATE);
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
