import { z } from "zod";
import { WorkflowArtifactsSchema } from "./artifacts.js";
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

/**
 * Join/merge configuration (#115): how the join decides its branches have
 * settled. `all` (default) waits for EVERY incoming edge to arrive; `any`
 * triggers on the first arrival (failures tolerated while another branch
 * can still arrive).
 */
export const JoinNodeConfigSchema = z.strictObject({
  mode: z.enum(["all", "any"]).default("all"),
});

export type JoinNodeConfig = z.infer<typeof JoinNodeConfigSchema>;

/**
 * Synchronizer node (#115): the fan-in counterpart of a fan-out. A join has
 * multiple incoming edges (any condition type) and AT MOST ONE outgoing
 * edge, which must be unconditional — a join synchronizes branches, it
 * never routes. On trigger (per `config.mode`) the join "executes"
 * instantly (no driver): its output is the JSON map
 * `{<branchSourceNodeId>: <output>}` of the arrived branches, available
 * downstream as `{{output:<joinId>}}` (the branch outputs themselves stay
 * addressable as `{{output:<branchNodeId>}}`).
 */
export const JoinGraphNodeSchema = z.strictObject({
  id: idSchema,
  type: z.literal("join"),
  name: z.string().min(1, "node name must be a non-empty string"),
  position: GraphNodePositionSchema,
  config: JoinNodeConfigSchema.default({ mode: "all" }),
});

export type JoinGraphNode = z.infer<typeof JoinGraphNodeSchema>;

/**
 * How a sub-workflow node (#117) pins the revision of the workflow it
 * spawns: `'latest'` resolves at execution time (each child run pins what
 * is latest when it starts), a number pins that exact revision.
 */
export const SubworkflowRevisionSchema = z.union([
  z.literal("latest"),
  z
    .number()
    .int("revision must be 'latest' or an integer >= 1")
    .min(1, "revision must be 'latest' or an integer >= 1"),
]);

export type SubworkflowRevision = z.infer<typeof SubworkflowRevisionSchema>;

/**
 * Sub-workflow node (#117): composes teams of teams. On execution the
 * engine spawns a CHILD RUN of the referenced workflow (pinned to the
 * resolved revision) and waits for its completion — the node's output is
 * the child run's final output, and the child run surfaces as a link
 * (`parentRunId`) on the node and in the runs table. Child failure fails
 * the node (v0.2 strict — no continue-on-fail); nesting is capped by the
 * engine at {@link MAX_SUBWORKFLOW_DEPTH}. For graph-shape rules the node
 * behaves like an agent node: it can be the entry, sit on branches, feed
 * joins, and its output is addressable downstream as `{{output:<id>}}`.
 */
export const SubworkflowGraphNodeSchema = z.strictObject({
  id: idSchema,
  type: z.literal("subworkflow"),
  name: z.string().min(1, "node name must be a non-empty string"),
  position: GraphNodePositionSchema,
  config: z.strictObject({
    workflowId: idSchema,
    revision: SubworkflowRevisionSchema,
  }),
});

export type SubworkflowGraphNode = z.infer<typeof SubworkflowGraphNodeSchema>;

/**
 * Smallest accepted `approval.timeoutMinutes` (#118): a gate must leave a
 * real review window, not flap.
 */
export const MIN_APPROVAL_TIMEOUT_MINUTES = 1;

/** Largest accepted `approval.timeoutMinutes` — 24h (#118). */
export const MAX_APPROVAL_TIMEOUT_MINUTES = 24 * 60;

const approvalTimeoutMinutesSchema = z
  .number()
  .int("timeoutMinutes must be an integer")
  .min(MIN_APPROVAL_TIMEOUT_MINUTES, `timeoutMinutes must be >= ${MIN_APPROVAL_TIMEOUT_MINUTES}`)
  .max(
    MAX_APPROVAL_TIMEOUT_MINUTES,
    `timeoutMinutes must be <= ${MAX_APPROVAL_TIMEOUT_MINUTES} (24h)`,
  );

/**
 * Human approval gate node (#118): a PAUSE in the run. On execution the
 * engine emits `node.awaiting` (carrying `config.prompt` for the approver),
 * flips the node's StepRun to `awaiting_approval`, records the gate on the
 * run row (`awaitingNodeId` + `awaitingSince`) and WAITS — no driver runs.
 * Resolution: approve → node completes with the note (default
 * `"approved"`) as output; reject/timeout → the node still completes
 * (output `rejected: <note>`), and ROUTING decides: conditional outgoing
 * edges branch on the `"approved"`/`"rejected"` sentinels (never the note
 * text), while a rejection with no matching conditional branch fails the
 * run. A timeout is a rejection with note `"timed out"`. For graph-shape
 * rules the node behaves like an agent node mid-graph (chain/router
 * outgoing, join feeding) but may not be the entry, may not be a fan-out
 * branch target, and may not run in parallel with another gate.
 */
export const ApprovalGraphNodeSchema = z.strictObject({
  id: idSchema,
  type: z.literal("approval"),
  name: z.string().min(1, "node name must be a non-empty string"),
  position: GraphNodePositionSchema,
  config: z.strictObject({
    /** Question shown to the approver in the banner/feed. */
    prompt: z.string().min(1, "prompt must be a non-empty string"),
    /** Auto-reject after this many minutes; absent = wait indefinitely. */
    timeoutMinutes: approvalTimeoutMinutesSchema.optional(),
  }),
});

export type ApprovalGraphNode = z.infer<typeof ApprovalGraphNodeSchema>;

export const GraphNodeSchema = z.discriminatedUnion("type", [
  AgentGraphNodeSchema,
  ExitGraphNodeSchema,
  JoinGraphNodeSchema,
  SubworkflowGraphNodeSchema,
  ApprovalGraphNodeSchema,
]);

export type GraphNode = z.infer<typeof GraphNodeSchema>;

/**
 * Node kinds that execute work (#117): agent invocations and sub-workflow
 * spawns (which execute a child run). Entry nodes, fan-out branch targets
 * and other "executable" graph positions accept either kind.
 */
export function isExecutableGraphNode(
  node: GraphNode,
): node is AgentGraphNode | SubworkflowGraphNode {
  return node.type === "agent" || node.type === "subworkflow";
}

/**
 * A directed edge. `condition` decides (evaluated against the source node's
 * final output) whether the edge may be taken; `always` edges are the
 * unconditional chain/fallback.
 *
 * A node's outgoing edges form one of three shapes (#115):
 *
 * - **chain/router** — a conditional set (evaluated in `order`, first match
 *   wins, enforced by #45) plus AT MOST ONE `always` fallback edge; with no
 *   match and no fallback the run ends. Mixing is rejected: a node with
 *   conditionals may not carry more than one `always` edge.
 * - **fan-out** — ALL outgoing edges unconditional: every one of them starts
 *   a parallel branch (children run concurrently up to the run's inner
 *   concurrency cap; the branches converge at `join` nodes). Fan-out edges
 *   must target distinct AGENT nodes (a branch is agent work).
 * - **terminal** — no outgoing edges (run ends `success`).
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
  /**
   * Workflow-level artifact patterns (#122): safe globs (`dist/**`) whose
   * worktree matches are copied into `data/artifacts/<runId>/` when a run
   * of this graph turns terminal. Absent on pre-#122 revisions = no capture
   * (byte-identical behavior). Because revisions are immutable, runs pinned
   * to older revisions simply keep their era's patterns.
   */
  artifacts: WorkflowArtifactsSchema.optional(),
});

/** Structural graph shape before cross-field validation/normalization. */
export type WorkflowGraphShape = {
  entryNodeId: string;
  nodes: GraphNode[];
  edges: Array<GraphEdgeInput & { id: string; source: string; target: string }>;
  /** Workflow-level artifact patterns (#122); absent on pre-#122 graphs. */
  artifacts?: string[];
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
  nodes: Map<string, GraphNode>;
  /** node id → outgoing edges (with their index in the edges array). */
  outgoing: Map<
    string,
    Array<{ edge: GraphEdgeInput & { id: string; source: string; target: string }; index: number }>
  >;
  /** node id → incoming edges (with their index in the edges array). */
  incoming: Map<
    string,
    Array<{ edge: GraphEdgeInput & { id: string; source: string; target: string }; index: number }>
  >;
  /** node id → nodes reachable from it via ≥ 1 edge (unknown endpoints skipped). */
  reach: Map<string, Set<string>>;
}

/** Builds adjacency + transitive reachability over the valid edges. */
function indexGraph(graph: WorkflowGraphShape): GraphIndex {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<
    string,
    Array<{ edge: GraphEdgeInput & { id: string; source: string; target: string }; index: number }>
  >();
  const incoming = new Map<
    string,
    Array<{ edge: GraphEdgeInput & { id: string; source: string; target: string }; index: number }>
  >();
  for (const [index, edge] of graph.edges.entries()) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const out = outgoing.get(edge.source);
    if (out === undefined) outgoing.set(edge.source, [{ edge, index }]);
    else out.push({ edge, index });
    const inc = incoming.get(edge.target);
    if (inc === undefined) incoming.set(edge.target, [{ edge, index }]);
    else inc.push({ edge, index });
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
  return { nodeIds, nodes, outgoing, incoming, reach };
}

/**
 * Cross-field validation for a workflow graph:
 *
 * - unique node/edge ids; edges reference existing nodes
 * - `entryNodeId` references an existing executable node (agent or
 *   sub-workflow, #117) — exactly one entry
 * - every node is reachable from the entry (BFS over edges)
 * - unconditional cycles rejected: the `always` (non-inverted) subgraph must
 *   be acyclic — every cycle (fan-out/join cycles included) has to include
 *   at least one conditional edge
 * - outgoing shapes (#115): a node's edges are EITHER all `always`
 *   (fan-out; the edges must target distinct agent nodes) OR a conditional
 *   set with at most one `always` fallback (router). Mixing — multiple
 *   `always` edges next to conditionals — is rejected.
 * - `join` nodes merge branches: at least two incoming edges (any condition
 *   type), at most one outgoing edge and it must be unconditional (a join
 *   is a synchronizer, not a router)
 * - `agent` nodes never receive unconditional edges from PARALLEL branches
 *   (sources sharing a fan-out ancestor) — fan-in is a join's job; serial
 *   loop shapes (`always` back-edges into a router node) stay valid
 * - approval gates never sit in PARALLEL branches (#118): a run exposes one
 *   open gate (`awaitingNodeId`), so distinct fan-out branch subtrees may not
 *   each contain an approval node; merge the branches before the next gate
 * - exit nodes are terminals (no outgoing edges)
 * - router `order` unique among a node's conditional outgoing edges
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

  // Exactly one entry: entryNodeId exists (and is an executable node — an
  // agent or a sub-workflow spawn, #117).
  const entry = graph.nodes.find((node) => node.id === graph.entryNodeId);
  if (entry === undefined) {
    push(["entryNodeId"], `entryNodeId "${graph.entryNodeId}" does not reference any node`);
  } else if (!isExecutableGraphNode(entry)) {
    push(
      ["entryNodeId"],
      `entryNodeId "${graph.entryNodeId}" must reference an agent or subworkflow node, not an ${entry.type} node`,
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
  // The rule covers fan-out/join cycles too: a parallel loop needs at least
  // one conditional edge somewhere on the cycle (its maxIterations guard).
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

  /** Direct branch targets of every fan-out (≥ 2 unconditional out-edges). */
  const fanOuts = [...index.outgoing.values()]
    .map((edges) =>
      edges.filter((item) => isUnconditional(item.edge)).map((item) => item.edge.target),
    )
    .filter((targets) => targets.length >= 2);
  const reaches = (from: string, nodeId: string): boolean =>
    from === nodeId || (index.reach.get(from) ?? new Set<string>()).has(nodeId);
  /** Whether two nodes live in EXCLUSIVE subtrees of one fan-out. */
  const inParallelBranches = (a: string, b: string): boolean =>
    fanOuts.some((targets) =>
      targets.some((t1) =>
        targets.some(
          (t2) =>
            t1 !== t2 && reaches(t1, a) && !reaches(t2, a) && reaches(t2, b) && !reaches(t1, b),
        ),
      ),
    );

  for (const [nodeIndex, node] of graph.nodes.entries()) {
    const siblings = index.outgoing.get(node.id) ?? [];
    const unconditional = siblings.filter((item) => isUnconditional(item.edge));
    const conditional = siblings.filter((item) => !isUnconditional(item.edge));

    // Exit nodes are terminals.
    if (node.type === "exit" && siblings.length > 0) {
      push(["nodes", nodeIndex, "type"], `exit node "${node.id}" must not have outgoing edges`);
    }

    if (node.type === "join") {
      const incoming = index.incoming.get(node.id) ?? [];
      if (incoming.length < 2) {
        push(
          ["nodes", nodeIndex, "type"],
          `join node "${node.id}" has ${incoming.length} incoming edge(s); a join merges at least two branches`,
        );
      }
      if (siblings.length > 1) {
        push(
          ["nodes", nodeIndex, "type"],
          `join node "${node.id}" has ${siblings.length} outgoing edges; at most one is allowed (a join synchronizes branches, it does not route)`,
        );
      }
      const conditionalOut = siblings.filter((item) => !isUnconditional(item.edge));
      if (conditionalOut.length > 0) {
        push(
          ["nodes", nodeIndex, "type"],
          `join node "${node.id}" must not have conditional outgoing edges (a join synchronizes branches, it does not route)`,
        );
      }
    } else if (node.type === "agent" || node.type === "subworkflow" || node.type === "approval") {
      // Parallel fan-in is a join's job: an executable node (agent,
      // sub-workflow, #117 — or an approval gate, #118) may not receive
      // unconditional edges from two sources that can run CONCURRENTLY —
      // i.e. sources sharing a fan-out ancestor. Serial shapes stay valid:
      // legacy loops and template loops re-enter a router node through an
      // `always` back-edge (one delivery at a time), and conditional
      // incoming edges are unrestricted (one delivery per source routing).
      const incoming = index.incoming.get(node.id) ?? [];
      const incomingAlways = incoming.filter((item) => isUnconditional(item.edge));
      if (incomingAlways.length > 1) {
        const fanOutSources = new Set(
          [...index.outgoing.entries()]
            .filter(([, edges]) => edges.filter((item) => isUnconditional(item.edge)).length >= 2)
            .map(([id]) => id),
        );
        const sources = [...new Set(incomingAlways.map((item) => item.edge.source))];
        const descendsFrom = (fanOut: string, source: string): boolean =>
          fanOut === source || (index.reach.get(fanOut) ?? new Set<string>()).has(source);
        const parallelConvergence = sources.some((s1) =>
          sources.some(
            (s2) =>
              s1 !== s2 &&
              [...fanOutSources].some(
                (fanOut) => descendsFrom(fanOut, s1) && descendsFrom(fanOut, s2),
              ),
          ),
        );
        if (parallelConvergence) {
          push(
            ["nodes", nodeIndex, "type"],
            `node "${node.id}" receives unconditional (always) edges from parallel branches; merge them at a join node instead`,
          );
        }
      }

      if (node.type === "approval") {
        // ANY two deliveries into one gate can overlap while it waits —
        // including a conditional edge from a sibling branch (#118) — so
        // parallel incoming sources are rejected regardless of edge kind.
        const sources = [
          ...new Set((index.incoming.get(node.id) ?? []).map((item) => item.edge.source)),
        ];
        const parallelSources = sources.some((source) =>
          sources.some((other) => other !== source && inParallelBranches(source, other)),
        );
        if (parallelSources) {
          push(
            ["nodes", nodeIndex, "type"],
            `approval node "${node.id}" receives edges from parallel branches; merge them at a join node instead (one delivery may wait at a time)`,
          );
        }
      }

      // Outgoing shape: EITHER all-always (fan-out) OR conditionals + at
      // most one always fallback (router). Mixing is ambiguous and rejected.
      if (unconditional.length > 1 && conditional.length > 0) {
        push(
          ["edges", unconditional[1]?.index ?? 0],
          `node "${node.id}" mixes ${unconditional.length} unconditional (always) outgoing edges with conditional edges; outgoing edges must be either all-always (fan-out) or conditionals with at most one always fallback (router)`,
        );
      }

      // Fan-out: every always edge starts a parallel branch, so the targets
      // must be distinct EXECUTABLE nodes (agents or sub-workflows, #117 —
      // joins synchronize, exits terminate — neither is branch work).
      if (unconditional.length > 1) {
        const seenTargets = new Map<string, { edgeId: string; index: number }>();
        for (const item of unconditional) {
          const target = index.nodes.get(item.edge.target);
          if (target !== undefined && !isExecutableGraphNode(target)) {
            push(
              ["edges", item.index],
              `fan-out edge "${item.edge.id}" targets ${target.type} node "${target.id}"; parallel branches must start at agent or subworkflow nodes`,
            );
          }
          const clash = seenTargets.get(item.edge.target);
          if (clash !== undefined) {
            push(
              ["edges", item.index],
              `fan-out edges "${clash.edgeId}" and "${item.edge.id}" of node "${node.id}" both target "${item.edge.target}"; parallel branches must be distinct nodes`,
            );
          } else {
            seenTargets.set(item.edge.target, { edgeId: item.edge.id, index: item.index });
          }
        }
      }
    }

    // Router order: unique effective order (explicit, else edges-array index)
    // among the node's conditional outgoing edges.
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

  // Approval gates in parallel branches (#118): a run carries ONE open gate
  // (`awaitingNodeId`), so two approval nodes may not live in distinct branch
  // subtrees of the same fan-out. Reachability through a common join makes a
  // later gate serial (each branch's fan-out target reaches it), so only
  // branch-EXCLUSIVE gates are rejected.
  const approvals = graph.nodes
    .map((node, nodeIndex) => ({ node, nodeIndex }))
    .filter((item) => item.node.type === "approval");
  for (const [i, first] of approvals.entries()) {
    for (const second of approvals.slice(i + 1)) {
      if (inParallelBranches(first.node.id, second.node.id)) {
        push(
          ["nodes", second.nodeIndex, "type"],
          `approval nodes "${first.node.id}" and "${second.node.id}" would run in parallel branches; a run supports one open approval gate — merge the branches first`,
        );
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
  return {
    entryNodeId: graph.entryNodeId,
    nodes: graph.nodes,
    edges,
    ...(graph.artifacts === undefined ? {} : { artifacts: graph.artifacts }),
  };
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
  /** Workflow-level artifact patterns (#122); absent on pre-#122 graphs. */
  artifacts?: string[];
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
 * `hasRouter` = some node routes between multiple outgoing edges via a
 * conditional (#115: a conditional set + optional always fallback);
 * `hasFanOut` = some node has multiple unconditional outgoing edges, i.e.
 * starts parallel branches (#115).
 */
export interface GraphSummary {
  nodeCount: number;
  edgeCount: number;
  hasLoop: boolean;
  hasRouter: boolean;
  /** Some agent node fans out: ≥ 2 unconditional outgoing edges (#115). */
  hasFanOut: boolean;
  /** Revision number the summary was computed from. */
  revision: number;
}

/** Whether an edge is unconditional (always, not inverted). */
const isUnconditionalEdge = (edge: GraphEdge): boolean =>
  edge.condition.type === "always" && edge.invert !== true;

/** Computes the {@link GraphSummary} of a validated graph snapshot. */
export function summarizeGraph(graph: WorkflowGraph, revision: number): GraphSummary {
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const bucket = outgoing.get(edge.source);
    if (bucket === undefined) outgoing.set(edge.source, [edge]);
    else bucket.push(edge);
  }
  const reachCache = new Map<string, Set<string>>();
  const reachable = (start: string): Set<string> => {
    const cached = reachCache.get(start);
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    const queue = [...(outgoing.get(start) ?? [])].map((edge) => edge.target);
    while (queue.length > 0) {
      const next = queue.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const edge of outgoing.get(next) ?? []) queue.push(edge.target);
    }
    reachCache.set(start, seen);
    return seen;
  };
  const hasLoop = graph.edges.some((edge) => reachable(edge.target).has(edge.source));
  let hasRouter = false;
  let hasFanOut = false;
  for (const edges of outgoing.values()) {
    if (edges.length < 2) continue;
    const conditional = edges.some((edge) => !isUnconditionalEdge(edge));
    const unconditional = edges.some(isUnconditionalEdge);
    if (conditional) hasRouter = true;
    if (conditional === false && unconditional) hasFanOut = true;
  }
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    hasLoop,
    hasRouter,
    hasFanOut,
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
      ...(step.retry === undefined ? {} : { retry: step.retry }),
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
        if (target.type !== "agent") {
          // Join nodes (#115) are fan-in synchronizers: no legacy shape.
          return fail(
            `chain edge "${edge.id}" targets ${target.type} node "${target.id}"; this has no legacy representation`,
          );
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
    ...(node.config.retry === undefined ? {} : { retry: node.config.retry }),
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
