import { describe, expect, it } from "vitest";
import { WorkflowGraphSchema, validateWorkflowGraph, type ExitCondition } from "@openeuler/core";
import {
  createAgentNode,
  createExitNode,
  fromCanvasDocument,
  toCanvasDocument,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasNode,
} from "./canvas-document";
import { checkConnect, applyConnect } from "./canvas-ops";
import { validateCanvasDocument, type CanvasIssue } from "./validation";
import { canvasDocsEquivalent } from "./canvas-document";
import {
  EDGE_MAX_ITERATIONS_DEFAULT,
  EDGE_MAX_ITERATIONS_HARD_CAP,
  MISSING_FALLBACK_MESSAGE,
  SET_CONDITION_LABEL,
  applyEdgeInspectorAction,
  clampMaxIterations,
  conditionForType,
  conditionSummary,
  cyclicEdgeIds,
  edgeChipLabel,
  edgeFieldErrors,
  edgeInspectorReducer,
  moveRouterEdge,
  needsConditionConfig,
  routerFallbackWarnings,
  routerRows,
  testCondition,
} from "./edge-inspector";

function node(
  id: string,
  options: { isEntry?: boolean; name?: string; position?: { x: number; y: number } } = {},
): CanvasNode {
  const base = createAgentNode({
    id,
    name: options.name ?? id,
    isEntry: options.isEntry ?? false,
    position: options.position ?? { x: 0, y: 0 },
  });
  if (base.data.kind !== "agent") throw new Error("expected an agent node");
  return {
    ...base,
    data: { ...base.data, config: { ...base.data.config, promptTemplate: "work: {{task}}" } },
  };
}

function exit(id: string, position = { x: 900, y: 0 }): CanvasNode {
  return { ...createExitNode(position), id, data: { kind: "exit", name: "Exit" } };
}

function edge(source: string, target: string, data: Partial<CanvasEdge["data"]> = {}): CanvasEdge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    data: { condition: { type: "always" }, ...data },
  };
}

const condition = (
  partial: Partial<ExitCondition> & { type: ExitCondition["type"] },
): ExitCondition => partial as ExitCondition;

describe("conditionSummary", () => {
  it("formats every condition type", () => {
    expect(conditionSummary({ condition: { type: "always" } })).toBe("always");
    expect(conditionSummary({ condition: { type: "outputContains", pattern: "LGTM" } })).toBe(
      'contains "LGTM"',
    );
    expect(conditionSummary({ condition: { type: "outputNotContains", pattern: "TODO" } })).toBe(
      'not-contains "TODO"',
    );
    expect(conditionSummary({ condition: { type: "outputMatches", regex: "^ok$" } })).toBe(
      "matches ^ok$",
    );
    expect(
      conditionSummary({ condition: { type: "outputMatches", regex: "^ok$", flags: "i" } }),
    ).toBe("matches ^ok$ [i]");
  });

  it("appends the ¬ negation suffix for inverted conditions of every type", () => {
    expect(conditionSummary({ condition: { type: "always" }, invert: true })).toBe("always ¬");
    expect(
      conditionSummary({
        condition: { type: "outputContains", pattern: "LGTM" },
        invert: true,
      }),
    ).toBe('contains "LGTM" ¬');
    expect(
      conditionSummary({
        condition: { type: "outputNotContains", pattern: "TODO" },
        invert: true,
      }),
    ).toBe('not-contains "TODO" ¬');
    expect(
      conditionSummary({
        condition: { type: "outputMatches", regex: "^ok$", flags: "i" },
        invert: true,
      }),
    ).toBe("matches ^ok$ [i] ¬");
  });

  it("shows the empty placeholder pattern verbatim (the edge is flagged for config separately)", () => {
    expect(conditionSummary({ condition: { type: "outputContains", pattern: "" } })).toBe(
      'contains ""',
    );
    expect(needsConditionConfig({ condition: { type: "outputContains", pattern: "" } })).toBe(true);
    expect(needsConditionConfig({ condition: { type: "outputMatches", regex: "" } })).toBe(true);
    expect(needsConditionConfig({ condition: { type: "always" } })).toBe(false);
    expect(needsConditionConfig({ condition: { type: "outputContains", pattern: "x" } })).toBe(
      false,
    );
  });
});

describe("conditionForType", () => {
  it("builds the empty placeholder for each type the select offers", () => {
    expect(conditionForType("always")).toEqual({ type: "always" });
    expect(conditionForType("outputContains")).toEqual({ type: "outputContains", pattern: "" });
    expect(conditionForType("outputNotContains")).toEqual({
      type: "outputNotContains",
      pattern: "",
    });
    expect(conditionForType("outputMatches")).toEqual({ type: "outputMatches", regex: "" });
  });
});

describe("edgeChipLabel (guided flow chips, #69)", () => {
  it("shows the attention 'set condition…' chip for every unconfigured placeholder", () => {
    expect(edgeChipLabel({ condition: { type: "outputContains", pattern: "" } })).toBe(
      SET_CONDITION_LABEL,
    );
    expect(edgeChipLabel({ condition: { type: "outputNotContains", pattern: "" } })).toBe(
      SET_CONDITION_LABEL,
    );
    expect(edgeChipLabel({ condition: { type: "outputMatches", regex: "" } })).toBe(
      SET_CONDITION_LABEL,
    );
  });

  it("never renders an empty-pattern summary", () => {
    expect(edgeChipLabel({ condition: { type: "outputContains", pattern: "" } })).not.toBe(
      'contains ""',
    );
  });

  it("falls back to the regular summary once the condition is configured", () => {
    expect(edgeChipLabel({ condition: { type: "always" } })).toBe("always");
    expect(edgeChipLabel({ condition: { type: "outputContains", pattern: "LGTM" } })).toBe(
      'contains "LGTM"',
    );
    expect(edgeChipLabel({ condition: { type: "outputMatches", regex: "^ok$", flags: "i" } })).toBe(
      "matches ^ok$ [i]",
    );
    expect(edgeChipLabel({ condition: { type: "always" }, invert: true })).toBe("always ¬");
  });
});

describe("testCondition (live regex test box)", () => {
  it("highlights every occurrence for contains (multiple matches)", () => {
    const sample = "say ok\nthen OK?\nfinal ok.";
    const result = testCondition({ condition: { type: "outputContains", pattern: "ok" } }, sample);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matched).toBe(true);
    expect(result.regions.map((region) => sample.slice(region.start, region.end))).toEqual([
      "ok",
      "ok",
    ]);
    expect(result.regions[0]?.start).toBe(4);
    expect(result.regions[1]?.end).toBe(sample.length - 1);
  });

  it("reports no match with no regions", () => {
    const result = testCondition(
      { condition: { type: "outputContains", pattern: "LGTM" } },
      "needs work",
    );
    expect(result).toEqual({ ok: true, matched: false, regions: [] });
  });

  it("evaluates not-contains against the same highlighted occurrences", () => {
    const sample = "left a TODO in the diff";
    const hit = testCondition(
      { condition: { type: "outputNotContains", pattern: "TODO" } },
      sample,
    );
    expect(hit.ok && hit.matched).toBe(false);
    expect(hit.ok && hit.regions).toEqual([{ start: 7, end: 11 }]);
    const clean = testCondition(
      { condition: { type: "outputNotContains", pattern: "TODO" } },
      "all clean",
    );
    expect(clean).toEqual({ ok: true, matched: true, regions: [] });
  });

  it("highlights regex matches, honoring flags", () => {
    const plain = testCondition(
      { condition: { type: "outputMatches", regex: "status: \\w+" } },
      "log\nstatus: green\nstatus: red",
    );
    expect(plain.ok && plain.matched).toBe(true);
    expect(plain.ok && plain.regions).toEqual([
      { start: 4, end: 17 },
      { start: 18, end: 29 },
    ]);
    const caseInsensitive = testCondition(
      { condition: { type: "outputMatches", regex: "^ok$", flags: "i" } },
      "OK",
    );
    expect(caseInsensitive).toEqual({ ok: true, matched: true, regions: [{ start: 0, end: 2 }] });
  });

  it("reports every multiline ^/$ anchored match (m flag)", () => {
    const sample = "no\nok\nok";
    const result = testCondition(
      { condition: { type: "outputMatches", regex: "^ok$", flags: "m" } },
      sample,
    );
    expect(result.ok && result.matched).toBe(true);
    expect(result.ok && result.regions).toEqual([
      { start: 3, end: 5 },
      { start: 6, end: 8 },
    ]);
  });

  it("sticky (y) scans resume after a gap and report later matches", () => {
    const sample = "x\nok\nno\nok";
    const result = testCondition(
      { condition: { type: "outputMatches", regex: "^ok", flags: "ym" } },
      sample,
    );
    // The verdict mirrors the engine's sticky test at index 0 — no match.
    expect(result.ok && result.matched).toBe(false);
    expect(result.ok && result.regions).toEqual([
      { start: 2, end: 4 },
      { start: 8, end: 10 },
    ]);
  });

  it("zero-width regex matches report a match but highlight nothing", () => {
    const result = testCondition({ condition: { type: "outputMatches", regex: "a*" } }, "bbb");
    expect(result).toEqual({ ok: true, matched: true, regions: [] });
  });

  it("returns an error object for an invalid regex — never throws", () => {
    const result = testCondition({ condition: { type: "outputMatches", regex: "([a-z" } }, "abc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("invalid regular expression");
  });

  it("returns an error object for invalid flags", () => {
    const result = testCondition(
      { condition: { type: "outputMatches", regex: "a", flags: "q" } },
      "abc",
    );
    expect(result).toEqual({
      ok: false,
      error: "flags may only contain the characters: d g i m s u v y",
    });
  });

  it("returns an error object for an empty pattern (blocked like at save time)", () => {
    expect(testCondition({ condition: { type: "outputContains", pattern: "" } }, "x")).toEqual({
      ok: false,
      error: "pattern must be a non-empty string",
    });
    expect(testCondition({ condition: { type: "outputMatches", regex: "" } }, "x")).toEqual({
      ok: false,
      error: "regex must be a non-empty string",
    });
  });

  it("invert negates the verdict and always matches unless inverted", () => {
    expect(
      testCondition({ condition: { type: "outputContains", pattern: "nope" }, invert: true }, "x"),
    ).toEqual({ ok: true, matched: true, regions: [] });
    expect(testCondition({ condition: { type: "always" } }, "anything")).toEqual({
      ok: true,
      matched: true,
      regions: [],
    });
    expect(testCondition({ condition: { type: "always" }, invert: true }, "anything")).toEqual({
      ok: true,
      matched: false,
      regions: [],
    });
  });
});

describe("edgeFieldErrors (inline, consistent with save-time)", () => {
  it("flags empty patterns with the schema message", () => {
    expect(edgeFieldErrors({ condition: { type: "outputContains", pattern: "" } })).toEqual({
      pattern: "pattern must be a non-empty string",
    });
    expect(edgeFieldErrors({ condition: { type: "outputNotContains", pattern: "" } }).pattern).toBe(
      "pattern must be a non-empty string",
    );
  });

  it("flags empty and invalid regexes with the schema messages", () => {
    expect(edgeFieldErrors({ condition: { type: "outputMatches", regex: "" } })).toEqual({
      regex: "regex must be a non-empty string",
    });
    expect(
      edgeFieldErrors({ condition: { type: "outputMatches", regex: "([a-z" } }).regex,
    ).toContain("invalid regular expression");
    expect(
      edgeFieldErrors({ condition: { type: "outputMatches", regex: "a", flags: "x" } }).flags,
    ).toContain("flags may only contain");
  });

  it("flags maxIterations outside the 1..hard-cap band", () => {
    expect(edgeFieldErrors({ condition: { type: "always" }, maxIterations: 0 }).maxIterations).toBe(
      "maxIterations must be an integer >= 1",
    );
    expect(
      edgeFieldErrors({ condition: { type: "always" }, maxIterations: 1.5 }).maxIterations,
    ).toContain("integer");
    expect(
      edgeFieldErrors({ condition: { type: "always" }, maxIterations: 26 }).maxIterations,
    ).toContain("clamped");
  });

  it("returns no errors for a valid condition", () => {
    expect(
      edgeFieldErrors({ condition: { type: "outputMatches", regex: "^ok$", flags: "im" } }),
    ).toEqual({});
    expect(
      edgeFieldErrors({
        condition: { type: "always" },
        maxIterations: EDGE_MAX_ITERATIONS_DEFAULT,
      }),
    ).toEqual({});
  });
});

describe("clampMaxIterations", () => {
  it("clamps into 1..hard-cap, defaulting invalid input", () => {
    expect(clampMaxIterations(3)).toBe(3);
    expect(clampMaxIterations(1)).toBe(1);
    expect(clampMaxIterations(25)).toBe(25);
    expect(clampMaxIterations(0)).toBe(1);
    expect(clampMaxIterations(-5)).toBe(1);
    expect(clampMaxIterations(26)).toBe(25);
    expect(clampMaxIterations(100)).toBe(25);
    expect(clampMaxIterations(2.9)).toBe(2);
    expect(clampMaxIterations(Number.NaN)).toBe(EDGE_MAX_ITERATIONS_DEFAULT);
    expect(EDGE_MAX_ITERATIONS_DEFAULT).toBe(3);
    expect(EDGE_MAX_ITERATIONS_HARD_CAP).toBe(25);
  });
});

describe("cyclicEdgeIds (cycle membership)", () => {
  it("marks no edges in a plain chain", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), node("b", { position: { x: 300, y: 0 } }), exit("x")],
      edges: [edge("a", "b"), edge("b", "x")],
    };
    expect(cyclicEdgeIds(doc)).toEqual(new Set());
  });

  it("marks every edge of a two-node loop", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), node("b", { position: { x: 300, y: 0 } })],
      edges: [
        edge("a", "b"),
        edge("b", "a", { condition: condition({ type: "outputContains", pattern: "retry" }) }),
      ],
    };
    expect(cyclicEdgeIds(doc)).toEqual(new Set(["e-a-b", "e-b-a"]));
  });

  it("marks a self-loop edge only", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), node("b", { position: { x: 300, y: 0 } }), exit("x")],
      edges: [
        edge("a", "b"),
        edge("b", "b", { condition: condition({ type: "outputContains", pattern: "again" }) }),
        edge("b", "x"),
      ],
    };
    expect(cyclicEdgeIds(doc)).toEqual(new Set(["e-b-b"]));
  });

  it("marks all edges of a longer cycle but not the tail leading into it", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { position: { x: 300, y: 0 } }),
        node("c", { position: { x: 600, y: 0 } }),
        node("d", { position: { x: 600, y: 200 } }),
      ],
      edges: [
        edge("a", "b"),
        edge("b", "c"),
        edge("c", "d"),
        edge("d", "b", { condition: condition({ type: "outputContains", pattern: "loop" }) }),
      ],
    };
    expect(cyclicEdgeIds(doc)).toEqual(new Set(["e-b-c", "e-c-d", "e-d-b"]));
  });
});

describe("routerRows / moveRouterEdge (evaluation order)", () => {
  /** entry router a with conditional a→b, a→c and an always fallback a→exit. */
  function routerDoc(orders: { bc?: number; ac?: number } = {}): CanvasDocument {
    return {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { position: { x: 300, y: -140 } }),
        node("c", { position: { x: 300, y: 140 } }),
        exit("x", { x: 620, y: 0 }),
      ],
      edges: [
        edge("a", "b", {
          condition: condition({ type: "outputContains", pattern: "LGTM" }),
          ...(orders.bc === undefined ? {} : { order: orders.bc }),
        }),
        edge("a", "c", {
          condition: condition({ type: "outputNotContains", pattern: "TODO" }),
          ...(orders.ac === undefined ? {} : { order: orders.ac }),
        }),
        edge("a", "x"),
      ],
    };
  }

  it("lists conditionals by effective order (array index when absent) with the fallback pinned last", () => {
    const rows = routerRows(routerDoc(), "a");
    expect(rows.map((row) => row.edge.id)).toEqual(["e-a-b", "e-a-c", "e-a-x"]);
    expect(rows.map((row) => row.conditional)).toEqual([true, true, false]);
    // Explicit order wins over array position.
    const explicit = routerRows(routerDoc({ bc: 5, ac: 1 }), "a");
    expect(explicit.map((row) => row.edge.id)).toEqual(["e-a-c", "e-a-b", "e-a-x"]);
    // Single-outgoing nodes list one row.
    expect(routerRows(routerDoc(), "b").map((row) => row.edge.id)).toEqual([]);
  });

  it("moves a conditional edge within the order and renumbers contiguously", () => {
    const doc = routerDoc();
    const moved = moveRouterEdge(doc, "e-a-c", -1);
    const rows = routerRows(moved, "a");
    expect(rows.map((row) => row.edge.id)).toEqual(["e-a-c", "e-a-b", "e-a-x"]);
    expect(rows.map((row) => row.order)).toEqual([0, 1, 2]);
    // The fallback stays the fallback: still unconditional, never ordered.
    const fallback = moved.edges.find((candidate) => candidate.id === "e-a-x");
    expect(fallback?.data.condition).toEqual({ type: "always" });
    expect(fallback?.data.order).toBeUndefined();
  });

  it("moves the edge whose row chevron was clicked, not the selected edge", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { position: { x: 300, y: -140 } }),
        node("c", { position: { x: 300, y: 0 } }),
        node("d", { position: { x: 300, y: 140 } }),
        exit("x", { x: 620, y: 0 }),
      ],
      edges: [
        // The inspected (selected) edge is row 1; row 3's up chevron
        // dispatches with row 3's edge id.
        {
          ...edge("a", "b", { condition: condition({ type: "outputContains", pattern: "LGTM" }) }),
          selected: true,
        },
        edge("a", "c", { condition: condition({ type: "outputNotContains", pattern: "TODO" }) }),
        edge("a", "d", { condition: condition({ type: "outputMatches", regex: "^needs fix" }) }),
        edge("a", "x"),
      ],
    };
    const moved = edgeInspectorReducer(doc, { type: "moveEdge", edgeId: "e-a-d", direction: -1 });
    const rows = routerRows(moved, "a").filter((row) => row.conditional);
    expect(rows.map((row) => row.edge.id)).toEqual(["e-a-b", "e-a-d", "e-a-c"]);
    expect(rows.map((row) => row.order)).toEqual([0, 1, 2]);
    // Rows 2 and 3 swapped while the selection stayed on row 1.
    expect(moved.edges.find((candidate) => candidate.id === "e-a-b")?.selected).toBe(true);
  });

  it("no-ops at the ends, for the fallback edge, and for unknown edges", () => {
    const doc = routerDoc();
    expect(moveRouterEdge(doc, "e-a-b", -1)).toBe(doc);
    expect(moveRouterEdge(doc, "e-a-c", 1)).toBe(doc);
    expect(moveRouterEdge(doc, "e-a-x", -1)).toBe(doc);
    expect(moveRouterEdge(doc, "e-ghost", -1)).toBe(doc);
  });

  it("keeps the reordered router valid and equivalent to core's order normalization", () => {
    const doc = routerDoc();
    const moved = moveRouterEdge(doc, "e-a-c", -1);

    // Save-time gate: unique router orders pass schema + cross-field rules.
    expect(validateWorkflowGraph(fromCanvasDocument(moved))).toEqual([]);
    const parsed = WorkflowGraphSchema.parse(fromCanvasDocument(moved));
    // Engine evaluation sequence: conditionals sorted by (order ?? array index).
    const sequence = parsed.edges
      .filter((candidate) => candidate.source === "a" && candidate.condition.type !== "always")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((candidate) => candidate.id);
    expect(sequence).toEqual(["e-a-c", "e-a-b"]);
    // Same doc with no explicit orders defaults to array order — the core rule.
    expect(
      routerRows(doc, "a")
        .filter((row) => row.conditional)
        .map((row) => row.edge.id),
    ).toEqual(
      doc.edges
        .filter(
          (candidate) => candidate.source === "a" && candidate.data.condition.type !== "always",
        )
        .map((candidate) => candidate.id),
    );
  });
});

describe("routerFallbackWarnings (missing fallback)", () => {
  it("warns for a 2-conditional router with no always edge", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { position: { x: 300, y: -140 } }),
        node("c", { position: { x: 300, y: 140 } }),
      ],
      edges: [
        edge("a", "b", { condition: condition({ type: "outputContains", pattern: "LGTM" }) }),
        edge("a", "c", { condition: condition({ type: "outputNotContains", pattern: "TODO" }) }),
      ],
    };
    expect(routerFallbackWarnings(doc)).toEqual([
      { nodeId: "a", message: MISSING_FALLBACK_MESSAGE },
    ]);
  });

  it("stays quiet while an always fallback exists, and for plain chains / dead ends", () => {
    const routerWithFallback: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), node("b"), exit("x")],
      edges: [
        edge("a", "b", { condition: condition({ type: "outputContains", pattern: "LGTM" }) }),
        edge("a", "x"),
      ],
    };
    expect(routerFallbackWarnings(routerWithFallback)).toEqual([]);

    const chain: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), node("b", { position: { x: 300, y: 0 } }), exit("x")],
      edges: [edge("a", "b"), edge("b", "x")],
    };
    expect(routerFallbackWarnings(chain)).toEqual([]);

    const deadEnd: CanvasDocument = { nodes: [node("a", { isEntry: true })], edges: [] };
    expect(routerFallbackWarnings(deadEnd)).toEqual([]);
  });

  it("warns for a single-conditional router too — the drawer banner gates on the lib", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), exit("x")],
      edges: [
        edge("a", "x", { condition: condition({ type: "outputContains", pattern: "LGTM" }) }),
      ],
    };
    expect(routerFallbackWarnings(doc)).toEqual([
      { nodeId: "a", message: MISSING_FALLBACK_MESSAGE },
    ]);
  });

  it("treats an inverted always edge as conditional (no fallback)", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), exit("x")],
      edges: [edge("a", "x", { condition: { type: "always" }, invert: true })],
    };
    expect(routerFallbackWarnings(doc)).toEqual([
      { nodeId: "a", message: MISSING_FALLBACK_MESSAGE },
    ]);
  });
});

describe("edgeInspectorReducer (doc edits)", () => {
  const base = (): CanvasDocument => ({
    nodes: [node("a", { isEntry: true }), node("b", { position: { x: 300, y: 0 } }), exit("x")],
    edges: [edge("a", "b"), edge("b", "x")],
  });

  it("patches edge data and strips explicit-undefined keys (negate off stays absent)", () => {
    let doc = base();
    doc = edgeInspectorReducer(doc, {
      type: "patchEdge",
      edgeId: "e-a-b",
      patch: { condition: condition({ type: "outputContains", pattern: "LGTM" }), invert: true },
    });
    doc = edgeInspectorReducer(doc, {
      type: "patchEdge",
      edgeId: "e-a-b",
      patch: { invert: undefined },
    });
    const target = doc.edges.find((candidate) => candidate.id === "e-a-b");
    expect(target?.data).toEqual({ condition: { type: "outputContains", pattern: "LGTM" } });
    expect("invert" in (target?.data ?? {})).toBe(false);
  });

  it("clamps a typed maxIterations through the reducer", () => {
    const doc = edgeInspectorReducer(base(), {
      type: "patchEdge",
      edgeId: "e-a-b",
      patch: { maxIterations: clampMaxIterations(99) },
    });
    expect(doc.edges[0]?.data.maxIterations).toBe(25);
  });

  it("ignores edits to unknown edges", () => {
    const doc = base();
    expect(applyEdgeInspectorAction(doc, { type: "patchEdge", edgeId: "ghost", patch: {} })).toBe(
      doc,
    );
  });
});

describe("router through the reducer: save round-trip + reload identity", () => {
  /** entry a → conditional b / conditional d / always fallback exit, built via canvas ops. */
  function buildRouter(): CanvasDocument {
    let doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { position: { x: 300, y: -140 }, name: "merge" }),
        node("d", { position: { x: 300, y: 140 }, name: "fix" }),
        exit("x", { x: 620, y: 0 }),
      ],
      edges: [],
    };
    // First outgoing edge is born always; extras arrive conditional (#46).
    for (const target of ["b", "d", "x"]) {
      const check = checkConnect(doc, { source: "a", target });
      if (!check.ok) throw new Error(`connect a→${target} rejected`);
      doc = applyConnect(doc, check);
    }
    doc = edgeInspectorReducer(doc, {
      type: "patchEdge",
      edgeId: "e-a-b",
      patch: { condition: condition({ type: "outputContains", pattern: "LGTM" }) },
    });
    doc = edgeInspectorReducer(doc, {
      type: "patchEdge",
      edgeId: "e-a-d",
      patch: { condition: condition({ type: "outputMatches", regex: "^needs fix", flags: "im" }) },
    });
    // The born-always edge becomes the router's conditional; the exit edge
    // (auto-converted at connect time) is flipped back to the always fallback.
    doc = edgeInspectorReducer(doc, {
      type: "patchEdge",
      edgeId: "e-a-x",
      patch: { condition: condition({ type: "always" }) },
    });
    return doc;
  }

  it("saves: validateCanvasDocument + WorkflowGraphSchema both accept the router", () => {
    const doc = buildRouter();
    expect(validateCanvasDocument(doc)).toEqual([]);
    const graph = fromCanvasDocument(doc);
    expect(validateWorkflowGraph(graph)).toEqual([]);
    expect(() => WorkflowGraphSchema.parse(graph)).not.toThrow();
  });

  it("reloads identically: labels are derived from conditions, never stored", () => {
    const doc = buildRouter();
    const saved = WorkflowGraphSchema.parse(fromCanvasDocument(doc));
    // Save normalization stamps explicit orders on the router's edges.
    const reloaded = toCanvasDocument(saved);

    const summaryById = (document: CanvasDocument): Record<string, string> =>
      Object.fromEntries(document.edges.map((item) => [item.id, conditionSummary(item.data)]));
    expect(summaryById(reloaded)).toEqual(summaryById(doc));

    // No stored label drift: the canvas label is a projection, and the
    // second round-trip changes nothing.
    for (const item of doc.edges) expect("label" in item).toBe(false);
    expect(
      canvasDocsEquivalent(
        reloaded,
        toCanvasDocument(WorkflowGraphSchema.parse(fromCanvasDocument(reloaded))),
      ),
    ).toBe(true);
  });

  it("blocks save for an invalid regex: field error inline, issue at save time", () => {
    let doc = buildRouter();
    doc = edgeInspectorReducer(doc, {
      type: "patchEdge",
      edgeId: "e-a-d",
      patch: { condition: condition({ type: "outputMatches", regex: "([a-z" }) },
    });

    // Inline: the drawer's compile-at-edit-time field error.
    const target = doc.edges.find((candidate) => candidate.id === "e-a-d");
    expect(target && edgeFieldErrors(target.data).regex).toContain("invalid regular expression");
    // Save gate: the editor blocks while any issue is present.
    const issues: CanvasIssue[] = validateCanvasDocument(doc);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.edgeId === "e-a-d")).toBe(true);
    expect(WorkflowGraphSchema.safeParse(fromCanvasDocument(doc)).success).toBe(false);
  });

  it("blocks save for the auto-converted empty-pattern edge until configured", () => {
    let doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), node("b", { position: { x: 300, y: 0 } }), exit("x")],
      edges: [],
    };
    for (const target of ["b", "x"]) {
      const check = checkConnect(doc, { source: "a", target });
      if (!check.ok) throw new Error("connect rejected");
      doc = applyConnect(doc, check);
    }
    const issues = validateCanvasDocument(doc);
    // The FIRST outgoing edge (a→b) is born always; the second (a→x) is the
    // auto-converted conditional placeholder blocking the save.
    expect(
      issues.some(
        (issue) => issue.edgeId === "e-a-x" && (issue.field ?? "").startsWith("condition"),
      ),
    ).toBe(true);
    expect(needsConditionConfig(doc.edges[1]?.data ?? { condition: { type: "always" } })).toBe(
      true,
    );
  });
});
