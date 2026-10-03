import {
  DEFAULT_EDGE_MAX_ITERATIONS,
  ExitConditionSchema,
  type ExitCondition,
} from "@openeuler/core";
import type { CanvasDocument, CanvasEdge, CanvasEdgeData } from "./canvas-document";
import { isUnconditionalEdge } from "./canvas-ops";

/**
 * Pure logic behind the conditional edge editor (#48): condition summary
 * chips for the canvas labels, the live regex test box (match regions /
 * errors, never throws), edit-time field validation consistent with the
 * save-time zod rules, cycle membership for the maxIterations guard, router
 * evaluation-order rows + reorder, missing-fallback warnings, and the
 * doc-editing reducer the drawer dispatches into. No React — all of it is
 * unit-testable headlessly.
 */

/**
 * Hard ceiling on `maxIterations`, mirroring the engine's
 * `MAX_EDGE_ITERATIONS` clamp (the web app does not depend on the engine
 * package, so the constant is restated here).
 */
export const EDGE_MAX_ITERATIONS_HARD_CAP = 25;

/** Default cycle guard the schema stamps on save (core's default). */
export const EDGE_MAX_ITERATIONS_DEFAULT = DEFAULT_EDGE_MAX_ITERATIONS;

/** Warning message for a router whose outgoing edges are all conditional. */
export const MISSING_FALLBACK_MESSAGE =
  "router has no fallback: if no condition matches the run ends here — add an always edge";

/**
 * Advisory notice for a fan-out node (#116): multiple unconditional outgoing
 * edges are legal parallelism (#115), not an error — the copy says what the
 * shape does and where the branches should converge.
 */
export const FAN_OUT_NOTICE = "fan-out: branches run in parallel — converge them at a join node";

/** Advisory finding for a node (never blocks saving, unlike CanvasIssue). */
export interface CanvasWarning {
  nodeId: string;
  message: string;
}

/** The chip text a condition renders on the canvas edge (and in the drawer). */
export function conditionSummary(data: Pick<CanvasEdgeData, "condition" | "invert">): string {
  const suffix = data.invert === true ? " ¬" : "";
  const condition = data.condition;
  switch (condition.type) {
    case "always":
      return `always${suffix}`;
    case "outputContains":
      return `contains "${condition.pattern}"${suffix}`;
    case "outputNotContains":
      return `not-contains "${condition.pattern}"${suffix}`;
    case "outputMatches":
      return `matches ${condition.regex}${condition.flags ? ` [${condition.flags}]` : ""}${suffix}`;
  }
}

/** A fresh condition of the requested type, as the type switcher creates it. */
export function conditionForType(type: ExitCondition["type"]): ExitCondition {
  if (type === "always") return { type: "always" };
  if (type === "outputMatches") return { type: "outputMatches", regex: "" };
  return { type, pattern: "" };
}

/**
 * Chip copy for an edge whose condition is still the empty placeholder
 * (#69): an attention-grabbing call-to-action instead of a meaningless
 * `contains ""` summary.
 */
export const SET_CONDITION_LABEL = "set condition…";

/**
 * The canvas chip label for an edge: {@link SET_CONDITION_LABEL} while the
 * condition still needs configuring (amber attention tone, guided flow),
 * otherwise the regular {@link conditionSummary}.
 */
export function edgeChipLabel(data: Pick<CanvasEdgeData, "condition" | "invert">): string {
  return needsConditionConfig(data) ? SET_CONDITION_LABEL : conditionSummary(data);
}

/** Whether a conditional edge still carries its empty placeholder pattern. */
export function needsConditionConfig(data: Pick<CanvasEdgeData, "condition">): boolean {
  const condition = data.condition;
  if (condition.type === "always") return false;
  if (condition.type === "outputMatches") return condition.regex.length === 0;
  return condition.pattern.length === 0;
}

// ---------------------------------------------------------------------------
// Live condition test box
//

/** One highlighted slice of the sample output `[start, end)`. */
export interface ConditionMatchRegion {
  start: number;
  end: number;
}

/** Test-box outcome: the regions + verdict, or the compile error. */
export type ConditionTestResult =
  { ok: true; matched: boolean; regions: ConditionMatchRegion[] } | { ok: false; error: string };

/** All occurrences of `pattern` in `sample` (case-sensitive substrings). */
function substringRegions(sample: string, pattern: string): ConditionMatchRegion[] {
  const regions: ConditionMatchRegion[] = [];
  let at = sample.indexOf(pattern);
  while (at !== -1) {
    regions.push({ start: at, end: at + pattern.length });
    at = sample.indexOf(pattern, at + pattern.length);
  }
  return regions;
}

/**
 * Evaluates the edge condition against a pasted sample output exactly like
 * the engine will (`invert` negates the verdict), reporting the matched
 * regions so the test box can highlight them inline. Invalid or empty
 * patterns/flags return an error object instead of throwing — the same
 * inputs the save-time schema rejects.
 */
export function testCondition(
  data: Pick<CanvasEdgeData, "condition" | "invert">,
  sample: string,
): ConditionTestResult {
  const condition = data.condition;

  if (condition.type === "always") {
    return { ok: true, matched: data.invert !== true, regions: [] };
  }

  if (condition.type === "outputContains" || condition.type === "outputNotContains") {
    if (condition.pattern.length === 0) {
      return { ok: false, error: "pattern must be a non-empty string" };
    }
    const regions = substringRegions(sample, condition.pattern);
    const found = regions.length > 0;
    const matched = condition.type === "outputContains" ? found : !found;
    return { ok: true, matched: data.invert === true ? !matched : matched, regions };
  }

  if (condition.regex.length === 0) {
    return { ok: false, error: "regex must be a non-empty string" };
  }
  if (!/^[dgimsuvy]*$/.test(condition.flags ?? "")) {
    return { ok: false, error: "flags may only contain the characters: d g i m s u v y" };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(condition.regex, condition.flags ?? "");
  } catch (cause) {
    return {
      ok: false,
      error: `invalid regular expression: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const regions: ConditionMatchRegion[] = [];
  // Enumerate matches with a global view of the same pattern (the pattern
  // keeps its own anchoring; zero-width matches highlight nothing). Sticky
  // (y) scans resume one index past a miss instead of stopping at the
  // first gap, so every non-overlapping match is reported — multiline
  // ^/$ anchors included.
  const scanner = new RegExp(condition.regex, (condition.flags ?? "").replaceAll("g", "") + "g");
  let at = 0;
  while (at <= sample.length) {
    scanner.lastIndex = at;
    const match = scanner.exec(sample);
    if (match === null) {
      if (!scanner.sticky) break;
      at += 1;
      continue;
    }
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (end > start) regions.push({ start, end });
    at = end > start ? end : end + 1;
    if (regions.length > 500) break;
  }
  return {
    ok: true,
    matched: data.invert === true ? !regex.test(sample) : regex.test(sample),
    regions,
  };
}

// ---------------------------------------------------------------------------
// Edit-time field validation (consistent with save-time zod)
//

/** Edge fields the drawer flags inline. */
export type EdgeField = "pattern" | "regex" | "flags" | "maxIterations";

export type EdgeFieldErrors = Partial<Record<EdgeField, string>>;

/**
 * Live per-field errors for the inspected edge, reusing core's
 * `ExitConditionSchema` so typing feedback matches the save-time rejection
 * messages exactly; `maxIterations` out of its 1..hard-cap band is flagged
 * too (the engine clamps anything above the cap at run time).
 */
export function edgeFieldErrors(
  data: Pick<CanvasEdgeData, "condition" | "maxIterations">,
): EdgeFieldErrors {
  const errors: EdgeFieldErrors = {};
  const parsed = ExitConditionSchema.safeParse(data.condition);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".");
      if (field === "pattern" || field === "regex" || field === "flags") {
        errors[field] ??= issue.message;
      } else if (field === "" && data.condition.type === "outputMatches") {
        // The compile refinement reports at the condition root; it belongs
        // to the regex field in the drawer.
        errors.regex ??= issue.message;
      }
    }
  }
  const max = data.maxIterations;
  if (max !== undefined) {
    if (!Number.isInteger(max) || max < 1) {
      errors.maxIterations ??= "maxIterations must be an integer >= 1";
    } else if (max > EDGE_MAX_ITERATIONS_HARD_CAP) {
      errors.maxIterations ??= `maxIterations above ${EDGE_MAX_ITERATIONS_HARD_CAP} is clamped at run time`;
    }
  }
  return errors;
}

/** Clamps a typed iteration cap into the valid 1..hard-cap band. */
export function clampMaxIterations(value: number): number {
  if (!Number.isFinite(value)) return EDGE_MAX_ITERATIONS_DEFAULT;
  return Math.min(EDGE_MAX_ITERATIONS_HARD_CAP, Math.max(1, Math.trunc(value)));
}

// ---------------------------------------------------------------------------
// Cycle membership (cycle guard visibility)
//

/** node id → nodes reachable from it via ≥ 1 edge (unknown endpoints skipped). */
function reachability(doc: CanvasDocument): Map<string, Set<string>> {
  const known = new Set(doc.nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  for (const edge of doc.edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    const bucket = outgoing.get(edge.source);
    if (bucket === undefined) outgoing.set(edge.source, [edge.target]);
    else bucket.push(edge.target);
  }
  const reach = new Map<string, Set<string>>();
  for (const node of doc.nodes) {
    const seen = new Set<string>();
    const queue = [...(outgoing.get(node.id) ?? [])];
    while (queue.length > 0) {
      const next = queue.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(outgoing.get(next) ?? []));
    }
    reach.set(node.id, seen);
  }
  return reach;
}

/**
 * Edges participating in a cycle — their target can reach their source
 * (self-loops included) — exactly the set the schema's normalization gives
 * a default `maxIterations`, so the drawer knows when to show the guard.
 */
export function cyclicEdgeIds(doc: CanvasDocument): Set<string> {
  const reach = reachability(doc);
  const cyclic = new Set<string>();
  for (const edge of doc.edges) {
    if (edge.source === edge.target || (reach.get(edge.target) ?? new Set()).has(edge.source)) {
      cyclic.add(edge.id);
    }
  }
  return cyclic;
}

// ---------------------------------------------------------------------------
// Router evaluation order
//

/** One row of the drawer's order list: an outgoing edge + its effective order. */
export interface RouterRow {
  edge: CanvasEdge;
  /** Effective order (explicit `order`, else the edges-array index) — conditionals only. */
  order: number;
  /** False for the `always` fallback, which is evaluated last regardless. */
  conditional: boolean;
}

/**
 * The source node's outgoing edges as the drawer lists them: conditional
 * edges first, sorted by effective order — exactly the sequence the engine
 * evaluates (first match wins) — with the `always` fallback pinned last.
 */
export function routerRows(doc: CanvasDocument, sourceNodeId: string): RouterRow[] {
  const siblings = doc.edges
    .map((edge, index) => ({ edge, index }))
    .filter((item) => item.edge.source === sourceNodeId);
  const conditional = siblings
    .filter((item) => !isUnconditionalEdge(item.edge.data))
    .sort((a, b) => (a.edge.data.order ?? a.index) - (b.edge.data.order ?? b.index))
    .map((item) => ({
      edge: item.edge,
      order: item.edge.data.order ?? item.index,
      conditional: true,
    }));
  const fallback = siblings
    .filter((item) => isUnconditionalEdge(item.edge.data))
    .map((item) => ({ edge: item.edge, order: item.index, conditional: false }));
  return [...conditional, ...fallback];
}

/**
 * Moves one conditional edge within its source's evaluation order (up =
 * evaluated earlier). The whole conditional sibling list is renumbered with
 * explicit contiguous orders 0..n-1 — unique by construction, so the graph
 * keeps passing the router-order validation; the `always` fallback stays
 * the fallback (it is never ordered and always evaluated last). No-ops
 * (unknown edge, the fallback itself, moving past either end) return the
 * document unchanged.
 */
export function moveRouterEdge(
  doc: CanvasDocument,
  edgeId: string,
  direction: -1 | 1,
): CanvasDocument {
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  if (edge === undefined || isUnconditionalEdge(edge.data)) return doc;

  const rows = routerRows(doc, edge.source).filter((row) => row.conditional);
  const at = rows.findIndex((row) => row.edge.id === edgeId);
  if (at === -1) return doc;
  const to = at + direction;
  if (to < 0 || to >= rows.length) return doc;

  const reordered = [...rows];
  const [moved] = reordered.splice(at, 1);
  if (moved === undefined) return doc;
  reordered.splice(to, 0, moved);

  const orderById = new Map(reordered.map((row, position) => [row.edge.id, position]));
  return {
    ...doc,
    edges: doc.edges.map((candidate) => {
      const order = orderById.get(candidate.id);
      return order === undefined ? candidate : { ...candidate, data: { ...candidate.data, order } };
    }),
  };
}

// ---------------------------------------------------------------------------
// Missing-fallback warnings
//

/**
 * Advisory warnings for nodes whose outgoing edges are all conditional (at
 * least one): if no condition matches at run time the engine has no
 * fallback to take and the run ends at that node. Rendered as the drawer
 * banner, the amber node badge and the validation panel's warning list —
 * never as a save-blocking issue.
 */
export function routerFallbackWarnings(doc: CanvasDocument): CanvasWarning[] {
  const warnings: CanvasWarning[] = [];
  for (const node of doc.nodes) {
    const siblings = doc.edges.filter((edge) => edge.source === node.id);
    if (siblings.length === 0) continue;
    const hasConditional = siblings.some((edge) => !isUnconditionalEdge(edge.data));
    const hasFallback = siblings.some((edge) => isUnconditionalEdge(edge.data));
    if (hasConditional && !hasFallback) {
      warnings.push({ nodeId: node.id, message: MISSING_FALLBACK_MESSAGE });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Fan-out notices (#116)
//

/**
 * Advisory notices for fan-out nodes (#116): a node with 2+ unconditional
 * outgoing edges fans out — legal parallelism since #115, surfaced as
 * "fan-out: branches run in parallel" instead of the old rejection. The
 * always+conditional MIX is still a hard blocker (core names fan-out vs
 * router in its message); pure fan-out only earns this notice.
 */
export function fanOutNotices(doc: CanvasDocument): CanvasWarning[] {
  const notices: CanvasWarning[] = [];
  for (const node of doc.nodes) {
    const unconditional = doc.edges.filter(
      (edge) => edge.source === node.id && isUnconditionalEdge(edge.data),
    );
    if (unconditional.length >= 2) {
      notices.push({ nodeId: node.id, message: FAN_OUT_NOTICE });
    }
  }
  return notices;
}

// ---------------------------------------------------------------------------
// Doc edits — the reducer the drawer drives
//

/** Edge inspector edits as doc transitions. */
export type EdgeInspectorAction =
  | { type: "patchEdge"; edgeId: string; patch: Partial<CanvasEdgeData> }
  | { type: "moveEdge"; edgeId: string; direction: -1 | 1 };

/**
 * Merges a patch into edge data: `undefined` values clear their key (e.g.
 * turning the negate toggle off), so data never lingers with
 * explicit-undefined keys.
 */
function mergeEdgeData(data: CanvasEdgeData, patch: Partial<CanvasEdgeData>): CanvasEdgeData {
  const merged = { ...data, ...patch };
  for (const key of Object.keys(merged)) {
    if (merged[key as keyof CanvasEdgeData] === undefined)
      delete merged[key as keyof CanvasEdgeData];
  }
  return merged;
}

/** Applies an edge inspector action to the document (unknown edges are no-ops). */
export function applyEdgeInspectorAction(
  doc: CanvasDocument,
  action: EdgeInspectorAction,
): CanvasDocument {
  if (action.type === "moveEdge") return moveRouterEdge(doc, action.edgeId, action.direction);
  if (!doc.edges.some((edge) => edge.id === action.edgeId)) return doc;
  return {
    ...doc,
    edges: doc.edges.map((edge) =>
      edge.id === action.edgeId ? { ...edge, data: mergeEdgeData(edge.data, action.patch) } : edge,
    ),
  };
}

/** Reducer form of {@link applyEdgeInspectorAction} (dispatch surface for tests/UX). */
export function edgeInspectorReducer(
  doc: CanvasDocument,
  action: EdgeInspectorAction,
): CanvasDocument {
  return applyEdgeInspectorAction(doc, action);
}
