import {
  WorkflowGraphShapeSchema,
  validateWorkflowGraph,
  type GraphValidationIssue,
} from "@openeuler/core";
import type { ApiErrorDetail } from "../api";
import { fromCanvasDocument, type CanvasDocument } from "./canvas-document";

/**
 * Canvas validation UX (#46): client-side pre-validation with the daemon's
 * exact rules (zod schemas from core), plus mapping of daemon 422 `details`
 * paths onto canvas targets (which node/edge gets the badge).
 *
 * Both sources produce the same {@link CanvasIssue} shape, so the summary
 * panel and badges cover client-side and server-side findings identically.
 */

export interface CanvasIssue {
  message: string;
  /** Offending node, when the issue is node-attributed. */
  nodeId?: string;
  /** Offending edge, when the issue is edge-attributed. */
  edgeId?: string;
  /** Dot-joined field path under the node/edge (e.g. `config.promptTemplate`). */
  field?: string;
}

/**
 * Severity split (#68): structural work-in-progress findings surface as
 * amber hints mid-editing; everything else is a hard red blocker. The split
 * is purely visual/tonal — ANY issue still blocks saving.
 */
export type IssueSeverity = "hint" | "blocker";

/** Friendly action copy for the hint class of issues (shown in the panel). */
export const UNREACHABLE_HINT = "Connect this node to the flow";
export const MISSING_CONDITION_HINT = "Set a condition on this edge";

interface PathTarget {
  nodeId?: string;
  edgeId?: string;
  field?: string;
}

/** Resolves a zod-style array path against the document it was built from. */
function resolvePath(doc: CanvasDocument, path: readonly (string | number)[]): PathTarget {
  const [head, index, ...rest] = path;
  if (head === "nodes" && typeof index === "number") {
    const node = doc.nodes[index];
    const field = rest.join(".");
    return node === undefined ? { field } : { nodeId: node.id, field: field || undefined };
  }
  if (head === "edges" && typeof index === "number") {
    const edge = doc.edges[index];
    const field = rest.join(".");
    return edge === undefined ? { field } : { edgeId: edge.id, field: field || undefined };
  }
  if (head === "entryNodeId") {
    const entry = doc.nodes.find((node) => node.data.kind === "agent" && node.data.isEntry);
    return entry === undefined
      ? { field: "entryNodeId" }
      : { nodeId: entry.id, field: "entryNodeId" };
  }
  return {};
}

function issueFrom(
  doc: CanvasDocument,
  path: readonly (string | number)[],
  message: string,
): CanvasIssue {
  return { message, ...resolvePath(doc, path) };
}

function dedupe(issues: CanvasIssue[]): CanvasIssue[] {
  const seen = new Set<string>();
  const unique: CanvasIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.nodeId ?? ""}|${issue.edgeId ?? ""}|${issue.field ?? ""}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}

/**
 * Collapses overlapping issues from multiple sources (live client validation
 * + daemon 422 mappings) onto one list, keeping first-seen order.
 */
export function dedupeIssues(...lists: readonly CanvasIssue[][]): CanvasIssue[] {
  return dedupe(lists.flat());
}

/**
 * Client-side validation of the canvas document, mirroring the daemon's
 * `PUT /graph` rules exactly: field-level zod issues (empty prompts, bad
 * conditions, …) plus cross-field rules from `validateWorkflowGraph`
 * (reachability, unconditional cycles, router order, upstream template
 * references, …). Empty result = safe to save.
 */
export function validateCanvasDocument(doc: CanvasDocument): CanvasIssue[] {
  const shape = fromCanvasDocument(doc);
  const issues: CanvasIssue[] = [];

  const zodResult = WorkflowGraphShapeSchema.safeParse(shape);
  if (!zodResult.success) {
    for (const issue of zodResult.error.issues) {
      issues.push(issueFrom(doc, issue.path as Array<string | number>, issue.message));
    }
  }

  for (const issue of validateWorkflowGraph(shape) as GraphValidationIssue[]) {
    issues.push(issueFrom(doc, issue.path, issue.message));
  }

  return dedupe(issues);
}

/**
 * Maps daemon 422 `details` (dot-joined paths like
 * `graph.nodes.2.config.promptTemplate`) onto canvas targets (#73):
 * array indexes are resolved against `requestDoc` — the document that was
 * serialized for the failed PUT, so indexes line up even if the user
 * edited the graph while the request was in flight — and the resolved ids
 * are then checked against `currentDoc` for badge placement: an element
 * deleted mid-flight cannot carry a badge, so its findings drop silently
 * (the doc has moved on, and the next doc change clears daemon
 * supplements anyway). Untargeted (graph-level) findings always pass
 * through.
 */
export function issuesFromApiDetails(
  requestDoc: CanvasDocument,
  currentDoc: CanvasDocument,
  details: readonly ApiErrorDetail[],
): CanvasIssue[] {
  const nodeIds = new Set(currentDoc.nodes.map((node) => node.id));
  const edgeIds = new Set(currentDoc.edges.map((edge) => edge.id));
  const issues: CanvasIssue[] = [];
  for (const detail of details) {
    const segments = detail.path
      .split(".")
      .filter((segment, index) => !(index === 0 && segment === "graph"))
      .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
    const issue = issueFrom(requestDoc, segments, detail.message);
    if (issue.nodeId !== undefined && !nodeIds.has(issue.nodeId)) continue;
    if (issue.edgeId !== undefined && !edgeIds.has(issue.edgeId)) continue;
    issues.push(issue);
  }
  return dedupe(issues);
}

/** Issues attributed to a node (any field). */
export function issuesForNode(issues: readonly CanvasIssue[], nodeId: string): CanvasIssue[] {
  return issues.filter((issue) => issue.nodeId === nodeId);
}

/** Issues attributed to an edge (any field). */
export function issuesForEdge(issues: readonly CanvasIssue[], edgeId: string): CanvasIssue[] {
  return issues.filter((issue) => issue.edgeId === edgeId);
}

/** Issues with neither node nor edge target (whole-graph, e.g. entryNodeId). */
export function graphLevelIssues(issues: readonly CanvasIssue[]): CanvasIssue[] {
  return issues.filter((issue) => issue.nodeId === undefined && issue.edgeId === undefined);
}

/** Short badge label for a node/edge carrying issues (count-capped). */
export function badgeLabelFor(issues: readonly CanvasIssue[]): string {
  if (issues.length === 0) return "";
  const first = issues[0] as CanvasIssue;
  return issues.length === 1 ? "1 issue" : `${issues.length} issues — ${first.message}`;
}

// ---------------------------------------------------------------------------
// Severity classification (#68)
//

/**
 * Node-attributed reachability finding from `validateWorkflowGraph`
 * (`node "…" is not reachable from the entry node "…"`): expected
 * mid-editing while the user is still wiring a freshly dropped node.
 */
function isUnreachableIssue(issue: CanvasIssue): boolean {
  return (
    issue.nodeId !== undefined &&
    issue.edgeId === undefined &&
    issue.message.includes("is not reachable from the entry node")
  );
}

/**
 * Edge-attributed "condition not filled in yet" finding: the zod
 * non-empty-string violation on a conditional edge's `pattern`/`regex` —
 * the placeholder state the type switcher creates. A typed-but-broken
 * regex (does not compile / bad flags) is a hard blocker instead.
 */
function isMissingConditionIssue(issue: CanvasIssue): boolean {
  return (
    issue.edgeId !== undefined &&
    (issue.field === "condition.pattern" || issue.field === "condition.regex") &&
    issue.message.includes("must be a non-empty string")
  );
}

/**
 * Node-attributed "join still half-wired" finding: a join with fewer than
 * two incoming edges — expected mid-editing while the user wires branches.
 */
function isHalfWiredJoinIssue(issue: CanvasIssue): boolean {
  return (
    issue.nodeId !== undefined &&
    issue.edgeId === undefined &&
    issue.message.includes("a join merges at least two branches")
  );
}

const JOIN_HINT = "connect at least two branches into this join";

/**
 * Pure severity mapping for an issue: `'hint'` for structural WIP
 * (unreachable node, edge missing its condition pattern, half-wired join),
 * `'blocker'` for everything else (empty prompt, bad regex, fan-out/router
 * mixing, exit-node outgoing edges, non-upstream `{{output:}}`, …). Purely
 * tonal — both severities block the save; see the editor's save gating.
 */
export function classifyIssue(issue: CanvasIssue): IssueSeverity {
  if (
    isUnreachableIssue(issue) ||
    isMissingConditionIssue(issue) ||
    isHalfWiredJoinIssue(issue)
  ) {
    return "hint";
  }
  return "blocker";
}

/** Friendly "what to do" copy for a hint issue (undefined for blockers). */
export function issueHint(issue: CanvasIssue): string | undefined {
  if (isUnreachableIssue(issue)) return UNREACHABLE_HINT;
  if (isMissingConditionIssue(issue)) return MISSING_CONDITION_HINT;
  if (isHalfWiredJoinIssue(issue)) return JOIN_HINT;
  return undefined;
}

/** Issues split by severity, blockers first. */
export function splitIssuesBySeverity(issues: readonly CanvasIssue[]): {
  blockers: CanvasIssue[];
  hints: CanvasIssue[];
} {
  const blockers: CanvasIssue[] = [];
  const hints: CanvasIssue[] = [];
  for (const issue of issues) {
    (classifyIssue(issue) === "hint" ? hints : blockers).push(issue);
  }
  return { blockers, hints };
}

/**
 * One-line severity summary for panels/toasts, e.g. `"2 blockers · 1 hint"`;
 * empty string when there are no issues.
 */
export function severitySummary(issues: readonly CanvasIssue[]): string {
  const { blockers, hints } = splitIssuesBySeverity(issues);
  const parts: string[] = [];
  if (blockers.length > 0)
    parts.push(`${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`);
  if (hints.length > 0) parts.push(`${hints.length} hint${hints.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Save-block messaging + daemon-supplement clearing (#69)
//

/**
 * "source → target" label for an edge (node names when they resolve, ids
 * otherwise) — the human-readable way issues and toasts name an edge.
 */
export function edgeTargetLabel(doc: CanvasDocument, edgeId: string): string | undefined {
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  if (edge === undefined) return undefined;
  const nameOf = (id: string): string => doc.nodes.find((node) => node.id === id)?.data.name ?? id;
  return `${nameOf(edge.source)} → ${nameOf(edge.target)}`;
}

/**
 * Every edge the save-block should call out by name: the edges behind
 * missing-condition hints, as `"source → target"` labels in issue order.
 */
export function missingConditionEdgeLabels(
  doc: CanvasDocument,
  issues: readonly CanvasIssue[],
): string[] {
  const labels: string[] = [];
  for (const issue of issues) {
    if (issue.edgeId === undefined || issueHint(issue) !== MISSING_CONDITION_HINT) continue;
    const label = edgeTargetLabel(doc, issue.edgeId);
    if (label !== undefined && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * Save-block toast description (#69): the severity summary plus, when any
 * edge still lacks its condition, an explicit "Set a condition on
 * source → target" callout so the blocked user knows exactly which edge
 * and what to do about it.
 */
export function saveBlockMessage(doc: CanvasDocument, issues: readonly CanvasIssue[]): string {
  const base = `${severitySummary(issues)} must be fixed — see the validation panel.`;
  const targets = missingConditionEdgeLabels(doc, issues);
  if (targets.length === 0) return base;
  return `Set a condition on ${targets.join(", ")}. ${base}`;
}

/**
 * Functional updater for clearing daemon-supplement issues on doc change
 * (#69 QA): identity-preserving when the list is already empty (React
 * bails out — no redundant re-render, no double validation run) and a
 * fresh empty array otherwise.
 */
export function clearIssuesIfStale(prev: CanvasIssue[]): CanvasIssue[] {
  return prev.length > 0 ? [] : prev;
}
