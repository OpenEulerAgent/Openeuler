import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDGE_MAX_ITERATIONS,
  ExitConditionSchema,
  WorkflowGraphSchema,
  extractOutputReferences,
  graphToLinear,
  linearToGraph,
  renderPromptTemplate,
  summarizeGraph,
} from "./index.js";
import type { GraphEdge, LoopBack, Step, WorkflowGraph } from "./index.js";

const agentNode = (
  id: string,
  over: Partial<Step> = {},
): {
  id: string;
  type: "agent";
  name: string;
  position: { x: number; y: number };
  config: Omit<Step, "id" | "name">;
} => ({
  id,
  type: "agent",
  name: over.name ?? id,
  position: { x: 0, y: 0 },
  config: {
    driver: over.driver ?? "opencode",
    ...(over.model === undefined ? {} : { model: over.model }),
    ...(over.agent === undefined ? {} : { agent: over.agent }),
    mode: over.mode ?? "auto",
    promptTemplate: over.promptTemplate ?? "{{task}}",
    continueSession: over.continueSession ?? false,
  },
});

const exitNode = (
  id = "exit",
): { id: string; type: "exit"; name: string; position: { x: number; y: number } } => ({
  id,
  type: "exit",
  name: "Exit",
  position: { x: 100, y: 0 },
});

const edge = (
  id: string,
  source: string,
  target: string,
  over: Partial<GraphEdge> = {},
): GraphEdge => ({
  id,
  source,
  target,
  condition: over.condition ?? { type: "always" },
  ...(over.order === undefined ? {} : { order: over.order }),
  ...(over.maxIterations === undefined ? {} : { maxIterations: over.maxIterations }),
  ...(over.invert === undefined ? {} : { invert: over.invert }),
});

const validChain = (): Record<string, unknown> => ({
  entryNodeId: "a",
  nodes: [agentNode("a"), agentNode("b"), exitNode()],
  edges: [edge("e1", "a", "b"), edge("e2", "b", "exit")],
});

describe("WorkflowGraphSchema", () => {
  it("parses a valid DAG, defaulting edge conditions to always", () => {
    const graph = {
      entryNodeId: "a",
      nodes: [agentNode("a"), agentNode("b")],
      edges: [{ id: "e1", source: "a", target: "b" }],
    };
    const parsed = WorkflowGraphSchema.parse(graph);
    expect(parsed.edges).toEqual([edge("e1", "a", "b")]);
  });

  it("rejects an entry that references no node, or an exit entry", () => {
    expectIssue(
      { ...validChain(), entryNodeId: "zzz" },
      ["entryNodeId"],
      "does not reference any node",
    );
    expectIssue(
      { ...validChain(), entryNodeId: "exit" },
      ["entryNodeId"],
      "must reference an agent node",
    );
  });

  it("rejects unreachable nodes (all nodes must be reachable from the entry)", () => {
    const graph = {
      entryNodeId: "a",
      nodes: [agentNode("a"), agentNode("b"), agentNode("orphan")],
      edges: [edge("e1", "a", "b"), edge("e2", "orphan", "b")],
    };
    expectIssue(graph, ["nodes", 2], "not reachable from the entry node");
  });

  it("rejects unconditional cycles; conditional cycles parse", () => {
    const unconditional = {
      entryNodeId: "a",
      nodes: [agentNode("a"), agentNode("b")],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "a")],
    };
    expectIssue(unconditional, ["edges"], "unconditional cycle rejected");

    const selfLoop = {
      entryNodeId: "a",
      nodes: [agentNode("a")],
      edges: [edge("e1", "a", "a")],
    };
    expectIssue(selfLoop, ["edges"], "unconditional cycle rejected");

    // Same cycle, but the back edge is conditional: allowed, and the cycle
    // edge gets the default cycle guard.
    const conditional = WorkflowGraphSchema.parse({
      entryNodeId: "a",
      nodes: [agentNode("a"), agentNode("b")],
      edges: [
        edge("e1", "a", "b"),
        edge("e2", "b", "a", { condition: { type: "outputContains", pattern: "RETRY" } }),
      ],
    });
    const back = conditional.edges.find((item) => item.id === "e2");
    expect(back?.maxIterations).toBe(DEFAULT_EDGE_MAX_ITERATIONS);
    // An inverted `always` edge is a never-edge, not an unconditional one:
    // cycles through it are allowed too (legacy `when: always` loopBacks).
    expect(
      WorkflowGraphSchema.safeParse({
        entryNodeId: "a",
        nodes: [agentNode("a"), agentNode("b")],
        edges: [
          edge("e1", "a", "b"),
          edge("e2", "b", "a", { condition: { type: "always" }, invert: true }),
        ],
      }).success,
    ).toBe(true);
  });

  it("accepts fan-out (multiple always outgoing = parallel branches, #115) and rejects mixing", () => {
    const fanOut = {
      entryNodeId: "a",
      nodes: [agentNode("a"), agentNode("b"), agentNode("c"), exitNode()],
      edges: [
        edge("e1", "a", "b"),
        edge("e2", "a", "c"),
        edge("e3", "b", "exit"),
        edge("e4", "c", "exit"),
      ],
    };
    // Legal since #115: each always edge starts a parallel branch.
    expect(WorkflowGraphSchema.safeParse(fanOut).success).toBe(true);

    // Mixing fan-out with routing is ambiguous and rejected.
    expectIssue(
      {
        ...fanOut,
        edges: [
          ...fanOut.edges,
          edge("e5", "a", "exit", { condition: { type: "outputContains", pattern: "x" } }),
        ],
      },
      ["edges"],
      "mixes 2 unconditional (always) outgoing edges with conditional edges",
    );

    // Fan-out branches must be distinct agent nodes.
    expectIssue(
      {
        ...fanOut,
        edges: [edge("e1", "a", "b"), edge("e2", "a", "b"), edge("e3", "b", "exit")],
      },
      ["edges", 1],
      "parallel branches must be distinct nodes",
    );
    expectIssue(
      {
        ...fanOut,
        edges: [edge("e1", "a", "b"), edge("e2", "a", "exit"), edge("e3", "b", "exit")],
      },
      ["edges", 1],
      "parallel branches must start at agent nodes",
    );
  });

  it("validates join nodes (#115): ≥2 incoming, ≤1 unconditional outgoing, no agent fan-in", () => {
    const joinNode = {
      id: "j",
      type: "join" as const,
      name: "Join",
      position: { x: 100, y: 0 },
    };
    const diamond = {
      entryNodeId: "a",
      nodes: [agentNode("a"), agentNode("b"), agentNode("c"), joinNode, agentNode("d"), exitNode()],
      edges: [
        edge("e-ab", "a", "b"),
        edge("e-ac", "a", "c"),
        edge("e-bj", "b", "j"),
        edge("e-cj", "c", "j"),
        edge("e-jd", "j", "d"),
        edge("e-dexit", "d", "exit"),
      ],
    };
    // Parses; the join config defaults to mode "all".
    const parsed = WorkflowGraphSchema.parse(diamond);
    expect(parsed.nodes.find((node) => node.id === "j")).toMatchObject({
      type: "join",
      config: { mode: "all" },
    });
    expect(
      WorkflowGraphSchema.parse({
        ...diamond,
        nodes: diamond.nodes.map((node) =>
          node.id === "j" ? { ...node, config: { mode: "any" as const } } : node,
        ),
      }).nodes.find((node) => node.id === "j"),
    ).toMatchObject({ config: { mode: "any" } });

    // A join with a single incoming merges nothing.
    expectIssue(
      {
        entryNodeId: "a",
        nodes: [agentNode("a"), agentNode("b"), joinNode, exitNode()],
        edges: [edge("e-ab", "a", "b"), edge("e-bj", "b", "j"), edge("e-jx", "j", "exit")],
      },
      ["nodes", 2, "type"],
      "a join merges at least two branches",
    );
    // A join is a synchronizer, not a router: one unconditional outgoing max.
    expectIssue(
      {
        ...diamond,
        edges: [
          ...diamond.edges.filter((item) => item.id !== "e-jd"),
          edge("e-jd", "j", "d"),
          edge("e-jexit", "j", "exit"),
        ],
      },
      ["nodes", 3, "type"],
      "at most one is allowed",
    );
    expectIssue(
      {
        ...diamond,
        edges: [
          ...diamond.edges.filter((item) => item.id !== "e-jd"),
          edge("e-jd", "j", "d", { condition: { type: "outputContains", pattern: "x" } }),
        ],
      },
      ["nodes", 3, "type"],
      "must not have conditional outgoing edges",
    );
    // Parallel always-convergence on an AGENT node is rejected (use a join):
    // b and c share the fan-out ancestor a, so they can deliver concurrently.
    expectIssue(
      {
        entryNodeId: "a",
        nodes: [agentNode("a"), agentNode("b"), agentNode("c"), agentNode("d"), exitNode()],
        edges: [
          edge("e-ab", "a", "b"),
          edge("e-ac", "a", "c"),
          edge("e-bd", "b", "d"),
          edge("e-cd", "c", "d"),
          edge("e-dexit", "d", "exit"),
        ],
      },
      ["nodes", 3, "type"],
      "merge them at a join node instead",
    );
    // ...while SERIAL loop shapes keep parsing: a router node re-entered
    // through an `always` back-edge carries two always-incoming edges that
    // can never deliver concurrently (the shipped starter template).
    expect(
      WorkflowGraphSchema.safeParse({
        entryNodeId: "implement",
        nodes: [agentNode("implement"), agentNode("reviewer"), agentNode("fix"), exitNode()],
        edges: [
          edge("e-ir", "implement", "reviewer"),
          edge("e-approve", "reviewer", "exit", {
            condition: { type: "outputContains", pattern: "LGTM" },
            order: 0,
          }),
          edge("e-rf", "reviewer", "fix", {
            condition: { type: "outputNotContains", pattern: "LGTM" },
            order: 1,
            maxIterations: 3,
          }),
          edge("e-fr", "fix", "reviewer"),
        ],
      }).success,
    ).toBe(true);
    // ...and legacy conditional back-edges parse as before.
    expect(
      WorkflowGraphSchema.safeParse({
        entryNodeId: "a",
        nodes: [agentNode("a"), agentNode("b")],
        edges: [
          edge("e-ab", "a", "b"),
          edge("e-back", "b", "a", { condition: { type: "outputContains", pattern: "RETRY" } }),
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects unconditional cycles through fan-out and join (guarded parallel loops parse)", () => {
    // a fans out to b and j?? no: diamond a→(b,c)→j, with an always back
    // edge j→a: an unconditional cycle — rejected.
    expectIssue(
      {
        entryNodeId: "a",
        nodes: [
          agentNode("a"),
          agentNode("b"),
          agentNode("c"),
          { id: "j", type: "join" as const, name: "J", position: { x: 0, y: 0 } },
        ],
        edges: [
          edge("e-ab", "a", "b"),
          edge("e-ac", "a", "c"),
          edge("e-bj", "b", "j"),
          edge("e-cj", "c", "j"),
          edge("e-ja", "j", "a"),
        ],
      },
      ["edges"],
      "unconditional cycle rejected",
    );
    // The same cycle with a CONDITIONAL back edge parses (the guard makes
    // the parallel loop finite) and picks up the default cycle cap. The
    // conditional edge sits on an AGENT node — a join's single outgoing
    // edge is always unconditional.
    const guarded = WorkflowGraphSchema.parse({
      entryNodeId: "a",
      nodes: [
        agentNode("a"),
        agentNode("b"),
        agentNode("c"),
        { id: "j", type: "join" as const, name: "J", position: { x: 0, y: 0 } },
        agentNode("d"),
      ],
      edges: [
        edge("e-ab", "a", "b"),
        edge("e-ac", "a", "c"),
        edge("e-bj", "b", "j"),
        edge("e-cj", "c", "j"),
        edge("e-jd", "j", "d"),
        edge("e-da", "d", "a", { condition: { type: "outputContains", pattern: "AGAIN" } }),
      ],
    });
    expect(guarded.edges.find((item) => item.id === "e-da")?.maxIterations).toBe(
      DEFAULT_EDGE_MAX_ITERATIONS,
    );
  });

  it("accepts a conditional router (unique orders normalized by array index)", () => {
    const parsed = WorkflowGraphSchema.parse({
      entryNodeId: "a",
      nodes: [agentNode("a"), agentNode("fix"), agentNode("escalate"), exitNode()],
      edges: [
        edge("e1", "a", "fix", {
          condition: { type: "outputContains", pattern: "fail" },
          order: 0,
        }),
        edge("e2", "a", "escalate", { condition: { type: "outputMatches", regex: "blocked" } }),
        edge("e3", "a", "exit"),
        edge("e4", "fix", "exit"),
        edge("e5", "escalate", "exit"),
      ],
    });
    // Absent order defaults to the edges-array index (e2 -> 1); the always
    // fallback edge (e3) is normalized too (index 2).
    expect(parsed.edges.find((item) => item.id === "e2")?.order).toBe(1);
    expect(parsed.edges.find((item) => item.id === "e1")?.order).toBe(0);
    expect(parsed.edges.find((item) => item.id === "e3")?.order).toBe(2);
    // Duplicate explicit orders among conditional siblings are rejected.
    expectIssue(
      {
        entryNodeId: "a",
        nodes: [agentNode("a"), agentNode("b"), agentNode("c"), exitNode()],
        edges: [
          edge("e1", "a", "b", { condition: { type: "outputContains", pattern: "x" }, order: 0 }),
          edge("e2", "a", "c", { condition: { type: "outputContains", pattern: "y" }, order: 0 }),
          edge("e3", "b", "exit"),
          edge("e4", "c", "exit"),
        ],
      },
      ["edges", 1, "order"],
      "must be unique",
    );
  });

  it("rejects exit nodes with outgoing edges and duplicate ids", () => {
    expectIssue(
      {
        entryNodeId: "a",
        nodes: [agentNode("a"), exitNode()],
        edges: [edge("e1", "a", "exit"), edge("e2", "exit", "a")],
      },
      ["nodes", 1, "type"],
      "must not have outgoing edges",
    );
    expectIssue(
      {
        entryNodeId: "a",
        nodes: [agentNode("a"), agentNode("a")],
        edges: [],
      },
      ["nodes", 1, "id"],
      'duplicate node id "a"',
    );
  });

  it("rejects {{output:<nodeId>}} references to non-upstream or unknown nodes", () => {
    // Router: `a` fans out to `b` and `d`; only `b` is upstream of `c`.
    const graph = {
      entryNodeId: "a",
      nodes: [
        agentNode("a"),
        agentNode("b"),
        agentNode("d"),
        agentNode("c", { promptTemplate: "based on {{output:d}}" }),
        exitNode(),
      ],
      edges: [
        edge("e1", "a", "b", { condition: { type: "outputContains", pattern: "x" } }),
        edge("e2", "a", "d"),
        edge("e3", "b", "c"),
        edge("e4", "c", "exit"),
        edge("e5", "d", "exit"),
      ],
    };
    // `d` is reachable from the entry but has no path to `c`.
    expectIssue(graph, ["nodes", 3, "config", "promptTemplate"], 'not an upstream node of "c"');
    // Unknown ids are rejected the same way.
    expectIssue(
      {
        entryNodeId: "a",
        nodes: [agentNode("a"), agentNode("b", { promptTemplate: "{{output:ghost}}" }), exitNode()],
        edges: [edge("e1", "a", "b"), edge("e2", "b", "exit")],
      },
      ["nodes", 1, "config", "promptTemplate"],
      "not an upstream node",
    );
  });

  it("allows {{output:<nodeId>}} references to upstream nodes, including across conditional loops", () => {
    const parsed = WorkflowGraphSchema.safeParse({
      entryNodeId: "impl",
      nodes: [
        agentNode("impl"),
        agentNode("review", { promptTemplate: "re: {{output:impl}} (pass {{iterations}})" }),
        exitNode(),
      ],
      edges: [
        edge("e1", "impl", "review"),
        edge("e2", "review", "impl", {
          condition: { type: "outputNotContains", pattern: "LGTM" },
          maxIterations: 3,
        }),
        edge("e3", "review", "exit"),
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects edges with unknown endpoints and keeps regex compile validation", () => {
    expectIssue(
      {
        entryNodeId: "a",
        nodes: [agentNode("a")],
        edges: [edge("e1", "a", "ghost")],
      },
      ["edges", 0, "target"],
      'unknown target node "ghost"',
    );
    expect(() => ExitConditionSchema.parse({ type: "outputMatches", regex: "([a-z" })).toThrowError(
      /invalid regular expression/,
    );
    // Inverted/negated conditions parse through the full graph schema.
    expect(
      WorkflowGraphSchema.safeParse({
        entryNodeId: "a",
        nodes: [agentNode("a"), agentNode("b"), exitNode()],
        edges: [
          edge("e1", "a", "b"),
          edge("e2", "b", "a", {
            condition: { type: "outputMatches", regex: "^blocked", flags: "im" },
            invert: true,
            maxIterations: 2,
          }),
          edge("e3", "b", "exit"),
        ],
      }).success,
    ).toBe(true);
  });
});

describe("linearToGraph / graphToLinear", () => {
  const steps: Step[] = [
    {
      id: "s1",
      name: "implement",
      driver: "impl",
      mode: "auto",
      promptTemplate: "{{task}}",
      continueSession: false,
    },
    {
      id: "s2",
      name: "review",
      driver: "rev",
      mode: "auto",
      promptTemplate: "rev: {{prevOutput}}",
      continueSession: true,
    },
    {
      id: "s3",
      name: "ship",
      driver: "ship",
      mode: "auto",
      promptTemplate: "ship: {{prevOutput}}",
      continueSession: true,
    },
  ];

  it("converts a chain (no loopBack) into chained always edges plus an exit node", () => {
    const graph = linearToGraph({ steps });
    expect(graph.entryNodeId).toBe("s1");
    expect(graph.nodes.map((node) => node.id)).toEqual(["s1", "s2", "s3", "exit"]);
    expect(graph.nodes.filter((node) => node.type === "exit")).toHaveLength(1);
    expect(graph.edges).toEqual([
      edge("e-s1-s2", "s1", "s2"),
      edge("e-s2-s3", "s2", "s3"),
      edge("e-exit-s3", "s3", "exit"),
    ]);
  });

  it("converts loopBack into a conditional (inverted) loop edge + always exit fallback", () => {
    const loopBack: LoopBack = {
      toStepIndex: 1,
      when: { type: "outputNotContains", pattern: "LGTM" },
      maxIterations: 5,
    };
    const graph = linearToGraph({ steps, loopBack });
    // Loop edge: negated condition (loop while the exit condition is unmet),
    // ordered first; exit edge is the always fallback. Both edges of the
    // s2→s3→s2 cycle carry the loop's guard (default on the chain edge).
    expect(graph.edges).toEqual([
      edge("e-s1-s2", "s1", "s2"),
      edge("e-s2-s3", "s2", "s3", { maxIterations: DEFAULT_EDGE_MAX_ITERATIONS }),
      edge("e-loop-s3-s2", "s3", "s2", {
        condition: { type: "outputContains", pattern: "LGTM" },
        order: 0,
        maxIterations: 5,
      }),
      edge("e-exit-s3", "s3", "exit", { order: 3 }),
    ]);
  });

  it("uses invert:true for loopBack conditions without a direct negation", () => {
    for (const when of [
      { type: "outputMatches", regex: "^done$", flags: "m" },
      { type: "always" },
    ] as const) {
      const graph = linearToGraph({
        steps: [steps[0] as Step],
        loopBack: { toStepIndex: 0, when, maxIterations: 2 },
      });
      const loop = graph.edges.find((item) => item.source === "s1" && item.target === "s1");
      expect(loop).toMatchObject({ condition: when, invert: true, maxIterations: 2 });
    }
  });

  it("avoids exit-node id collisions with step ids", () => {
    const graph = linearToGraph({
      steps: [{ ...(steps[0] as Step), id: "exit" }],
    });
    expect(graph.nodes.map((node) => node.id)).toEqual(["exit", "exit-2"]);
  });

  it("round-trips chain and loop workflows through graphToLinear", () => {
    const loopBack: LoopBack = {
      toStepIndex: 1,
      when: { type: "outputNotContains", pattern: "LGTM" },
      maxIterations: 5,
    };
    const chain = graphToLinear(linearToGraph({ steps }));
    expect(chain).toEqual({ ok: true, steps, loopBack: undefined });

    const loop = graphToLinear(linearToGraph({ steps, loopBack }));
    expect(loop).toEqual({ ok: true, steps, loopBack });
  });

  it("round-trips every exit-condition shape", () => {
    const whens = [
      { type: "outputContains", pattern: "ok" },
      { type: "outputNotContains", pattern: "LGTM" },
      { type: "outputMatches", regex: "^ready$", flags: "im" },
      { type: "always" },
    ] as const;
    for (const when of whens) {
      const loopBack: LoopBack = { toStepIndex: 0, when, maxIterations: 4 };
      const result = graphToLinear(linearToGraph({ steps: [steps[0] as Step], loopBack }));
      expect(result).toEqual({ ok: true, steps: [steps[0]], loopBack });
    }
  });

  it("rejects graphs that are not a simple chain + single loop", () => {
    // Router: two conditional outgoing edges from one node.
    const router = linearToGraph({ steps });
    const mutated: WorkflowGraph = {
      ...router,
      nodes: [...router.nodes, agentNode("escalate")],
      edges: [
        ...router.edges,
        edge("e-esc", "s3", "escalate", { condition: { type: "outputMatches", regex: "help" } }),
        edge("e-esc-exit", "escalate", "exit"),
      ],
    };
    const result = graphToLinear(mutated);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no legacy representation");

    // {{output:<nodeId>}} templates cannot run on the linear engine.
    const templated = linearToGraph({
      steps: [steps[0] as Step, { ...(steps[1] as Step), promptTemplate: "re: {{output:s1}}" }],
    });
    const templatedResult = graphToLinear(templated);
    expect(templatedResult.ok).toBe(false);
    if (!templatedResult.ok) expect(templatedResult.reason).toContain("{{output:");
  });
});

describe("summarizeGraph (list read model, #70)", () => {
  const steps: Step[] = [
    {
      id: "s1",
      name: "implement",
      driver: "impl",
      mode: "auto",
      promptTemplate: "{{task}}",
      continueSession: false,
    },
    {
      id: "s2",
      name: "review",
      driver: "rev",
      mode: "auto",
      promptTemplate: "rev: {{prevOutput}}",
      continueSession: true,
    },
    {
      id: "s3",
      name: "ship",
      driver: "ship",
      mode: "auto",
      promptTemplate: "ship: {{prevOutput}}",
      continueSession: true,
    },
  ];

  it("counts nodes/edges of a linear chain with no loop and no router", () => {
    const graph = linearToGraph({ steps });
    expect(summarizeGraph(graph, 1)).toEqual({
      nodeCount: 4,
      edgeCount: 3,
      hasLoop: false,
      hasRouter: false,
      hasFanOut: false,
      revision: 1,
    });
  });

  it("flags the conditional loop-back + router of a legacy loop workflow", () => {
    const graph = linearToGraph({
      steps,
      loopBack: {
        toStepIndex: 1,
        when: { type: "outputNotContains", pattern: "LGTM" },
        maxIterations: 5,
      },
    });
    // The last node routes (loop edge + always exit) and the s3→s2 back-edge
    // closes a conditional cycle.
    expect(summarizeGraph(graph, 7)).toEqual({
      nodeCount: 4,
      edgeCount: 4,
      hasLoop: true,
      hasRouter: true,
      hasFanOut: false,
      revision: 7,
    });
  });

  it("flags routers and conditional back-edges on branchy graphs", () => {
    const graph = WorkflowGraphSchema.parse({
      entryNodeId: "n1",
      nodes: [agentNode("n1"), agentNode("n2"), exitNode()],
      edges: [
        edge("e-review", "n1", "n2", { condition: { type: "outputContains", pattern: "GO" } }),
        edge("e-exit", "n1", "exit"),
        edge("e-loop", "n2", "n1", { condition: { type: "outputNotContains", pattern: "DONE" } }),
      ],
    });
    expect(summarizeGraph(graph, 2)).toEqual({
      nodeCount: 3,
      edgeCount: 3,
      hasLoop: true,
      hasRouter: true,
      hasFanOut: false,
      revision: 2,
    });
  });

  it("detects self-loops", () => {
    const graph = WorkflowGraphSchema.parse({
      entryNodeId: "n1",
      nodes: [agentNode("n1"), exitNode()],
      edges: [
        edge("e-self", "n1", "n1", { condition: { type: "outputContains", pattern: "AGAIN" } }),
        edge("e-exit", "n1", "exit"),
      ],
    });
    expect(summarizeGraph(graph, 1)).toEqual({
      nodeCount: 2,
      edgeCount: 2,
      hasLoop: true,
      hasRouter: true,
      hasFanOut: false,
      revision: 1,
    });
  });
});

describe("renderPromptTemplate ({{output:<nodeId>}})", () => {
  it("renders node outputs and keeps the legacy variables", () => {
    expect(
      renderPromptTemplate("{{output:impl}} then {{task}} ({{iterations}})", {
        task: "t",
        iterations: 2,
        outputs: { impl: "IMPL-OUT" },
      }),
    ).toBe("IMPL-OUT then t (2)");
  });

  it("prevOutput stays the direct-predecessor alias", () => {
    expect(
      renderPromptTemplate("{{prevOutput}}", { prevOutput: "P", outputs: { impl: "I" } }),
    ).toBe("P");
  });

  it("throws a clear error on a missing node output", () => {
    expect(() => renderPromptTemplate("{{output:ghost}}", { outputs: { impl: "I" } })).toThrowError(
      /no output for node "ghost" was provided \(available: impl\)/,
    );
    expect(() => renderPromptTemplate("{{output:impl}}", {})).toThrowError(
      /no output for node "impl" was provided \(available: none\)/,
    );
  });

  it("throws on {{output}} without a node id and lists the variable grammar", () => {
    expect(() => renderPromptTemplate("{{ output: }}", {})).not.toThrowError(); // no token match: literal
    expect(() => renderPromptTemplate("{{task}} {{unknown}}", {})).toThrowError(
      /Unknown prompt template variable \{\{unknown\}\}.*\{\{output:<nodeId>\}\}/s,
    );
  });

  it("extractOutputReferences lists referenced node ids", () => {
    expect(extractOutputReferences("{{output:a}} {{task}} {{ output:b }}")).toEqual(["a", "b"]);
    expect(extractOutputReferences("{{task}}")).toEqual([]);
  });
});

/** Asserts the graph schema rejects `input` with an issue at `path`. */
function expectIssue(input: unknown, path: (string | number)[], fragment: string): void {
  const result = WorkflowGraphSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    const issue = result.error.issues.find((item) =>
      path.every((key, index) => item.path[index] === key),
    );
    expect(
      issue,
      `expected an issue at ${path.join(".")}, got ${JSON.stringify(
        result.error.issues.map((i) => ({ path: i.path, message: i.message })),
      )}`,
    ).toBeDefined();
    expect(issue?.message).toContain(fragment);
  }
}
