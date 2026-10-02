import { describe, expect, it } from "vitest";
import type { ApiErrorDetail } from "../api";
import {
  createAgentNode,
  createExitNode,
  type CanvasDocument,
  type CanvasNode,
} from "./canvas-document";
import { applyConnect, checkConnect } from "./canvas-ops";
import {
  validateCanvasDocument,
  issuesFromApiDetails,
  issuesForEdge,
  issuesForNode,
  classifyIssue,
  issueHint,
  dedupeIssues,
  severitySummary,
  splitIssuesBySeverity,
  UNREACHABLE_HINT,
  MISSING_CONDITION_HINT,
  type CanvasIssue,
} from "./validation";

function node(
  id: string,
  options: { isEntry?: boolean; promptTemplate?: string; position?: { x: number; y: number } } = {},
): CanvasNode {
  const base = createAgentNode({
    id,
    isEntry: options.isEntry ?? false,
    position: options.position ?? { x: 0, y: 0 },
  });
  if (base.data.kind !== "agent") throw new Error("expected an agent node");
  return {
    ...base,
    data: {
      ...base.data,
      name: id,
      config: { ...base.data.config, promptTemplate: options.promptTemplate ?? `work: {{task}}` },
    },
  };
}

function exit(id: string, position = { x: 900, y: 0 }): CanvasNode {
  return { ...createExitNode(position), id, data: { kind: "exit", name: "Exit" } };
}

function edge(
  source: string,
  target: string,
  condition: "always" | { pattern: string },
): CanvasDocument["edges"][number] {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    data: {
      condition:
        condition === "always"
          ? { type: "always" }
          : { type: "outputContains", pattern: condition.pattern },
    },
  };
}

describe("validateCanvasDocument", () => {
  it("accepts a clean chain and the save is unblocked (no issues)", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), node("b", { position: { x: 300, y: 0 } }), exit("x")],
      edges: [edge("a", "b", "always"), edge("b", "x", "always")],
    };
    expect(validateCanvasDocument(doc)).toEqual([]);
  });

  it("flags an unconditional cycle on the offending edge", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), node("b", { position: { x: 300, y: 0 } })],
      edges: [edge("a", "b", "always"), edge("b", "a", "always")],
    };
    const issues = validateCanvasDocument(doc);
    expect(issues.length).toBeGreaterThan(0);
    const cycle = issues.find((issue) => issue.message.includes("unconditional cycle"));
    expect(cycle).toBeDefined();
    expect(cycle?.edgeId).toBe("e-b-a");
  });

  it("flags an unreachable node with the node attributed", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { position: { x: 300, y: 0 } }),
        node("orphan", { position: { x: 0, y: 300 } }),
        exit("x"),
      ],
      edges: [edge("a", "b", "always"), edge("b", "x", "always"), edge("orphan", "x", "always")],
    };
    const issues = validateCanvasDocument(doc);
    const unreachable = issues.find((issue) => issue.message.includes("not reachable"));
    expect(unreachable).toBeDefined();
    expect(unreachable?.nodeId).toBe("orphan");
  });

  it("flags an empty prompt template on the right node with the field path", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { promptTemplate: "", position: { x: 300, y: 0 } }),
      ],
      edges: [edge("a", "b", "always")],
    };
    const issues = validateCanvasDocument(doc);
    const emptyPrompt = issues.find((issue) => issue.message.includes("promptTemplate"));
    expect(emptyPrompt).toBeDefined();
    expect(emptyPrompt?.nodeId).toBe("b");
    expect(emptyPrompt?.field).toBe("config.promptTemplate");
  });

  it("flags an empty condition pattern on the offending edge", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), exit("x")],
      edges: [edge("a", "x", { pattern: "" })],
    };
    const issues = validateCanvasDocument(doc);
    const pattern = issues.find((issue) => issue.message.includes("pattern"));
    expect(pattern).toBeDefined();
    expect(pattern?.edgeId).toBe("e-a-x");
    expect(pattern?.field).toContain("pattern");
  });

  it("flags two unconditional outgoing edges (ambiguous router)", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { position: { x: 300, y: -100 } }),
        node("c", { position: { x: 300, y: 100 } }),
      ],
      edges: [edge("a", "b", "always"), edge("a", "c", "always")],
    };
    const issues = validateCanvasDocument(doc);
    expect(
      issues.some((issue) => issue.message.includes("unconditional (always) outgoing edges")),
    ).toBe(true);
  });

  it("flags exit nodes with outgoing edges", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), exit("x", { x: 300, y: 0 }), node("b")],
      edges: [edge("a", "x", "always"), edge("x", "b", "always")],
    };
    const issues = validateCanvasDocument(doc);
    const exitIssue = issues.find((issue) =>
      issue.message.includes("must not have outgoing edges"),
    );
    expect(exitIssue).toBeDefined();
    expect(exitIssue?.nodeId).toBe("x");
  });

  it("flags template references to non-upstream nodes", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { promptTemplate: "use {{output:ghost}}", position: { x: 300, y: 0 } }),
      ],
      edges: [edge("a", "b", "always")],
    };
    const issues = validateCanvasDocument(doc);
    const reference = issues.find((issue) => issue.message.includes("not an upstream node"));
    expect(reference).toBeDefined();
    expect(reference?.nodeId).toBe("b");
    expect(reference?.field).toBe("config.promptTemplate");
  });

  it("issuesForNode / issuesForEdge slice the badge targets", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { promptTemplate: "", position: { x: 300, y: 0 } }),
      ],
      edges: [edge("a", "b", "always"), edge("b", "a", "always")],
    };
    const issues = validateCanvasDocument(doc);
    expect(issuesForNode(issues, "b").length).toBeGreaterThan(0);
    expect(issuesForNode(issues, "a")).toEqual([]);
    const edgeIssues = issuesForEdge(issues, "e-b-a");
    expect(edgeIssues.length).toBeGreaterThan(0);
    expect(issuesForEdge(issues, "e-a-b")).toEqual([]);
  });
});

describe("classifyIssue (severity split, #68)", () => {
  it("unreachable-from-entry nodes are hints", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { position: { x: 300, y: 0 } }),
        node("orphan", { position: { x: 0, y: 300 } }),
        exit("x"),
      ],
      edges: [edge("a", "b", "always"), edge("b", "x", "always"), edge("orphan", "x", "always")],
    };
    const unreachable = validateCanvasDocument(doc).find((issue) =>
      issue.message.includes("not reachable"),
    );
    expect(unreachable).toBeDefined();
    expect(classifyIssue(unreachable as CanvasIssue)).toBe("hint");
    expect(issueHint(unreachable as CanvasIssue)).toBe(UNREACHABLE_HINT);
  });

  it("edges missing their condition pattern are hints", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), exit("x")],
      edges: [edge("a", "x", { pattern: "" })],
    };
    const missing = validateCanvasDocument(doc).find((issue) =>
      issue.message.includes("pattern must be a non-empty string"),
    );
    expect(missing).toBeDefined();
    expect(classifyIssue(missing as CanvasIssue)).toBe("hint");
    expect(issueHint(missing as CanvasIssue)).toBe(MISSING_CONDITION_HINT);
  });

  it("edges with an empty regex placeholder are hints too", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), exit("x")],
      edges: [
        {
          id: "e-a-x",
          source: "a",
          target: "x",
          data: { condition: { type: "outputMatches", regex: "" } },
        },
      ],
    };
    const missing = validateCanvasDocument(doc).find((issue) =>
      issue.message.includes("regex must be a non-empty string"),
    );
    expect(missing).toBeDefined();
    expect(classifyIssue(missing as CanvasIssue)).toBe("hint");
  });

  it("a typed-but-broken regex is a blocker, not a hint", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), exit("x")],
      edges: [
        {
          id: "e-a-x",
          source: "a",
          target: "x",
          data: { condition: { type: "outputMatches", regex: "([a-z" } },
        },
      ],
    };
    const broken = validateCanvasDocument(doc).find((issue) =>
      issue.message.includes("invalid regular expression"),
    );
    expect(broken).toBeDefined();
    expect(classifyIssue(broken as CanvasIssue)).toBe("blocker");
    expect(issueHint(broken as CanvasIssue)).toBeUndefined();
  });

  it("an empty prompt (user-cleared) is a blocker", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { promptTemplate: "", position: { x: 300, y: 0 } }),
      ],
      edges: [edge("a", "b", "always")],
    };
    const emptyPrompt = validateCanvasDocument(doc).find((issue) =>
      issue.message.includes("promptTemplate"),
    );
    expect(emptyPrompt).toBeDefined();
    expect(classifyIssue(emptyPrompt as CanvasIssue)).toBe("blocker");
  });

  it("hard graph rules are blockers", () => {
    const dualAlways: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { position: { x: 300, y: -100 } }),
        node("c", { position: { x: 300, y: 100 } }),
      ],
      edges: [edge("a", "b", "always"), edge("a", "c", "always")],
    };
    const dual = validateCanvasDocument(dualAlways).find((issue) =>
      issue.message.includes("unconditional (always) outgoing edges"),
    );
    expect(classifyIssue(dual as CanvasIssue)).toBe("blocker");

    const exitOutgoing: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), exit("x", { x: 300, y: 0 }), node("b")],
      edges: [edge("a", "x", "always"), edge("x", "b", "always")],
    };
    const exitIssue = validateCanvasDocument(exitOutgoing).find((issue) =>
      issue.message.includes("must not have outgoing edges"),
    );
    expect(classifyIssue(exitIssue as CanvasIssue)).toBe("blocker");

    const badReference: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { promptTemplate: "use {{output:ghost}}", position: { x: 300, y: 0 } }),
      ],
      edges: [edge("a", "b", "always")],
    };
    const reference = validateCanvasDocument(badReference).find((issue) =>
      issue.message.includes("not an upstream node"),
    );
    expect(classifyIssue(reference as CanvasIssue)).toBe("blocker");
  });
});

describe("live validation over a palette drop (#68)", () => {
  const entry = node("a", { isEntry: true });
  const dropped: CanvasNode = createAgentNode({
    id: "dropped",
    position: { x: 300, y: 0 },
    name: "Agent 2",
  });
  const withPrompt = (prompt: string): CanvasNode => {
    if (dropped.data.kind !== "agent") throw new Error("unreachable");
    return {
      ...dropped,
      data: { ...dropped.data, config: { ...dropped.data.config, promptTemplate: prompt } },
    };
  };

  it("a fresh palette drop (prefilled prompt) yields ONLY the unreachable hint", () => {
    const doc: CanvasDocument = { nodes: [entry, dropped], edges: [] };
    const issues = validateCanvasDocument(doc);
    expect(issues).toHaveLength(1);
    expect(classifyIssue(issues[0] as CanvasIssue)).toBe("hint");
    expect(issues[0]?.nodeId).toBe("dropped");
    expect(severitySummary(issues)).toBe("1 hint");
  });

  it("connecting the dropped node clears every issue (one connection from valid)", () => {
    const doc: CanvasDocument = { nodes: [entry, dropped], edges: [] };
    const check = checkConnect(doc, { source: "a", target: "dropped" });
    if (!check.ok) throw new Error("expected connect to succeed");
    const connected = applyConnect(doc, check);
    expect(validateCanvasDocument(connected)).toEqual([]);
  });

  it("clearing the prompt manually turns the doc into a blocker", () => {
    const cleared: CanvasDocument = {
      nodes: [entry, withPrompt("")],
      edges: [edge("a", "dropped", "always")],
    };
    const issues = validateCanvasDocument(cleared);
    expect(issues).toHaveLength(1);
    expect(classifyIssue(issues[0] as CanvasIssue)).toBe("blocker");
  });

  it("mixed docs split blockers-first and summarize with counts", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        { ...node("empty", { promptTemplate: "", position: { x: 300, y: 0 } }) },
        node("orphan", { position: { x: 0, y: 300 } }),
      ],
      edges: [edge("a", "empty", "always")],
    };
    const issues = validateCanvasDocument(doc);
    const { blockers, hints } = splitIssuesBySeverity(issues);
    expect(blockers.length).toBe(1);
    expect(hints.length).toBe(1);
    expect(blockers[0]?.nodeId).toBe("empty");
    expect(hints[0]?.nodeId).toBe("orphan");
    expect(severitySummary(issues)).toBe("1 blocker · 1 hint");
    expect(severitySummary([])).toBe("");
    expect(severitySummary(blockers)).toBe("1 blocker");
    expect(severitySummary(hints)).toBe("1 hint");
  });

  it("dedupeIssues collapses identical client + daemon findings", () => {
    const client: CanvasIssue = {
      nodeId: "b",
      field: "config.promptTemplate",
      message: "promptTemplate must be a non-empty string",
    };
    expect(dedupeIssues([client], [client, { nodeId: "z", message: "other" }])).toEqual([
      client,
      { nodeId: "z", message: "other" },
    ]);
  });
});

describe("issuesFromApiDetails (daemon 422 path mapping)", () => {
  const doc: CanvasDocument = {
    nodes: [node("a", { isEntry: true }), node("b", { position: { x: 300, y: 0 } }), exit("x")],
    edges: [edge("a", "b", "always"), edge("b", "x", "always")],
  };

  it("maps node config paths to node ids", () => {
    const details: ApiErrorDetail[] = [
      {
        path: "graph.nodes.1.config.promptTemplate",
        message: "promptTemplate must be a non-empty string",
      },
    ];
    const issues = issuesFromApiDetails(doc, details);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      nodeId: "b",
      field: "config.promptTemplate",
      message: "promptTemplate must be a non-empty string",
    });
  });

  it("maps edge paths to edge ids (index-based)", () => {
    const details: ApiErrorDetail[] = [
      { path: "graph.edges.0.condition.pattern", message: "pattern must be a non-empty string" },
    ];
    const issues = issuesFromApiDetails(doc, details);
    expect(issues[0]).toMatchObject({ edgeId: "e-a-b", field: "condition.pattern" });
  });

  it("maps whole-node paths without a field", () => {
    const details: ApiErrorDetail[] = [
      { path: "nodes.2", message: 'node "x" is not reachable from the entry node "a"' },
    ];
    const issues = issuesFromApiDetails(doc, details);
    expect(issues[0]).toMatchObject({
      nodeId: "x",
      message: expect.stringContaining("not reachable"),
    });
  });

  it("handles graph-level paths", () => {
    const details: ApiErrorDetail[] = [
      { path: "graph.entryNodeId", message: 'entryNodeId "missing" does not reference any node' },
    ];
    const issues = issuesFromApiDetails(doc, details);
    expect(issues[0]?.nodeId).toBe("a");
    expect(issues[0]?.field).toBe("entryNodeId");
  });
});
