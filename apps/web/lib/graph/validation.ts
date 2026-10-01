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
 * paths onto canvas targets (which node/edge gets the red badge).
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
 * `graph.nodes.2.config.promptTemplate`) onto canvas targets. Paths are
 * resolved against the document that was serialized for the failed request,
 * so array indexes line up.
 */
export function issuesFromApiDetails(
  doc: CanvasDocument,
  details: readonly ApiErrorDetail[],
): CanvasIssue[] {
  const issues: CanvasIssue[] = [];
  for (const detail of details) {
    const segments = detail.path
      .split(".")
      .filter((segment, index) => !(index === 0 && segment === "graph"))
      .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
    issues.push(issueFrom(doc, segments, detail.message));
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
