import { describe, expect, it } from "vitest";
import { WorkflowGraphSchema, extractOutputReferences } from "@openeuler/core";
import {
  STARTER_TEMPLATES,
  findStarterTemplate,
  type StarterTemplate,
} from "@/lib/onboarding/templates";

/**
 * Starter templates validate against the core WorkflowGraph schema — the
 * same parse the daemon's POST /api/workflows runs. This is the assertion
 * that catches router-rule violations (ambiguous always edges, unordered
 * routers, unconditional cycles, dangling {{output:}} refs…).
 */

const parseOrThrow = (template: StarterTemplate) => WorkflowGraphSchema.parse(template.graph);

describe("STARTER_TEMPLATES", () => {
  it("ships exactly two starters (templates are door-openers, not the product)", () => {
    expect(STARTER_TEMPLATES).toHaveLength(2);
    expect(new Set(STARTER_TEMPLATES.map((template) => template.id)).size).toBe(2);
  });

  it.each(STARTER_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s validates against WorkflowGraphSchema",
    (_id, template) => {
      const graph = parseOrThrow(template);
      expect(graph.nodes.length).toBeGreaterThan(1);
      expect(graph.edges.length).toBeGreaterThan(0);
    },
  );

  it.each(STARTER_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s lays nodes out sensibly left-to-right with no overlaps",
    (_id, template) => {
      const xs = template.graph.nodes.map((node) => node.position.x);
      expect([...xs].sort((a, b) => a - b)).toEqual(xs);
      // No two nodes occupy the same canvas cell (the loop template stacks
      // the fixer below the reviewer on purpose).
      const cells = template.graph.nodes.map((node) => `${node.position.x},${node.position.y}`);
      expect(new Set(cells).size).toBe(cells.length);
    },
  );

  it.each(STARTER_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s prompts use {{task}} and only upstream {{output:<nodeId>}} references",
    (_id, template) => {
      for (const node of template.graph.nodes) {
        if (node.type !== "agent") continue;
        expect(node.config.promptTemplate).toContain("{{task}}");
        // References resolve upstream — the schema parse above enforces it;
        // here we just assert the templates actually use the variable.
        expect(extractOutputReferences(node.config.promptTemplate).length).toBeGreaterThanOrEqual(
          node.id === "implement" ? 0 : 1,
        );
      }
    },
  );

  it("findStarterTemplate resolves ids and rejects everything else", () => {
    expect(findStarterTemplate("implement-review-fix")?.id).toBe("implement-review-fix");
    expect(findStarterTemplate("feature-pipeline")?.id).toBe("feature-pipeline");
    expect(findStarterTemplate("blank")).toBeUndefined();
    expect(findStarterTemplate("nope")).toBeUndefined();
  });
});

describe("implement-review-fix template (router rules)", () => {
  const template = findStarterTemplate("implement-review-fix");
  expect(template).toBeDefined();
  const graph = WorkflowGraphSchema.parse(template?.graph);

  it("routes approval to the exit and everything else back through the fixer", () => {
    const approve = graph.edges.find((edge) => edge.id === "e-reviewer-approve");
    const fix = graph.edges.find((edge) => edge.id === "e-reviewer-fix");
    expect(approve).toMatchObject({
      source: "reviewer",
      target: "exit",
      condition: { type: "outputContains", pattern: "LGTM" },
      order: 0,
    });
    expect(fix).toMatchObject({
      source: "reviewer",
      target: "fix",
      condition: { type: "outputNotContains", pattern: "LGTM" },
      order: 1,
      maxIterations: 3,
    });
    // The fixer always returns to the reviewer.
    expect(graph.edges.find((edge) => edge.id === "e-fix-reviewer")).toMatchObject({
      source: "fix",
      target: "reviewer",
      condition: { type: "always" },
    });
  });

  it("keeps the reviewer a well-formed router: two conditional edges with unique order", () => {
    const reviewerEdges = graph.edges.filter((edge) => edge.source === "reviewer");
    expect(reviewerEdges).toHaveLength(2);
    expect(reviewerEdges.every((edge) => edge.condition.type !== "always")).toBe(true);
    expect(new Set(reviewerEdges.map((edge) => edge.order)).size).toBe(2);
  });

  it("chains downstream context with {{output:}} references", () => {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(nodes.get("reviewer")).toMatchObject({ type: "agent" });
    const reviewer = nodes.get("reviewer");
    const fixer = nodes.get("fix");
    if (reviewer?.type === "agent") {
      expect(extractOutputReferences(reviewer.config.promptTemplate)).toEqual(["implement"]);
    }
    if (fixer?.type === "agent") {
      expect(extractOutputReferences(fixer.config.promptTemplate)).toEqual([
        "implement",
        "reviewer",
      ]);
    }
  });
});

describe("feature-pipeline template (linear chain)", () => {
  const template = findStarterTemplate("feature-pipeline");
  expect(template).toBeDefined();
  const graph = WorkflowGraphSchema.parse(template?.graph);

  it("is a plain always-edge chain ending in the exit node", () => {
    expect(graph.entryNodeId).toBe("implement");
    expect(graph.edges.map((edge) => [edge.source, edge.target, edge.condition.type])).toEqual([
      ["implement", "tests", "always"],
      ["tests", "docs", "always"],
      ["docs", "exit", "always"],
    ]);
    expect(graph.nodes.find((node) => node.id === "exit")).toMatchObject({ type: "exit" });
  });
});
