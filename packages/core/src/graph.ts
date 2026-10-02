import { z } from "zod";
import { idSchema } from "./common.js";
import { extractOutputReferences } from "./prompt.js";
import { ExitConditionSchema, StepConfigSchema } from "./workflow.js";
import type { ExitCondition, LoopBack, Step, StepConfig } from "./workflow.js";

/**
 * Graph workflow model (LangGraph-style): agent nodes connected by
 * conditional edges. A linear `steps` + `loopBack` workflow is the special
 * case "chain of `always` edges plus one conditional loop-back edge"; use
 * {@link linearToGraph} / {@link graphToLinear} to translate between the two
 * shapes.
 */

export const GraphNodePositionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
});

export type GraphNodePosition = z.infer<typeof GraphNodePositionSchema>;

/** An agent invocation on the canvas; the only node type that executes. */
export const AgentGraphNodeSchema = z.strictObject({
  id: idSchema,
  type: z.literal("agent"),
  name: z.string().min(1, "node name must be a non-empty string"),
  /** Persisted for canvas layout; semantics-free. */
  position: GraphNodePositionSchema,
  config: StepConfigSchema,
  /**
   * Preset the node was created from (#49), carried for inspector
   * provenance only: the node keeps its own config copy, and "Update from
   * preset" is always explicit. Optional, so pre-preset graphs stay valid.
   */
  presetId: idSchema.optional(),
});

export type AgentGraphNode = z.infer<typeof AgentGraphNodeSchema>;

/**
 * Terminal marker node. A run reaching an exit node ends successfully;
 * migrating legacy `loopBack` workflows emits one so the loop router has an
 * explicit `always` fallback edge ("exit unless the loop edge matches").
 */
export const ExitGraphNodeSchema = z.strictObject({
  id: idSchema,
  type: z.literal("exit"),
  name: z.string().min(1, "node name must be a non-empty string"),
  position: GraphNodePositionSchema,
});

export type ExitGraphNode = z.infer<typeof ExitGraphNodeSchema>;

export const GraphNodeSchema = z.discriminatedUnion("type", [
  AgentGraphNodeSchema,
  ExitGraphNodeSchema,
]);

export type GraphNode = z.infer<typeof GraphNodeSchema>;

/**
 * A directed edge. `condition` decides (evaluated against the source node's
 * final output) whether the edge may be taken; `always` edges are the
 * unconditional chain/fallback. A node whose outgoing edges mix conditionals
 * with (at most one) `always` edge is a **router**: the engine evaluates the
 * conditional edges in `order` (first match wins, enforced by #45) and falls
 * back to the `always` edge — or, with none, ends the run.
 *
 * `invert` negates the condition at evaluation time (`invert ? !match :
 * match`). It exists so legacy `loopBack` semantics — loop while the exit
 * condition is UNMET — survive translation for condition shapes with no
 * direct negation (`outputMatches`, `always`).
 */
export const GraphEdgeSchema = z.strictObject({
  id: idSchema,
  source: idSchema,
  target: idSchema,
  condition: ExitConditionSchema.default({ type: "always" }),
  /** Router evaluation order among a node's conditional outgoing edges. */
  order: z.number().int().min(0, "order must be an integer >= 0").optional(),
  /**
   * How often this edge may be traversed in one run (cycle guard). Defaults
   * to {@link DEFAULT_EDGE_MAX_ITERATIONS} for edges that participate in a
   * cycle (filled by the schema's normalization transform).
   */
  maxIterations: z.number().int().min(1, "maxIterations must be an integer >= 1").optional(),
  invert: z.boolean().optional(),
});

export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/** Zod-input view of an edge (condition still optional before defaulting). */
type GraphEdgeInput = z.input<typeof GraphEdgeSchema>;

export const WorkflowGraphShapeSchema = z.strictObject({
  entryNodeId: idSchema,
  nodes: z.array(GraphNodeSchema).min(1, "a workflow graph needs at least one node"),
  edges: z.array(GraphEdgeSchema).default([]),
});

/** Structural graph shape before cross-field validation/normalization. */
export type WorkflowGraphShape = {
  entryNodeId: string;
  nodes: GraphNode[];
  edges: Array<GraphEdgeInput & { id: string; source: string; target: string }>;
};

/** A validation problem attributed to a node/edge path, for API 422 details. */
export interface GraphValidationIssue {
  path: (string | number)[];
  message: string;
}

/** Whether an edge is unconditional — an always edge that is not inverted. */
const isUnconditional = (edge: { condition?: ExitCondition; invert?: boolean }): boolean =>
  (edge.condition ?? { type: "always" }).type === "always" && edge.invert !== true;

/** Default cycle guard for edges that participate in a cycle. */
export const DEFAULT_EDGE_MAX_ITERATIONS = 3;

interface GraphIndex {
  nodeIds: Set<string>;
  /** node id → outgoing edges (with their index in the edges array). */
  outgoing: Map<
    string,
    Array<{ edge: GraphEdgeInput & { id: string; source: string; target: string }; index: number }>
  >;
  /** node id → nodes reachable from it via ≥ 1 edge (unknown endpoints skipped). */
  reach: Map<string, Set<string>>;
}

/** Builds adjacency + transitive reachability over the valid edges. */
function indexGraph(graph: WorkflowGraphShape): GraphIndex {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const outgoing = new Map<
    string,
    Array<{ edge: GraphEdgeInput & { id: string; source: string; target: string }; index: number }>
  >();
  for (const [index, edge] of graph.edges.entries()) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const bucket = outgoing.get(edge.source);
    if (bucket === undefined) outgoing.set(edge.source, [{ edge, index }]);
    else bucket.push({ edge, index });
  }
  const reach = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    const seen = new Set<string>();
    const queue = [...(outgoing.get(node.id) ?? [])].map((item) => item.edge.target);
    while (queue.length > 0) {
      const next = queue.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const item of outgoing.get(next) ?? []) queue.push(item.edge.target);
    }
    reach.set(node.id, seen);
  }
  return { nodeIds, outgoing, reach };
}

/**
 * Cross-field validation for a workflow graph:
 *
 * - unique node/edge ids; edges reference existing nodes
 * - `entryNodeId` references an existing agent node (exactly one entry)
 * - every node is reachable from the entry (BFS over edges)
 * - unconditional cycles rejected: the `always` (non-inverted) subgraph must
 *   be acyclic — every cycle has to include at least one conditional edge
 * - at most one unconditional outgoing edge per node; > 1 is ambiguous
 * - router `order` unique among a node's conditional outgoing edges
 * - exit nodes are terminals (no outgoing edges)
 * - `{{output:<nodeId>}}` template references point at upstream nodes only
 *   (nodes with a path to the referencing node, excluding itself)
 *
 * Returns the issues (empty = valid); {@link WorkflowGraphSchema} feeds them
 * into zod so API callers get node/edge-attributed 422 details.
 */
export function validateWorkflowGraph(graph: WorkflowGraphShape): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const push = (path: (string | number)[], message: string): void => {
    issues.push({ path, message });
  };

  // Unique node ids.
  const seenNodeIds = new Set<string>();
  for (const [index, node] of graph.nodes.entries()) {
    if (seenNodeIds.has(node.id)) {
      push(["nodes", index, "id"], `duplicate node id "${node.id}"`);
    }
    seenNodeIds.add(node.id);
  }

  // Unique edge ids + endpoints exist.
  const seenEdgeIds = new Set<string>();
  for (const [index, edge] of graph.edges.entries()) {
    if (seenEdgeIds.has(edge.id)) {
      push(["edges", index, "id"], `duplicate edge id "${edge.id}"`);
    }
    seenEdgeIds.add(edge.id);
    if (!seenNodeIds.has(edge.source)) {
      push(
        ["edges", index, "source"],
        `edge "${edge.id}" references unknown source node "${edge.source}"`,
      );
    }
    if (!seenNodeIds.has(edge.target)) {
      push(
        ["edges", index, "target"],
        `edge "${edge.id}" references unknown target node "${edge.target}"`,
      );
    }
  }

  const index = indexGraph(graph);

  // Exactly one entry: entryNodeId exists (and is an executable agent node).
  const entry = graph.nodes.find((node) => node.id === graph.entryNodeId);
  if (entry === undefined) {
    push(["entryNodeId"], `entryNodeId "${graph.entryNodeId}" does not reference any node`);
  } else if (entry.type !== "agent") {
    push(
      ["entryNodeId"],
      `entryNodeId "${graph.entryNodeId}" must reference an agent node, not an ${entry.type} node`,
    );
  }

  // Every node reachable from the entry (BFS).
  const reachableFromEntry = index.reach.get(graph.entryNodeId) ?? new Set<string>();
  for (const [nodeIndex, node] of graph.nodes.entries()) {
    if (node.id !== graph.entryNodeId && !reachableFromEntry.has(node.id)) {
      push(
        ["nodes", nodeIndex],
        `node "${node.id}" is not reachable from the entry node "${graph.entryNodeId}"`,
      );
    }
  }

  // Unconditional cycles: the always (non-inverted) subgraph must be acyclic.
  const alwaysOutgoing = new Map<string, Array<{ target: string; edgeIndex: number }>>();
  for (const [edgeIndex, edge] of graph.edges.entries()) {
    if (
      !isUnconditional(edge) ||
      !index.nodeIds.has(edge.source) ||
      !index.nodeIds.has(edge.target)
    ) {
      continue;
    }
    const bucket = alwaysOutgoing.get(edge.source);
    if (bucket === undefined) alwaysOutgoing.set(edge.source, [{ target: edge.target, edgeIndex }]);
    else bucket.push({ target: edge.target, edgeIndex });
  }
  const cycle = findAlwaysCycle(alwaysOutgoing);
  if (cycle !== undefined) {
    push(
      ["edges", cycle.edgeIndex],
      `unconditional cycle rejected (every cycle needs at least one conditional edge): ${cycle.path.join(" -> ")}`,
    );
  }

  for (const [nodeIndex, node] of graph.nodes.entries()) {
    const siblings = index.outgoing.get(node.id) ?? [];

    // Exit nodes are terminals.
    if (node.type === "exit" && siblings.length > 0) {
      push(["nodes", nodeIndex, "type"], `exit node "${node.id}" must not have outgoing edges`);
    }

    // At most one unconditional outgoing edge per node.
    const unconditional = siblings.filter((item) => isUnconditional(item.edge));
    if (unconditional.length > 1) {
      push(
        ["edges", unconditional[1]?.index ?? 0],
        `node "${node.id}" has ${unconditional.length} unconditional (always) outgoing edges; at most one is allowed (as the router fallback)`,
      );
    }

    // Router order: unique effective order (explicit, else edges-array index)
    // among the node's conditional outgoing edges.
    const conditional = siblings.filter((item) => !isUnconditional(item.edge));
    if (conditional.length > 0) {
      const byOrder = new Map<number, string>();
      for (const item of conditional) {
        const order = item.edge.order ?? item.index;
        const clash = byOrder.get(order);
        if (clash !== undefined) {
          push(
            ["edges", item.index, "order"],
            `node "${node.id}" has conditional outgoing edges "${clash}" and "${item.edge.id}" with the same order ${order}; router evaluation order must be unique`,
          );
        } else {
          byOrder.set(order, item.edge.id);
        }
      }
    }
  }

  // {{output:<nodeId>}} references must point upstream (a node with a path to
  // the referencing node, excluding itself).
  for (const [nodeIndex, node] of graph.nodes.entries()) {
    if (node.type !== "agent") continue;
    const upstream = new Set<string>();
    for (const other of graph.nodes) {
      if (other.id !== node.id && (index.reach.get(other.id) ?? new Set<string>()).has(node.id)) {
        upstream.add(other.id);
      }
    }
    for (const ref of extractOutputReferences(node.config.promptTemplate)) {
      if (!upstream.has(ref)) {
        push(
          ["nodes", nodeIndex, "config", "promptTemplate"],
          `template references {{output:${ref}}}, which is not an upstream node of "${node.id}" (upstream: ${
            upstream.size > 0 ? [...upstream].join(", ") : "none"
          })`,
        );
      }
    }
  }

  return issues;
}

/** Finds a cycle in the unconditional subgraph (DFS), if any. */
function findAlwaysCycle(
  alwaysOutgoing: Map<string, Array<{ target: string; edgeIndex: number }>>,
): { path: string[]; edgeIndex: number } | undefined {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const colorOf = (node: string): number => color.get(node) ?? WHITE;
  const stack: Array<{ node: string; viaEdge: number; path: string[] }> = [];
  const nodes = new Set<string>(alwaysOutgoing.keys());
  for (const edges of alwaysOutgoing.values()) {
    for (const edge of edges) nodes.add(edge.target);
  }
  for (const root of nodes) {
    if (colorOf(root) !== WHITE) continue;
    stack.push({ node: root, viaEdge: -1, path: [root] });
    color.set(root, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { node: string; viaEdge: number; path: string[] };
      const edges = alwaysOutgoing.get(frame.node) ?? [];
      // A gray target sits on the current DFS path: cycle found.
      const gray = edges.find((item) => colorOf(item.target) === GRAY);
      if (gray !== undefined) {
        const start = frame.path.indexOf(gray.target);
        return {
          path: [...frame.path.slice(start === -1 ? 0 : start), gray.target],
          edgeIndex: gray.edgeIndex,
        };
      }
      const next = edges.find((item) => colorOf(item.target) === WHITE);
      if (next === undefined) {
        color.set(frame.node, BLACK);
        stack.pop();
        continue;
      }
      color.set(next.target, GRAY);
      stack.push({
        node: next.target,
        viaEdge: next.edgeIndex,
        path: [...frame.path, next.target],
      });
    }
  }
  return undefined;
}

/**
 * Normalization applied on save: router siblings missing `order` get their
 * edges-array index; edges participating in a cycle (their target can reach
 * their source) get the default cycle guard when none was configured.
 */
function normalizeWorkflowGraph(graph: WorkflowGraphShape): WorkflowGraph {
  const index = indexGraph(graph);
  const multiOutgoing = new Set(
    [...index.outgoing.entries()].filter(([, edges]) => edges.length > 1).map(([id]) => id),
  );
  const edges = graph.edges.map((edge, arrayIndex) => {
    let next = edge as GraphEdge;
    if (multiOutgoing.has(edge.source) && edge.order === undefined) {
      next = { ...next, order: arrayIndex };
    }
    if (
      edge.maxIterations === undefined &&
      (index.reach.get(edge.target) ?? new Set<string>()).has(edge.source)
    ) {
      next = { ...next, maxIterations: DEFAULT_EDGE_MAX_ITERATIONS };
    }
    return next;
  });
  return { entryNodeId: graph.entryNodeId, nodes: graph.nodes, edges };
}

export const WorkflowGraphSchema = WorkflowGraphShapeSchema.superRefine((graph, ctx) => {
  for (const issue of validateWorkflowGraph(graph)) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
}).transform((graph) => normalizeWorkflowGraph(graph));

/** A validated + normalized workflow graph (what revisions snapshot). */
export interface WorkflowGraph {
  entryNodeId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Node lookup helper (undefined when the id is unknown). */
export function findGraphNode(graph: WorkflowGraph, nodeId: string): GraphNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

/**
 * Read-model summary of a graph snapshot (#70): what the workflows list
 * renders instead of the legacy steps mirror. `hasLoop` = the graph has a
 * back-edge (an edge whose target can reach its source, closing a cycle;
 * validation guarantees every cycle runs through a conditional edge);
 * `hasRouter` = some node has more than one outgoing edge.
 */
export interface GraphSummary {
  nodeCount: number;
  edgeCount: number;
  hasLoop: boolean;
  hasRouter: boolean;
  /** Revision number the summary was computed from. */
  revision: number;
}

/** Computes the {@link GraphSummary} of a validated graph snapshot. */
export function summarizeGraph(graph: WorkflowGraph, revision: number): GraphSummary {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const bucket = outgoing.get(edge.source);
    if (bucket === undefined) outgoing.set(edge.source, [edge.target]);
    else bucket.push(edge.target);
  }
  const reachCache = new Map<string, Set<string>>();
  const reachable = (start: string): Set<string> => {
    const cached = reachCache.get(start);
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    const queue = [...(outgoing.get(start) ?? [])];
    while (queue.length > 0) {
      const next = queue.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(outgoing.get(next) ?? []));
    }
    reachCache.set(start, seen);
    return seen;
  };
  const hasLoop = graph.edges.some((edge) => reachable(edge.target).has(edge.source));
  const hasRouter = [...outgoing.values()].some((targets) => targets.length > 1);
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    hasLoop,
    hasRouter,
    revision,
  };
}

// ---------------------------------------------------------------------------
// Legacy (steps + loopBack) <-> graph translation.
//

/** Negation of an exit condition, as an edge condition (+invert when needed). */
function negateCondition(when: ExitCondition): { condition: ExitCondition; invert: boolean } {
  switch (when.type) {
    case "outputContains":
      return { condition: { type: "outputNotContains", pattern: when.pattern }, invert: false };
    case "outputNotContains":
      return { condition: { type: "outputContains", pattern: when.pattern }, invert: false };
    // No direct negation exists: keep the condition and negate at evaluation.
    case "outputMatches":
      return { condition: when, invert: true };
    case "always":
      return { condition: { type: "always" }, invert: true };
  }
}

/**
 * Undoes {@link negateCondition}: the legacy exit condition whose negation
 * produced this edge condition. Returns undefined when the legacy shape has
 * no representation (e.g. an uninverted `outputMatches` loop edge).
 */
function unNegateCondition(
  edge: Pick<GraphEdge, "condition" | "invert">,
): ExitCondition | undefined {
  const { condition, invert } = edge;
  if (invert === true) return condition;
  switch (condition.type) {
    case "outputContains":
      return { type: "outputNotContains", pattern: condition.pattern };
    case "outputNotContains":
      return { type: "outputContains", pattern: condition.pattern };
    // Negating outputMatches/always requires `invert`, handled above.
    case "outputMatches":
    case "always":
      return undefined;
  }
}

/** An id based on `base` not colliding with `taken` (first `base`, then -2, -3, …). */
function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Horizontal canvas spacing between chained nodes. */
const NODE_SPACING_X = 280;
const NODE_SPACING_Y = 40;

/**
 * Translates a legacy linear workflow (steps in order, optional loopBack)
 * into an equivalent graph: one agent node per step (reusing the step id),
 * chained with `always` edges, an `exit` node, and — when a loopBack exists —
 * a conditional loop edge from the LAST node back to `steps[toStepIndex]`
 * whose condition is the negated exit condition (`invert` for shapes without
 * a direct negation), carrying the loop's `maxIterations`. Legacy semantics
 * (loop while the exit condition is unmet; exit when met or at the cap) map
 * exactly onto router semantics (loop edge first, `always` exit fallback,
 * cycle guard).
 */
export function linearToGraph(workflow: {
  steps: Step[];
  loopBack?: LoopBack | undefined;
}): WorkflowGraph {
  const nodes: GraphNode[] = workflow.steps.map((step, index) => ({
    id: step.id,
    type: "agent",
    name: step.name,
    position: { x: index * NODE_SPACING_X, y: NODE_SPACING_Y },
    config: {
      driver: step.driver,
      ...(step.model === undefined ? {} : { model: step.model }),
      ...(step.agent === undefined ? {} : { agent: step.agent }),
      mode: step.mode,
      promptTemplate: step.promptTemplate,
      continueSession: step.continueSession,
    } satisfies StepConfig,
  }));
  const takenIds = new Set(nodes.map((node) => node.id));
  const exitId = uniqueId("exit", takenIds);
  const last = workflow.steps[workflow.steps.length - 1] as Step;
  nodes.push({
    id: exitId,
    type: "exit",
    name: "Exit",
    position: { x: workflow.steps.length * NODE_SPACING_X, y: NODE_SPACING_Y },
  });

  const edges: GraphEdge[] = [];
  for (const [index, step] of workflow.steps.entries()) {
    if (index === workflow.steps.length - 1) break;
    edges.push({
      id: `e-${step.id}-${workflow.steps[index + 1]?.id}`,
      source: step.id,
      target: (workflow.steps[index + 1] as Step).id,
      condition: { type: "always" },
    });
  }
  if (workflow.loopBack !== undefined) {
    const loopBack = workflow.loopBack;
    const { condition, invert } = negateCondition(loopBack.when);
    // Loop edge first (router order 0); the always exit edge is the fallback.
    edges.push({
      id: `e-loop-${last.id}-${workflow.steps[loopBack.toStepIndex]?.id}`,
      source: last.id,
      target: (workflow.steps[loopBack.toStepIndex] as Step).id,
      condition,
      ...(invert ? { invert: true } : {}),
      order: 0,
      maxIterations: loopBack.maxIterations,
    });
  }
  edges.push({
    id: `e-exit-${last.id}`,
    source: last.id,
    target: exitId,
    condition: { type: "always" },
  });

  return WorkflowGraphSchema.parse({
    entryNodeId: (workflow.steps[0] as Step).id,
    nodes,
    edges,
  });
}

/** Structural translation outcome of {@link graphToLinear}. */
export type GraphToLinearResult =
  { ok: true; steps: Step[]; loopBack: LoopBack | undefined } | { ok: false; reason: string };

/**
 * Inverse of {@link linearToGraph}: recognizes a simple chain of agent nodes
 * (single `always` edge each), optionally ending in an `exit` node, with at
 * most one conditional loop edge from the last agent node back to an earlier
 * (or the same) node — exactly the shape migration produces. Anything else
 * (routers, branches, `{{output:<nodeId>}}` templates) has no legacy
 * representation and reports `ok: false` with the reason.
 */
export function graphToLinear(graph: WorkflowGraph): GraphToLinearResult {
  const fail = (reason: string): GraphToLinearResult => ({ ok: false, reason });
  const agentNodes = graph.nodes.filter((node): node is AgentGraphNode => node.type === "agent");
  const exitNodes = graph.nodes.filter((node) => node.type === "exit");
  if (exitNodes.length > 1) {
    return fail(`graph has ${exitNodes.length} exit nodes; legacy workflows support at most one`);
  }

  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const bucket = outgoing.get(edge.source);
    if (bucket === undefined) outgoing.set(edge.source, [edge]);
    else bucket.push(edge);
  }

  // Walk the chain from the entry, following single unconditional edges.
  const entry = graph.nodes.find((node) => node.id === graph.entryNodeId);
  if (entry === undefined || entry.type !== "agent") {
    return fail(`entry node "${graph.entryNodeId}" is not an agent node`);
  }
  const chain: AgentGraphNode[] = [entry];
  const seen = new Set<string>([entry.id]);
  let loopEdge: GraphEdge | undefined;
  let exitEdge: GraphEdge | undefined;
  let current = entry;
  for (;;) {
    const edges = outgoing.get(current.id) ?? [];
    if (edges.length === 0) break;
    if (edges.length === 1) {
      const edge = edges[0] as GraphEdge;
      if (isUnconditional(edge)) {
        const target = graph.nodes.find((node) => node.id === edge.target);
        if (target === undefined)
          return fail(`edge "${edge.id}" targets unknown node "${edge.target}"`);
        if (target.type === "exit") {
          exitEdge = edge;
          break;
        }
        if (seen.has(target.id)) {
          return fail(
            `unconditional cycle through node "${target.id}" has no legacy representation`,
          );
        }
        seen.add(target.id);
        chain.push(target);
        current = target;
        continue;
      }
      loopEdge = edge;
      break;
    }
    if (edges.length > 2) {
      return fail(
        `node "${current.id}" has ${edges.length} outgoing edges; legacy workflows support at most a loop edge plus an exit edge`,
      );
    }
    const a = edges[0] as GraphEdge;
    const b = edges[1] as GraphEdge;
    if (isUnconditional(a) && !isUnconditional(b)) {
      loopEdge = b;
      exitEdge = a;
    } else if (isUnconditional(b) && !isUnconditional(a)) {
      loopEdge = a;
      exitEdge = b;
    } else {
      const kinds =
        isUnconditional(a) && isUnconditional(b)
          ? "unconditional"
          : !isUnconditional(a) && !isUnconditional(b)
            ? "conditional"
            : "mixed";
      return fail(
        `node "${current.id}" has two ${kinds} outgoing edges that do not form a loop+exit pair; this has no legacy representation`,
      );
    }
    break;
  }

  // Everything must fit the recognized chain.
  if (chain.length !== agentNodes.length) {
    return fail(
      `graph branches away from the entry chain (${chain.length} of ${agentNodes.length} agent nodes reachable in order); branching has no legacy representation`,
    );
  }
  if (exitEdge !== undefined) {
    const target = graph.nodes.find((node) => node.id === exitEdge.target);
    if (target === undefined || target.type !== "exit") {
      return fail(`exit edge "${exitEdge.id}" does not target the exit node`);
    }
  } else if (exitNodes.length > 0) {
    const exitId = (exitNodes[0] as ExitGraphNode).id;
    const referenced = graph.edges.some((edge) => edge.target === exitId);
    if (referenced) {
      return fail(`exit node "${exitId}" is not reachable at the end of the chain`);
    }
    return fail(`exit node "${exitId}" is not connected to the last chain node`);
  }
  if (chain.some((node) => extractOutputReferences(node.config.promptTemplate).length > 0)) {
    return fail(
      "prompt templates use {{output:<nodeId>}} references, which the linear engine cannot resolve (graph execution engine lands in #45)",
    );
  }

  const steps: Step[] = chain.map((node) => ({
    id: node.id,
    name: node.name,
    driver: node.config.driver,
    ...(node.config.model === undefined ? {} : { model: node.config.model }),
    ...(node.config.agent === undefined ? {} : { agent: node.config.agent }),
    mode: node.config.mode,
    promptTemplate: node.config.promptTemplate,
    continueSession: node.config.continueSession,
  }));

  let loopBack: LoopBack | undefined;
  if (loopEdge !== undefined) {
    const targetIndex = chain.findIndex((node) => node.id === loopEdge?.target);
    // Legacy loops jump back from the LAST step only; self-loops are fine.
    const lastIndex = chain.length - 1;
    const isFromLast = graph.edges.some(
      (edge) => edge.id === loopEdge?.id && edge.source === (chain[lastIndex] as AgentGraphNode).id,
    );
    if (!isFromLast || targetIndex === -1) {
      return fail(
        `loop edge "${loopEdge.id}" is not a loop-back from the last chain node to an earlier node`,
      );
    }
    const when = unNegateCondition(loopEdge);
    if (when === undefined) {
      return fail(`loop edge "${loopEdge.id}" condition has no negatable legacy representation`);
    }
    loopBack = {
      toStepIndex: targetIndex,
      when,
      maxIterations: loopEdge.maxIterations ?? DEFAULT_EDGE_MAX_ITERATIONS,
    };
  }

  return { ok: true, steps, loopBack };
}
