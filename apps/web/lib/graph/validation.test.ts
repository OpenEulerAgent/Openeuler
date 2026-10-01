import { describe, expect, it } from "vitest";
import type { ApiErrorDetail } from "../api";
import {
  createAgentNode,
  createExitNode,
  type CanvasDocument,
  type CanvasNode,
} from "./canvas-document";
import {
  validateCanvasDocument,
  issuesFromApiDetails,
  issuesForEdge,
  issuesForNode,
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
