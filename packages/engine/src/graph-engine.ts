import {
  DEFAULT_EDGE_MAX_ITERATIONS,
  isExecutableGraphNode,
  renderPromptTemplate,
} from "@openeuler/core";
import type {
  AgentGraphNode,
  ApprovalGraphNode,
  BreadcrumbEntry,
  GraphEdge,
  GraphNode,
  JoinGraphNode,
  NodeRetryConfig,
  Run,
  RunStatus,
  StepRun,
  SubworkflowGraphNode,
  WorkflowGraph,
} from "@openeuler/core";
import type { Db, EventInput } from "@openeuler/db";
import type { PersistedEvent } from "@openeuler/core";
import type { AgentDriver, AgentHandle, DriverRegistry } from "@openeuler/drivers";
import type {
  ApprovalGateOutcome,
  ApprovalTimerFactory,
  ApprovalTimerHandle,
  RunControl,
  RunSandboxContext,
} from "./flow-engine.js";
import type { WorktreeManager } from "./worktree.js";
import {
  compileExitCondition,
  describeCondition,
  evaluateExitCondition,
  type ExitEvaluator,
} from "./conditions.js";

/**
 * Parallel DAG graph execution engine (#45 serial semantics, #115 parallel
 * fan-out + join/merge).
 *
 * ## Execution semantics (v0.2 — PARALLEL FRONTIER)
 *
 * The run maintains a READY SET of scheduled node executions and an IN-FLIGHT
 * set of started ones (capped by the run's inner concurrency,
 * {@link DEFAULT_INNER_CONCURRENCY}). An execution becomes ready exactly one
 * way: an edge traversal delivers to it — a router/chain edge (first-match
 * conditional or the single `always` fallback), or one of a fan-out's
 * `always` edges.
 *
 * - **chain/router (serial)** — a node with conditionals + at most one
 *   `always` fallback evaluates them in `order` on completion (first match
 *   wins; `invert` negates) against the node's FINAL output; the taken edge
 *   delivers to its target (`edge.taken` event). v0.1 semantics, unchanged.
 * - **fan-out (parallel, #115)** — a node whose outgoing edges are ALL
 *   `always` starts one parallel branch per edge: every branch target is
 *   scheduled (up to the inner concurrency cap; the rest queue). Fan-out
 *   emits no `edge.taken` — the branches are reported by the targets'
 *   `node.queued` events carrying the branch `edgeId`.
 * - **join/merge (#115)** — a `join` node is the fan-in counterpart: it
 *   waits (per `config.mode`) for its incoming edges to be traversed and
 *   then "executes" instantly (no driver, no StepRun row). Its output is the
 *   JSON map `{<branchSourceNodeId>: <output>}` of the ARRIVED branches,
 *   available downstream as `{{output:<joinId>}}` (branch outputs stay
 *   addressable directly). A join has at most one outgoing edge and it is
 *   unconditional — it synchronizes, it never routes. `mode: "all"`
 *   (default) triggers when every incoming edge arrived; `mode: "any"`
 *   triggers on the first arrival and cancels the sibling branches still in
 *   flight (their results are no longer needed). A join triggers AT MOST
 *   ONCE per round (one fan-out iteration's branch executions): the
 *   delivering edge's source execution number identifies the round, and a
 *   delivery whose round already triggered is suppressed — so a cancelled
 *   loser that exited naturally anyway (or re-ran after a resume) can never
 *   re-trigger the join and double-execute the downstream subgraph.
 *
 * ## Failure policy (#115)
 *
 * A failed node execution fails the run immediately (fail-fast) UNLESS the
 * nearest join reachable from it (its failure scope) is `mode: "any"`: there
 * the failure is tolerated while another incoming branch can still arrive;
 * if the join ends up engaged but unsatisfiable (every incoming edge either
 * failed or routed away), the run fails with join attribution. Fail-fast
 * failures cancel all in-flight branches (their drivers are aborted; their
 * StepRuns settle `aborted`) before the run row turns `failed`. A `mode:
 * "any"` join triggering on one branch cancels its remaining siblings the
 * same way. Cancelled branches settle `aborted` uniformly, whether the
 * cancellation reached them mid-flight (driver aborted — or already exited
 * naturally: the superseded result is discarded, never delivered) or while
 * still queued behind the inner concurrency cap (their never-started
 * StepRun rows settle `aborted` with empty output — never swept to the
 * run-level status, which would read as false success on a winning run).
 *
 * ## Iteration semantics
 *
 * Each node EXECUTION counts: a node re-entered by a conditional back-edge
 * runs as execution 1, 2, 3, … (per node, not global — join executions
 * count the same way, one per trigger); that number is assigned at
 * scheduling time and is what the node's StepRun row, its `node.*` events
 * and the `{{iterations}}` template variable carry. `{{prevOutput}}` is the
 * output of the node that routed INTO the current execution (the fan-out
 * source for a branch start, the join's JSON map after a merge); a node's
 * own `{{output:<nodeId>}}` reference resolves to that node's MOST RECENT
 * completed output from any earlier point of the run. `continueSession`
 * nodes reuse their sessionId across re-entries (their own previous
 * execution's session, like the #16 same-step rule; the routing source
 * node's session on first entry).
 *
 * ## Cycle guards
 *
 * A conditional edge whose target can reach its source (a back-edge, self
 * loops included) is guarded by `maxIterations`: the edge may be TAKEN at
 * most `min(maxIterations, {@link MAX_EDGE_ITERATIONS})` times per run —
 * the default is {@link DEFAULT_EDGE_MAX_ITERATIONS} (stamped by schema
 * normalization), the hard cap clamps any larger configuration. When a
 * guarded edge's condition matches but the edge is already at its cap, the
 * engine emits `edge.cap-reached` and follows the source node's `always`
 * fallback edge; with no fallback the run fails with a clear reason.
 * Unconditional (`always`) edges are never guarded — fan-out branches do
 * not consume edge caps — so every cycle (parallel or serial) needs at
 * least one conditional edge somewhere on it; validation enforces exactly
 * that. When a guarded edge's condition matches but the edge is already at
 * its cap, the engine emits `edge.cap-reached` and follows the source
 * node's `always` fallback edge; with no fallback the run fails with a
 * clear reason.
 *
 * ## Scheduler interplay (#115)
 *
 * Parallel branches count against the run's INTERNAL semaphore
 * ({@link DEFAULT_INNER_CONCURRENCY} concurrent driver executions per run)
 * only — never against the daemon's `MAX_CONCURRENT_RUNS`, which caps
 * concurrent RUNS: one run with three live branches still occupies exactly
 * one global slot, so a busy fan-out run cannot starve other runs. A run
 * abort cancels every in-flight branch (drivers aborted, StepRuns settled
 * `aborted`).
 *
 * ## Events
 *
 * Graph runs emit `node.queued` / `node.started` / `node.completed` /
 * `edge.taken` / `edge.cap-reached` INSTEAD of the legacy `step.*` /
 * `loop.*` events (cleaner for the live graph view, #52), plus the usual
 * `run.status` transitions and the streamed driver events. `node.queued` is
 * emitted at SCHEDULING time (a capped-out branch shows as queued while it
 * waits for a slot); fan-out branch executions carry the branch `edgeId` on
 * their `node.*` events. Replaying `node.completed` + `edge.taken`
 * reconstructs the persisted run breadcrumb exactly.
 *
 * ## Breadcrumb
 *
 * The run row carries an ordered `breadcrumb` (JSON column): one
 * `{kind: "node", nodeId, iteration}` entry per completed node execution
 * (join triggers included) and one `{kind: "edge", edgeId, iteration}` entry
 * per taken router/chain edge (`iteration` = the source node's execution
 * number). Fan-out traversals append no edge entries (they are
 * deterministic in the source completion). It is appended synchronously as
 * execution proceeds and powers replay in #52; together with the StepRun
 * rows it also reconstructs the resume position (#19).
 */

/** Hard ceiling on how often one guarded edge may be taken, regardless of configuration. */
export const MAX_EDGE_ITERATIONS = 25;

/**
 * Default number of node executions a run may have in flight at once (#115)
 * — the run-internal parallelism cap for fan-out branches. Runs on a graph
 * without fan-out never exceed one. Configurable per engine via
 * `FlowEngineOptions.graphInnerConcurrency` (env/policy wiring is post-v0.2).
 */
export const DEFAULT_INNER_CONCURRENCY = 3;

/** Hard ceiling on the inner concurrency cap (defensive bound). */
export const MAX_INNER_CONCURRENCY = 25;

/** Defensive bound on total node executions per run (bug guard, not configurable). */
const MAX_TOTAL_NODE_EXECUTIONS = 5_000;

/**
 * Maximum sub-workflow nesting depth (#117): a top-level run executes at
 * depth 0; every sub-workflow node spawns its child run at depth + 1. A
 * spawn that would exceed the cap fails the node with a clear error, so a
 * self-referencing (or mutually referencing) workflow chain terminates
 * instead of recursing forever.
 */
export const MAX_SUBWORKFLOW_DEPTH = 3;

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Whether an edge is unconditional — an always edge that is not inverted. */
const isUnconditional = (edge: GraphEdge): boolean =>
  edge.condition.type === "always" && edge.invert !== true;

/**
 * Nodes the scheduler can run (#118 adds approval gates): agent work,
 * sub-workflow spawns, and approval waits. Deliberately distinct from
 * core's {@link isExecutableGraphNode}, which also gates ENTRY selection
 * and fan-out branch targets — an approval gate may sit mid-graph only.
 */
const isRunnableGraphNode = (
  node: GraphNode,
): node is AgentGraphNode | SubworkflowGraphNode | ApprovalGraphNode =>
  node.type === "agent" || node.type === "subworkflow" || node.type === "approval";

/**
 * Shared machinery from the flow engine (single source of truth for the
 * per-step executor behaviors: StepRun lifecycle, diff capture, event
 * persistence, run finalization).
 */
export interface GraphEngineDeps {
  db: Db;
  worktrees: WorktreeManager;
  drivers: DriverRegistry;
  log: {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  };
  /** Persists + emits a `run.status` event. */
  emitRunStatus(runId: string, status: RunStatus, error?: string): void;
  /** Terminal run transition (row update, StepRun settle, terminal event). */
  finalizeRun(runId: string, status: RunStatus, patch: { output?: string; error?: string }): void;
  /** Aborts the run (row, StepRun settle, event). */
  abortRun(runId: string): void;
  /**
   * Captures + advances the per-step diff snapshot; never fails the run.
   * `runId` tags the failure log for run-scoped redaction (#93).
   */
  captureDiff(runId: string, worktreePath: string, base: { ref: string }): Promise<string>;
  /** Creates (or re-uses a queued/interrupted) StepRun row, flipped to running. */
  beginStepRun(runId: string, step: { stepId: string }, iteration: number): StepRun;
  /**
   * Creates (or re-uses) a QUEUED StepRun row for a scheduled execution
   * (#115): parallel branches are scheduled before they start (inner
   * concurrency), so their pending state persists across a restart.
   */
  scheduleStepRun(runId: string, step: { stepId: string }, iteration: number): StepRun;
  /**
   * Persists one event with the run's secret redaction applied to the
   * payload (#93). All graph-path event writes go through here.
   */
  appendEvent(runId: string, event: EventInput): PersistedEvent;
  /** Redacts a run-scoped free-text value (output, diff, error) (#93). */
  redactText(runId: string, text: string): string;
  /** The run's secret env (merged into driver starts); undefined = none. */
  runSecretsEnv(runId: string): Record<string, string> | undefined;
  /** Per-run sandbox context (#102); undefined = local execution. */
  runSandbox(runId: string): RunSandboxContext | undefined;
  /**
   * #107: port detection over one completed node's final output (sandboxed
   * runs only; the flow engine's implementation no-ops local runs).
   */
  recordDetectedPorts(runId: string, output: string): void;
  /**
   * #117: executes one sub-workflow node's CHILD RUN inline — creates the
   * child run row (queued, `parentRunId` = the parent run, pinned to the
   * resolved revision of `workflowId`), recursively executes it within the
   * parent's execution context (own worktree/branch, own event log, own
   * StepRuns) and resolves once the child is terminal. NEVER touches the
   * scheduler: the child counts as part of its parent's global slot, so a
   * `MAX_CONCURRENT_RUNS=1` daemon cannot deadlock against its own child.
   * `control` is the CHILD's abort chain (parent abort propagates through
   * it). Resolves `{ ok: false, error }` for unresolvable references
   * (deleted workflow, missing revision) — the caller fails the node.
   */
  executeChildRun(params: {
    parentRunId: string;
    workflowId: string;
    revision: "latest" | number;
    /** The child's nesting depth (already validated ≤ the cap by the caller). */
    depth: number;
    /** The child's task (the parent run's task, verbatim). */
    task: string;
    /** Abort chain: parent abort / branch cancel must abort the child. */
    control: RunControl;
  }): Promise<
    | { ok: true; runId: string; status: RunStatus; output: string; error: string | undefined }
    | { ok: false; error: string }
  >;
  /**
   * #118: opens one approval gate for this node execution and resolves
   * when it settles (decision / timeout / abort — branch cancellation
   * arrives through the caller's gate-scoped `control`). Owns the awaiting
   * persistence (`node.awaiting` event, run-row `awaitingNodeId`). The
   * caller owns the StepRun lifecycle around it.
   */
  awaitApproval(params: {
    runId: string;
    node: ApprovalGraphNode;
    iteration: number;
    control: RunControl;
    /** True when re-entering a persisted wait after a restart (#118). */
    resumed: boolean;
  }): Promise<ApprovalGateOutcome>;
}

/** Options for {@link executeGraphRun} (#115). */
export interface GraphRunOptions {
  /** Run-internal concurrency cap; defaults to {@link DEFAULT_INNER_CONCURRENCY}. */
  innerConcurrency?: number;
  /**
   * Sub-workflow nesting depth of THIS run (#117): 0 for top-level runs,
   * `parentDepth + 1` for a child run. Drives the
   * {@link MAX_SUBWORKFLOW_DEPTH} check on sub-workflow nodes.
   */
  depth?: number;
  /**
   * Retry seams (#119): backoff timer factory + jitter source, injected by
   * the flow engine (fake-clock testable). Defaults to an unref'd
   * `setTimeout` and uniform jitter in `[0, backoffMs)`.
   */
  retrySeams?: NodeRetrySeams;
}

/**
 * Injectable seams for node retry backoff (#119): the cancellable wait
 * (default an unref'd `setTimeout`) and the jitter added to each attempt's
 * exponential base delay (default uniform in `[0, backoffMs)`). The flow
 * engine owns the defaults so tests drive deterministic timings.
 */
export interface NodeRetrySeams {
  timer: ApprovalTimerFactory;
  jitter: (backoffMs: number) => number;
}

/**
 * Backoff delay before attempt `attempt + 1` (#119): exponential base 2
 * (`backoffMs * 2^(attempt-1)`) plus jitter. Pure given the jitter source,
 * so tests pin jitter to 0 and assert exact timings.
 */
export function retryBackoffMs(
  config: NodeRetryConfig,
  attempt: number,
  jitter: (backoffMs: number) => number,
): number {
  const base = config.backoffMs * 2 ** (attempt - 1);
  return base + Math.max(0, Math.floor(jitter(config.backoffMs)));
}

/** Default retry seams when none are injected (unref'd timer, random jitter). */
export const DEFAULT_RETRY_SEAMS: NodeRetrySeams = {
  timer: (delayMs, fire) => {
    const timer = setTimeout(fire, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
  jitter: (backoffMs) => Math.floor(Math.random() * backoffMs),
};

/** Terminal outcome of one node execution. */
interface NodeOutcome {
  status: RunStatus;
  output: string;
  error: string | undefined;
  /** Session this execution ran in (announced, restarted or inherited). */
  sessionId: string | undefined;
  /**
   * #118: set when an approval gate resolved REJECTED (decision or
   * timeout). The node still completes `success` with output
   * `rejected: <note>` — the scheduler turns this into a run failure
   * unless the node's conditional outgoing edges route on it.
   */
  approvalRejected?: { note: string };
  /**
   * Routing text that overrides `output` for edge-condition evaluation
   * (#118): approval routing branches on the sentinel (`"approved"` /
   * `"rejected"`), never on free-form approver note text embedded in the
   * output. Undefined = route on `output` verbatim.
   */
  routingOutput?: string;
}

/**
 * One scheduled node execution (the unit of the ready queue). Delivering to
 * a node is always via exactly one edge traversal; `viaEdgeId` records the
 * fan-out branch edge when that is how it was readied.
 */
interface ScheduledExec {
  nodeId: string;
  /** This execution's 1-based number (per-node). */
  iteration: number;
  /** Output of the node that routed into this execution ("" at the entry). */
  prevOutput: string;
  /** Session of the routing source node, for `continueSession` chaining. */
  prevSessionId: string | undefined;
  /** SessionId recorded on an interrupted StepRun to restart into. */
  restartSessionId: string | undefined;
  /** The fan-out branch edge this execution runs on (#115), when known. */
  viaEdgeId: string | undefined;
  /**
   * Fan-out LINEAGE (#115): the stack of `<sourceNodeId>#<sourceExecNumber>`
   * tokens for every fan-out spawn this execution descends from (["root"]
   * before any fan-out). Fan-out spawn PUSHES a token; routing/loops/joins
   * inherit unchanged — so per-node execution numbers (which diverge inside
   * looping branches) never feed the join single-trigger guard. A join
   * compares the lineage element of ITS OWN feeding fan-out (see
   * `joinRoundKey`), which nested fan-outs and inner loops leave stable.
   */
  rounds: string[];
}

/** Verdict of one completed in-flight execution, acted on by the scheduler. */
type TaskVerdict =
  | { kind: "continue" }
  | { kind: "branch-done" }
  /**
   * A stale-round delivery (#115/#117): the execution finished naturally,
   * but its join already triggered on this fan-out round — its result is
   * discarded entirely (never delivered, never the run's final output).
   */
  | { kind: "suppressed" }
  | { kind: "fail-run"; error: string; output?: string }
  | { kind: "abort" }
  /** Graceful shutdown while an approval gate holds the run (#118). */
  | { kind: "interrupt" };

/** Live per-execution context: driver handle + branch-cancellation flag. */
interface ExecContext {
  exec: ScheduledExec;
  node: AgentGraphNode | SubworkflowGraphNode | ApprovalGraphNode;
  handle: AgentHandle | undefined;
  /** Set when a fail-fast / any-trigger cancels this branch (#115). */
  cancelRequested: boolean;
  /**
   * Wakes this execution's handle-less wait (approval gate or retry backoff)
   * when branch cancellation lands (#118/#119): cancelExecutions fires the
   * listener so the node settles `aborted` instead of sleeping out its wait.
   */
  cancelWait: (() => void) | undefined;
  /**
   * The execution's full task promise (driver run + completion processing),
   * never rejecting. Resolves to the verdict the scheduler acts on.
   */
  done: Promise<TaskVerdict>;
}

/**
 * Resolution of one incoming edge of a pending join since its last trigger
 * (fresh round = all `waiting`). `arrived` edges delivered their output;
 * `failed`/`missed` edges never will (source failed / routed elsewhere).
 * `arrivals` records each delivery's fan-out ROUND token — the identity
 * behind the single-trigger-per-round guard (#115).
 */
type JoinEdgeState = "waiting" | "arrived" | "failed" | "missed";

interface JoinPending {
  states: Map<string, JoinEdgeState>;
  /** edge id → delivering execution's fan-out round token (round identity). */
  arrivals: Map<string, string>;
}

/** A fresh pending round: every incoming edge waiting, no arrivals. */
function freshJoinPending(topology: GraphTopology, joinId: string): JoinPending {
  const states = new Map<string, JoinEdgeState>();
  for (const edge of topology.incoming.get(joinId) ?? []) states.set(edge.id, "waiting");
  return { states, arrivals: new Map() };
}

/** Mutable per-run graph execution state. */
interface GraphRunState {
  /** Node id → its most recent completed output (`{{output:<id>}}` source). */
  outputs: Map<string, string>;
  /** Node id → its most recent effective session (routing-source chaining). */
  sessions: Map<string, string | undefined>;
  /** Node id → highest scheduled execution number (1-based, per-node). */
  execCount: Map<string, number>;
  /** Guarded edge id → times taken so far. */
  takenCounts: Map<string, number>;
  /** Join id → per-incoming-edge satisfaction since its last trigger (#115). */
  joinPending: Map<string, JoinPending>;
  /**
   * Join id → fan-out round tokens that already triggered (#115): a join
   * triggers at most once per round, so a stale delivery (a cancelled loser
   * that exited naturally, or re-ran after a resume) is suppressed instead
   * of re-triggering the downstream subgraph. Rounds are stable across
   * inner loops (they change only at fan-out spawn / join inheritance) and
   * are reconstructable from `node.queued/started` event payloads.
   */
  joinTriggeredRounds: Map<string, Set<string>>;
  /** Ordered breadcrumb, mirrored onto the run row on every append. */
  breadcrumb: BreadcrumbEntry[];
  /** `nodeId#iteration` → the lineage stack that execution ran under (#115). */
  execRounds: Map<string, string[]>;
  /** Output of the last successfully completed agent node (final run output). */
  runOutput: string;
  /** Total node executions started (defensive termination bound). */
  totalExecutions: number;
  /** The run's task description (`{{task}}`). */
  task: string;
}

/** Outgoing-edge lookup + guard classification + join topology, per run. */
interface GraphTopology {
  nodesById: Map<string, GraphNode>;
  /** edge id → edge. */
  edgesById: Map<string, GraphEdge>;
  /** node id → outgoing edges, in edges-array order. */
  outgoing: Map<string, GraphEdge[]>;
  /** node id → incoming edges, in edges-array order (#115). */
  incoming: Map<string, GraphEdge[]>;
  /** node id → nodes reachable from it via ≥ 1 edge (any condition). */
  reach: Map<string, Set<string>>;
  /** join node id → node. */
  joins: Map<string, JoinGraphNode>;
  /** edge id → effective router order among its node's conditional siblings. */
  order: Map<string, number>;
  /** Conditional back-edges (target reaches source) that carry a cycle guard. */
  guarded: Set<string>;
  /**
   * node id → the nearest join reachable from it (#115 failure scope): the
   * join whose mode decides whether the node's failure fails the run
   * (`all`/no join) or is tolerated (`any`) while a sibling can still
   * arrive. Innermost join wins (min hop count). `tolerant` is true only
   * when the node sits on a PARALLEL branch of that join — a fan-out
   * ancestor reaches the join through a path AVOIDING this node, so another
   * sibling can still arrive. Serial prefixes that merely precede the join
   * are not tolerant (their failure starves the join of every branch).
   */
  failureScope: Map<string, { joinId: string; mode: "all" | "any"; tolerant: boolean }>;
  /**
   * join id → its direct branch siblings (#115): agent nodes spawned by a
   * fan-out whose branches feed the join without crossing another join,
   * and whose own join-free path leads into this join. For these nodes the
   * per-node execution number identifies a round of the join, which is
   * what the single-trigger-per-round guard and the resume-time loser
   * settlement key on.
   */
  joinSiblings: Map<string, Set<string>>;
}

function buildTopology(graph: WorkflowGraph): GraphTopology {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const joins = new Map<string, JoinGraphNode>();
  for (const node of graph.nodes) {
    if (node.type === "join") joins.set(node.id, node);
  }
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const out = outgoing.get(edge.source);
    if (out === undefined) outgoing.set(edge.source, [edge]);
    else out.push(edge);
    const inc = incoming.get(edge.target);
    if (inc === undefined) incoming.set(edge.target, [edge]);
    else inc.push(edge);
  }
  // Transitive reachability (≥ 1 edge), node set is small.
  const reach = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    const seen = new Set<string>();
    const queue = (outgoing.get(node.id) ?? []).map((edge) => edge.target);
    while (queue.length > 0) {
      const next = queue.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const edge of outgoing.get(next) ?? []) queue.push(edge.target);
    }
    reach.set(node.id, seen);
  }
  const guarded = new Set<string>();
  for (const edge of graph.edges) {
    if (isUnconditional(edge)) continue;
    if ((reach.get(edge.target) ?? new Set<string>()).has(edge.source)) guarded.add(edge.id);
  }
  // Effective router order per node: explicit `order`, else edges-array index
  // (mirrors validateWorkflowGraph's tie-break).
  const order = new Map<string, number>();
  for (const edges of outgoing.values()) {
    for (const [index, edge] of edges.entries()) order.set(edge.id, edge.order ?? index);
  }
  // Failure scopes (#115): BFS from every node over the outgoing subgraph,
  // nearest join (min hops) wins. Join nodes themselves scope to the NEXT
  // join downstream (an outer one), which is correct layering. `tolerant`
  // requires a fan-out ancestor with an ALTERNATE path to the join that
  // avoids this node (a sibling branch can still arrive).
  const fanOutNodes = new Set(
    [...outgoing.entries()]
      .filter(([, edges]) => edges.filter((edge) => isUnconditional(edge)).length >= 2)
      .map(([id]) => id),
  );
  const reaches = (from: string, to: string, avoid?: string): boolean => {
    if (from === avoid) return false;
    const seen = new Set<string>();
    const queue = (outgoing.get(from) ?? []).map((edge) => edge.target);
    while (queue.length > 0) {
      const next = queue.pop() as string;
      if (next === avoid || seen.has(next)) continue;
      if (next === to) return true;
      seen.add(next);
      for (const edge of outgoing.get(next) ?? []) queue.push(edge.target);
    }
    return false;
  };
  const failureScope = new Map<
    string,
    { joinId: string; mode: "all" | "any"; tolerant: boolean }
  >();
  for (const node of graph.nodes) {
    const dist = new Map<string, number>();
    const queue: string[] = [];
    for (const edge of outgoing.get(node.id) ?? []) {
      if (joins.has(edge.target) && !dist.has(edge.target)) {
        dist.set(edge.target, 1);
        queue.push(edge.target);
      }
    }
    let found: string | undefined;
    while (queue.length > 0 && found === undefined) {
      const current = queue.shift() as string;
      if (joins.has(current)) {
        found = current;
        break;
      }
      for (const edge of outgoing.get(current) ?? []) {
        if (!dist.has(edge.target)) {
          dist.set(edge.target, (dist.get(current) ?? 0) + 1);
          queue.push(edge.target);
        }
      }
    }
    if (found !== undefined) {
      const join = joins.get(found) as JoinGraphNode;
      // Parallel-branch membership: some fan-out ancestor of this node
      // (not the node itself) reaches the join while avoiding this node.
      const fanOutAncestors = [...fanOutNodes].filter(
        (id) => id !== node.id && reaches(id, node.id),
      );
      const tolerant = fanOutAncestors.some((id) => reaches(id, found as string, node.id));
      failureScope.set(node.id, { joinId: found, mode: join.config.mode, tolerant });
    }
  }
  // Direct branch siblings per join (#115): nodes a fan-out spawned on a
  // branch that feeds the join without crossing another join (nested-join
  // regions conservatively excluded — their execution numbers do not
  // identify this join's rounds), and whose own join-free path delivers
  // into this join.
  const reachesAvoidingJoins = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const queue: string[] = (outgoing.get(from) ?? []).map((edge) => edge.target);
    while (queue.length > 0) {
      const next = queue.pop() as string;
      if (next === to) return true;
      if (seen.has(next) || joins.has(next)) continue;
      seen.add(next);
      for (const edge of outgoing.get(next) ?? []) queue.push(edge.target);
    }
    return false;
  };
  const joinSiblings = new Map<string, Set<string>>();
  for (const joinId of joins.keys()) {
    const siblings = new Set<string>();
    for (const fanOut of fanOutNodes) {
      if (!reachesAvoidingJoins(fanOut, joinId)) continue;
      for (const node of graph.nodes) {
        if (node.id === fanOut || node.id === joinId || joins.has(node.id)) continue;
        if (reachesAvoidingJoins(fanOut, node.id) && reachesAvoidingJoins(node.id, joinId)) {
          siblings.add(node.id);
        }
      }
    }
    joinSiblings.set(joinId, siblings);
  }
  return {
    nodesById,
    edgesById,
    outgoing,
    incoming,
    reach,
    joins,
    order,
    guarded,
    failureScope,
    joinSiblings,
  };
}

/** Renders an edge's condition for the `matchedCondition` event field. */
function describeEdgeCondition(edge: GraphEdge): string {
  const base = describeCondition(edge.condition);
  return edge.invert === true ? `${base} (inverted)` : base;
}

/** Effective cap of a guarded edge: configured/default, clamped by the hard cap. */
function effectiveMaxIterations(edge: GraphEdge): { max: number; clampedFrom: number | undefined } {
  const configured = edge.maxIterations ?? DEFAULT_EDGE_MAX_ITERATIONS;
  const max = Math.min(configured, MAX_EDGE_ITERATIONS);
  return { max, clampedFrom: configured > max ? configured : undefined };
}

/** The join's merged output: JSON map of the arrived branch sources' outputs. */
function renderJoinOutput(
  topology: GraphTopology,
  state: GraphRunState,
  joinId: string,
  arrived: ReadonlySet<string>,
): string {
  const entries = (topology.incoming.get(joinId) ?? [])
    .filter((edge) => arrived.has(edge.id))
    .map((edge) => [edge.source, state.outputs.get(edge.source) ?? ""] as const);
  return JSON.stringify(Object.fromEntries(entries));
}

/** Describes one pending (engaged but unsatisfied) join for an error message. */
function describeUnsatisfiedJoin(
  topology: GraphTopology,
  join: JoinGraphNode,
  pending: JoinPending,
): string {
  const parts = (topology.incoming.get(join.id) ?? []).map((edge) => {
    const state = pending.states.get(edge.id) ?? "waiting";
    const detail =
      state === "arrived"
        ? "arrived"
        : state === "failed"
          ? "source failed"
          : state === "missed"
            ? "source completed but routed elsewhere"
            : "never reached";
    return `edge "${edge.id}" from node "${edge.source}": ${detail}`;
  });
  return `join node "${join.id}" (mode ${join.config.mode}) never triggered: ${parts.join("; ")}`;
}

/**
 * The comparison key for one join (#115): the lineage element of the join's
 * FEEDING fan-out (the shared unconditional parent of the join's direct
 * incoming sources). Nested fan-outs and inner loops deeper in the lineage
 * never change it; a new outer iteration does. Joins fed serially (no
 * fan-out ancestor) get a per-delivery key — always fresh, matching the
 * pre-#115 behavior for serial shapes.
 */
function joinRoundKey(topology: GraphTopology, joinId: string, rounds: readonly string[]): string {
  const feeding = feedingFanOutOf(topology, joinId);
  if (feeding === undefined) return `serial:${rounds[rounds.length - 1] ?? "root"}`;
  const prefix = `${feeding}#`;
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const token = rounds[i];
    if (token !== undefined && token.startsWith(prefix)) return token;
  }
  return `serial:${rounds[rounds.length - 1] ?? "root"}`;
}

/**
 * The join's feeding fan-out: the fan-out node whose spawned branches are
 * the join's incoming sources — i.e. the DEEPEST fan-out ancestor from
 * which every direct incoming source of the join is reachable (through any
 * edges: the sources may sit several hops downstream of the spawn, e.g.
 * behind a nested fan-out + join + inner loop). The lineage token of THAT
 * fan-out identifies the delivery's round; `undefined` when the join is
 * fed serially (no common fan-out ancestor) — per-delivery keys then.
 */
function feedingFanOutOf(topology: GraphTopology, joinId: string): string | undefined {
  const sources = new Set((topology.incoming.get(joinId) ?? []).map((edge) => edge.source));
  let best: { id: string; distance: number } | undefined;
  for (const [candidate, edges] of topology.outgoing) {
    const unconditional = edges.filter((edge) => isUnconditional(edge));
    if (unconditional.length < 2) continue;
    const reachable = topology.reach.get(candidate) ?? new Set<string>();
    let covers = true;
    for (const source of sources) {
      if (!reachable.has(source)) {
        covers = false;
        break;
      }
    }
    if (!covers) continue;
    // Deeper (closer to the join) wins: the innermost fan-out's token
    // distinguishes nested rounds; an outer ancestor's token would lump
    // them together and suppress legitimate re-triggers.
    const distance = hopDistance(topology, candidate, joinId);
    if (distance === undefined) continue;
    if (best === undefined || distance < best.distance) best = { id: candidate, distance };
  }
  return best?.id;
}

/** BFS hop distance from `from` to `to` over outgoing edges (undefined = unreachable). */
function hopDistance(topology: GraphTopology, from: string, to: string): number | undefined {
  if (from === to) return 0;
  const seen = new Set<string>([from]);
  const queue: Array<{ node: string; hops: number }> = [
    ...(topology.outgoing.get(from) ?? []).map((edge) => ({ node: edge.target, hops: 1 })),
  ];
  while (queue.length > 0) {
    const next = queue.shift() as { node: string; hops: number };
    if (next.node === to) return next.hops;
    if (seen.has(next.node)) continue;
    seen.add(next.node);
    for (const edge of topology.outgoing.get(next.node) ?? []) {
      queue.push({ node: edge.target, hops: next.hops + 1 });
    }
  }
  return undefined;
}

interface ResumeOutcome {
  state: GraphRunState;
  initial: ScheduledExec[];
  /** Advance to re-run for a completed node whose routing never persisted. */
  redrive: { nodeId: string; output: string; iteration: number; rounds: string[] } | undefined;
  /** A join trigger whose execution never persisted. */
  pendingJoinTrigger: string | undefined;
  /** Round key of the un-persisted trigger (follow execs inherit its lineage). */
  pendingTriggerRounds: string[] | undefined;
}

function reconstructGraphResume(
  deps: GraphEngineDeps,
  run: Run,
  topology: GraphTopology,
): ResumeOutcome | undefined {
  const rows = deps.db.stepRuns.listByRun(run.id);
  if (rows.length === 0) return undefined;

  let entries = [...(run.breadcrumb ?? [])];
  if (entries.length === 0) {
    // Shim-era fallback: renumber rows iteration-major into per-node entries.
    const perNode = new Map<string, number>();
    entries = [...rows]
      .sort((a, b) =>
        a.iteration === b.iteration ? a.id.localeCompare(b.id) : a.iteration - b.iteration,
      )
      .filter((row) => row.status === "success")
      .map((row) => {
        const iteration = (perNode.get(row.stepId) ?? 0) + 1;
        perNode.set(row.stepId, iteration);
        return { kind: "node" as const, nodeId: row.stepId, iteration };
      });
  }

  const state: GraphRunState = {
    outputs: new Map(),
    sessions: new Map(),
    execCount: new Map(),
    takenCounts: new Map(),
    joinPending: new Map(),
    joinTriggeredRounds: new Map(),
    breadcrumb: entries,
    execRounds: new Map(),
    runOutput: "",
    totalExecutions: 0,
    task: run.task ?? "",
  };
  // Scheduled-but-unfinished executions carry their iteration on the row.
  for (const row of rows) {
    state.execCount.set(row.stepId, Math.max(state.execCount.get(row.stepId) ?? 0, row.iteration));
  }
  const rowsByKey = new Map(rows.map((row) => [`${row.stepId}#${row.iteration}`, row]));

  // Replay the breadcrumb. Join satisfaction mirrors the runtime: an edge
  // entry into a join satisfies that edge; hitting the mode's threshold
  // means the join triggered (its node entry follows, resetting the round).
  let pendingJoinTrigger: string | undefined;
  /**
   * Arrived-edge snapshot of the trigger detected on the last edge entry
   * but whose join node entry has not been replayed yet — the source the
   * join's output renders from (the round itself stays pending until the
   * join's node entry — or the live re-fired trigger — consumes it).
   */
  let pendingTriggerArrived: Set<string> | undefined;
  /** Lineage of the un-persisted trigger (follow execs inherit it). */
  let pendingTriggerRounds: string[] | undefined;
  /**
   * `nodeId#iteration` → lineage stack, from the persisted `node.queued/
   * started` events (#115). Legacy events without lineage fall back to a
   * single per-exec token (`<nodeId>#<iteration>`) — degenerating to the
   * old execution-number behavior for pre-fix runs.
   */
  const roundsByExec = new Map<string, string[]>();
  for (const event of deps.db.events.getSince(run.id)) {
    if (
      (event.type === "node.queued" || event.type === "node.started") &&
      Array.isArray(event.rounds) &&
      event.rounds.every((token: unknown) => typeof token === "string")
    ) {
      roundsByExec.set(`${event.nodeId}#${event.iteration}`, event.rounds as string[]);
    }
  }
  const lineageOf = (nodeId: string, iteration: number): string[] =>
    roundsByExec.get(`${nodeId}#${iteration}`) ?? [`${nodeId}#${iteration}`];
  const freshRound = (joinId: string): JoinPending => freshJoinPending(topology, joinId);
  const arrivedSet = (pending: JoinPending | undefined): Set<string> =>
    new Set(
      [...(pending?.states ?? new Map()).entries()]
        .filter(([, edgeState]) => edgeState === "arrived")
        .map(([id]) => id),
    );
  const joinTriggered = (joinId: string): boolean => {
    const join = topology.joins.get(joinId);
    if (join === undefined) return false;
    const pending = state.joinPending.get(joinId) ?? freshRound(joinId);
    const arrived = arrivedSet(pending).size;
    if (join.config.mode === "any") return arrived >= 1;
    return arrived >= (topology.incoming.get(joinId) ?? []).length;
  };
  for (const entry of entries) {
    if (entry.kind === "node") {
      state.execCount.set(
        entry.nodeId,
        Math.max(state.execCount.get(entry.nodeId) ?? 0, entry.iteration),
      );
      const node = topology.nodesById.get(entry.nodeId);
      if (node !== undefined && node.type === "join") {
        const current = state.joinPending.get(entry.nodeId);
        const arrived =
          entry.nodeId === pendingJoinTrigger && pendingTriggerArrived !== undefined
            ? pendingTriggerArrived
            : arrivedSet(current);
        state.outputs.set(entry.nodeId, renderJoinOutput(topology, state, entry.nodeId, arrived));
        state.joinPending.set(entry.nodeId, freshRound(entry.nodeId));
        if (entry.nodeId === pendingJoinTrigger) {
          pendingJoinTrigger = undefined; // the trigger persisted
          pendingTriggerArrived = undefined;
        }
        continue;
      }
      const row = rowsByKey.get(`${entry.nodeId}#${entry.iteration}`);
      if (row !== undefined && row.status === "success") {
        state.outputs.set(entry.nodeId, row.output);
        state.sessions.set(entry.nodeId, row.sessionId);
        state.runOutput = row.output;
      }
    } else {
      state.takenCounts.set(entry.edgeId, (state.takenCounts.get(entry.edgeId) ?? 0) + 1);
      const edge = topology.edgesById.get(entry.edgeId);
      if (edge !== undefined && topology.joins.has(edge.target)) {
        // Single trigger per round (#115): a delivery whose round already
        // triggered is stale — replay skips it exactly like the runtime
        // suppresses it, so a later resume never re-fires the trigger.
        const round = joinRoundKey(topology, edge.target, lineageOf(edge.source, entry.iteration));
        if (state.joinTriggeredRounds.get(edge.target)?.has(round)) continue;
        const pending = state.joinPending.get(edge.target) ?? freshRound(edge.target);
        pending.states.set(entry.edgeId, "arrived");
        pending.arrivals.set(entry.edgeId, round);
        state.joinPending.set(edge.target, pending);
        if (joinTriggered(edge.target)) {
          // The trigger appends the join's node entry synchronously; if
          // that entry never persisted, resume must fire it on the still-
          // pending round. The consumed arrivals' rounds are recorded so
          // suppressed siblings of the same round cannot re-trigger it.
          const rounds = state.joinTriggeredRounds.get(edge.target) ?? new Set<string>();
          for (const consumed of new Set(pending.arrivals.values())) rounds.add(consumed);
          state.joinTriggeredRounds.set(edge.target, rounds);
          pendingJoinTrigger = edge.target;
          pendingTriggerRounds = lineageOf(edge.source, entry.iteration);
          pendingTriggerArrived = arrivedSet(pending);
        }
      }
    }
  }
  // Ensure every join has a pending round even if untouched so far.
  for (const joinId of topology.joins.keys()) {
    if (!state.joinPending.has(joinId)) state.joinPending.set(joinId, freshRound(joinId));
  }

  const outcome: ResumeOutcome = {
    state,
    initial: [],
    redrive: undefined,
    pendingJoinTrigger,
    pendingTriggerRounds,
  };

  // Restart points: every non-terminal StepRun (in-flight or still queued).
  // The routing context comes from the last persisted traversal INTO the
  // node (an agent node may carry conditional back-edges in addition to its
  // single unconditional incoming edge).
  //
  // Fan-out branch attribution survives the resume (#115): the pre-crash
  // `node.queued` events carried the branch `edgeId`; failing that (an
  // older, event-less log), the graph shape recovers it when the node is
  // unambiguously a branch target — a single unconditional in-edge whose
  // source fans out.
  const queuedEdgeIds = new Map<string, string>();
  for (const event of deps.db.events.getSince(run.id)) {
    if (event.type === "node.queued" && event.edgeId !== undefined) {
      queuedEdgeIds.set(`${event.nodeId}#${event.iteration}`, event.edgeId);
    }
  }
  const branchEdgeInto = (nodeId: string): string | undefined => {
    const unconditionalIn = (topology.incoming.get(nodeId) ?? []).filter(isUnconditional);
    if (unconditionalIn.length !== 1) return undefined;
    const [edge] = unconditionalIn;
    if (edge === undefined) return undefined;
    const sourceIsFanOut =
      (topology.outgoing.get(edge.source) ?? []).filter(isUnconditional).length >= 2;
    return sourceIsFanOut ? edge.id : undefined;
  };
  // Whether a non-terminal row's execution was superseded pre-crash: a
  // direct branch sibling of a join whose round (the sibling's execution
  // number) already triggered — an any-join loser the trigger-time
  // cancellation never got to settle. Its delivery would be stale, so
  // resume settles it `aborted` (mirroring the live cancellation) instead
  // of re-running it.
  const isSupersededLoser = (nodeId: string, iteration: number): boolean => {
    const key = `${nodeId}#${iteration}`;
    for (const [joinId, siblings] of topology.joinSiblings) {
      if (!siblings.has(nodeId)) continue;
      const triggered = state.joinTriggeredRounds.get(joinId);
      if (triggered === undefined || triggered.size === 0) continue;
      if (triggered.has(joinRoundKey(topology, joinId, lineageOf(nodeId, iteration)))) return true;
      // Legacy logs (no lineage-bearing events): an interrupted DIRECT
      // sibling of a join that already triggered is assumed superseded —
      // exact round matching needs the lineage tokens new runs emit.
      if (!roundsByExec.has(key)) return true;
    }
    return false;
  };
  for (const row of rows) {
    if (
      row.status !== "queued" &&
      row.status !== "running" &&
      row.status !== "interrupted" &&
      // #118: a gate interrupted mid-wait re-enters the await on resume.
      row.status !== "awaiting_approval"
    ) {
      continue;
    }
    if (isSupersededLoser(row.stepId, row.iteration)) {
      const viaEdgeId =
        queuedEdgeIds.get(`${row.stepId}#${row.iteration}`) ?? branchEdgeInto(row.stepId);
      deps.db.stepRuns.update(row.id, { status: "aborted", output: "" });
      deps.appendEvent(run.id, {
        type: "node.completed",
        nodeId: row.stepId,
        nodeName: topology.nodesById.get(row.stepId)?.name ?? row.stepId,
        iteration: row.iteration,
        status: "aborted",
        output: "",
        durationMs: 0,
        ...(viaEdgeId === undefined ? {} : { edgeId: viaEdgeId }),
      });
      state.breadcrumb = [
        ...state.breadcrumb,
        { kind: "node" as const, nodeId: row.stepId, iteration: row.iteration },
      ];
      deps.db.runs.update(run.id, { breadcrumb: state.breadcrumb });
      continue;
    }
    const lastInto = [...entries]
      .reverse()
      .find(
        (item): item is Extract<typeof item, { kind: "edge" }> =>
          item.kind === "edge" &&
          (topology.edgesById.get(item.edgeId)?.target ?? undefined) === row.stepId,
      );
    const source =
      lastInto !== undefined
        ? topology.edgesById.get(lastInto.edgeId)?.source
        : (topology.incoming.get(row.stepId) ?? [])[0]?.source;
    outcome.initial.push({
      nodeId: row.stepId,
      iteration: row.iteration,
      prevOutput: source === undefined ? "" : (state.outputs.get(source) ?? ""),
      prevSessionId: source === undefined ? undefined : state.sessions.get(source),
      restartSessionId: row.sessionId,
      viaEdgeId: queuedEdgeIds.get(`${row.stepId}#${row.iteration}`) ?? branchEdgeInto(row.stepId),
      rounds: lineageOf(row.stepId, row.iteration),
    });
  }

  if (outcome.initial.length === 0) {
    const last = entries[entries.length - 1];
    if (last === undefined) return undefined;
    if (last.kind === "edge") {
      const edge = topology.edgesById.get(last.edgeId);
      const target = edge === undefined ? undefined : topology.nodesById.get(edge.target);
      if (edge === undefined || target === undefined || target.type === "exit") {
        // The traversal was persisted but the success finalize was not: finish.
        deps.finalizeRun(run.id, "success", { output: state.runOutput });
        return { ...outcome, pendingJoinTrigger: undefined };
      }
      // Scheduling follows the edge append synchronously; a target with no
      // row at the expected iteration was never scheduled (crash window).
      if (isRunnableGraphNode(target)) {
        const iteration = (state.execCount.get(target.id) ?? 0) + 1;
        if (rowsByKey.get(`${target.id}#${iteration}`) === undefined) {
          state.execCount.set(target.id, iteration);
          outcome.initial.push({
            nodeId: target.id,
            iteration,
            prevOutput: state.outputs.get(edge.source) ?? "",
            prevSessionId: state.sessions.get(edge.source),
            restartSessionId: undefined,
            viaEdgeId: undefined,
            rounds: lineageOf(edge.source, last.iteration),
          });
        }
      }
      // Join targets: satisfaction replayed above (incl. pending triggers).
      return outcome;
    }
    // Routing never persisted: re-drive the advance from the recorded output.
    outcome.redrive = {
      nodeId: last.nodeId,
      output: state.outputs.get(last.nodeId) ?? "",
      iteration: last.iteration,
      rounds: lineageOf(last.nodeId, last.iteration),
    };
  }

  return outcome;
}

/**
 * Executes one node execution: StepRun lifecycle (reuse/restart aware),
 * `node.*` events, prompt rendering against the graph variable map, driver
 * invocation, streamed-event persistence, per-step diff, session recording.
 * A `config.retry` policy (#119) re-executes failed attempts (or every
 * attempt, `retryOn: "always"`) up to `maxAttempts`, emitting an ordered
 * `node.retry` event per retried attempt — retries stay INSIDE the
 * execution: one StepRun row (its `attempt` field bumps in place), no edge
 * traversal, no consumption of edge cycle/iteration caps. Sub-workflow
 * nodes (#117) dispatch to {@link runSubworkflowNode} instead of a driver.
 * Never throws — failures land in the returned outcome.
 */
async function runNode(
  deps: GraphEngineDeps,
  runId: string,
  worktreePath: string,
  node: AgentGraphNode | SubworkflowGraphNode | ApprovalGraphNode,
  exec: ScheduledExec,
  state: GraphRunState,
  control: RunControl,
  ctx: ExecContext,
  diffBase: { ref: string },
  depth: number,
  retrySeams: NodeRetrySeams = DEFAULT_RETRY_SEAMS,
): Promise<NodeOutcome> {
  if (node.type === "subworkflow") {
    return runSubworkflowNode(deps, runId, node, exec, state, control, ctx, depth);
  }
  if (node.type === "approval") {
    return runApprovalNode(deps, runId, node, exec, state, control, ctx);
  }
  const { iteration } = exec;
  const stepRun = deps.beginStepRun(runId, { stepId: node.id }, iteration);
  const currentRow = deps.db.runs.get(runId);
  if (
    currentRow !== undefined &&
    currentRow.iteration !== iteration - 1 &&
    currentRow.iteration < iteration - 1
  ) {
    deps.db.runs.update(runId, { iteration: iteration - 1 });
  }
  const startedAtMs = Date.now();
  deps.appendEvent(runId, {
    type: "node.started",
    nodeId: node.id,
    nodeName: node.name,
    iteration,
    ...(exec.viaEdgeId === undefined ? {} : { edgeId: exec.viaEdgeId }),
    rounds: exec.rounds,
  });
  deps.log.info({ runId, nodeId: node.id, iteration }, "node started");

  const fail = (error: string): NodeOutcome => {
    deps.db.stepRuns.update(stepRun.id, { status: "failed", output: "" });
    deps.appendEvent(runId, {
      type: "node.completed",
      nodeId: node.id,
      nodeName: node.name,
      iteration,
      status: "failed",
      output: "",
      durationMs: Math.max(0, Date.now() - startedAtMs),
      error: deps.redactText(runId, error),
      ...(exec.viaEdgeId === undefined ? {} : { edgeId: exec.viaEdgeId }),
    });
    appendBreadcrumb(deps, runId, state, { kind: "node", nodeId: node.id, iteration });
    return { status: "failed", output: "", error, sessionId: undefined };
  };

  // Prompt rendering happens per-execution so missing {{output:<nodeId>}}
  // references (a branch that skipped the referenced node) are node
  // failures with an actionable message, not run crashes.
  let prompt: string;
  try {
    prompt = renderPromptTemplate(node.config.promptTemplate, {
      task: state.task,
      prevOutput: exec.prevOutput,
      iterations: iteration,
      outputs: Object.fromEntries(state.outputs),
    });
  } catch (err) {
    return fail(`prompt template failed to render: ${describeError(err)}`);
  }

  const driver: AgentDriver = deps.drivers.getDriver(node.config.driver);
  // Session chaining: a restarted (resumed) execution continues its own
  // recorded session; a continueSession node reuses its previous
  // execution's session across re-entries, else the routing source's.
  const rows = deps.db.stepRuns.listByRun(runId);
  let inherited: string | undefined;
  if (node.config.continueSession) {
    inherited =
      iteration > 1
        ? (rows.find((row) => row.stepId === node.id && row.iteration === iteration - 1)
            ?.sessionId ?? exec.prevSessionId)
        : exec.prevSessionId;
  }
  let sessionId = exec.restartSessionId ?? inherited;
  // Project secrets (#93): decrypted env merged into the driver process.
  const secretEnv = deps.runSecretsEnv(runId);
  // Sandboxed runs (#102): driver cwd becomes the CONTAINER workspace and
  // the command runs through the sandbox exec seam.
  const sandbox = deps.runSandbox(runId);

  const retry = node.config.retry;
  const maxAttempts = retry?.maxAttempts ?? 1;

  /**
   * Backoff wait before the next attempt (#119): cancellable — a run abort
   * (or branch cancellation) wakes it so the execution settles `aborted`
   * instead of sleeping on a dying run.
   */
  const waitBackoff = (nextInMs: number): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false;
      // Holder so `settle` can cancel/unsubscribe handles that are attached
      // after its definition (the timer factory may fire synchronously).
      const live: { timer?: ApprovalTimerHandle; off?: () => void } = {};
      const settle = (): void => {
        if (settled) return;
        settled = true;
        live.timer?.cancel();
        if (ctx.cancelWait === settle) ctx.cancelWait = undefined;
        live.off?.();
        resolve();
      };
      ctx.cancelWait = settle;
      live.timer = retrySeams.timer(nextInMs, settle);
      live.off = control.onAbort?.(settle);
      // A fake timer may have fired synchronously before the attachments.
      if (settled && ctx.cancelWait === settle) ctx.cancelWait = undefined;
    });

  let attempt = 1;
  let exit: Awaited<AgentHandle["exited"]>;
  let lastErrorMessage: string | undefined;
  let sessionFromEvents: string | undefined;
  let status: RunStatus;
  let error: string | undefined;
  for (;;) {
    lastErrorMessage = undefined;
    sessionFromEvents = undefined;
    error = undefined;
    const handle = driver.start({
      cwd: sandbox?.workspacePath ?? worktreePath,
      prompt,
      mode: node.config.mode,
      ...(node.config.model === undefined ? {} : { model: node.config.model }),
      ...(node.config.agent === undefined ? {} : { agent: node.config.agent }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(secretEnv === undefined || Object.keys(secretEnv).length === 0
        ? {}
        : { env: { ...secretEnv } }),
      ...(sandbox === undefined ? {} : { exec: sandbox.exec }),
    });
    ctx.handle = handle;
    control.onHandle?.(handle);

    try {
      for await (const event of handle.events) {
        deps.appendEvent(runId, event);
        if (event.type === "session") {
          sessionFromEvents = event.sessionId;
          deps.db.stepRuns.update(stepRun.id, { sessionId: event.sessionId });
        }
        if (event.type === "error") {
          lastErrorMessage = event.message;
        }
      }
    } catch (err) {
      await handle.abort().catch(() => {});
      throw err;
    }

    exit = await handle.exited;
    ctx.handle = undefined;

    if (ctx.cancelRequested) {
      // Branch cancellation (any-trigger / fail-fast) raced the exit — a
      // driver that ignored its abort and finished naturally included: the
      // superseded result is discarded, settling exactly like an aborted
      // driver so it can never deliver into its join and re-trigger it.
      status = "aborted";
    } else if (exit.reason === "exit" && exit.code === 0) {
      status = "success";
    } else if (exit.reason === "aborted" && control.isAbortRequested()) {
      status = "aborted";
    } else {
      status = "failed";
      error =
        exit.reason === "error"
          ? (lastErrorMessage ?? "agent run errored")
          : exit.reason === "aborted"
            ? "agent run aborted unexpectedly"
            : `agent exited with code ${exit.code ?? "unknown"}`;
    }

    // Retry decision (#119): never on aborts (the run/branch is going
    // down); `failure` retries failed attempts only, `always` any outcome.
    if (
      retry === undefined ||
      attempt >= maxAttempts ||
      status === "aborted" ||
      (retry.retryOn === "failure" && status !== "failed")
    ) {
      break;
    }

    const nextInMs = retryBackoffMs(retry, attempt, retrySeams.jitter);
    deps.appendEvent(runId, {
      type: "node.retry",
      nodeId: node.id,
      nodeName: node.name,
      iteration,
      attempt,
      nextInMs,
      ...(error === undefined ? {} : { error: deps.redactText(runId, error) }),
    });
    deps.log.warn(
      { runId, nodeId: node.id, iteration, attempt, nextInMs, status },
      "node attempt retried",
    );
    await waitBackoff(nextInMs);
    if (ctx.cancelRequested || control.isAbortRequested()) {
      // The run died during the backoff: settle aborted, no further starts.
      status = "aborted";
      error = undefined;
      break;
    }
    attempt += 1;
    deps.db.stepRuns.update(stepRun.id, { attempt });
    // Session preservation across attempts (#119): a continueSession node
    // keeps the session its previous attempt announced (drivers may not
    // re-emit `session` when resuming); anything else starts fresh.
    sessionId = node.config.continueSession ? (sessionFromEvents ?? sessionId) : undefined;
  }

  const diff = await deps.captureDiff(runId, worktreePath, diffBase);

  const effectiveSessionId = sessionFromEvents ?? sessionId ?? exec.restartSessionId ?? inherited;
  // Attempt detail on the settled failure (#119): the exhaustion attribution.
  const attemptDetail =
    maxAttempts > 1 && status === "failed" ? ` (attempt ${attempt}/${maxAttempts})` : "";
  const settledError = error === undefined ? undefined : `${error}${attemptDetail}`;
  deps.db.stepRuns.update(stepRun.id, {
    status,
    // A configured policy always records its settled attempt; a resumed row
    // that already carried one resets it (the retry budget restarts with the
    // execution). Plain single-attempt rows keep absent-means-1.
    ...(retry === undefined && stepRun.attempt === undefined ? {} : { attempt }),
    output: deps.redactText(runId, exit.output),
    ...(diff.length > 0 ? { diff: deps.redactText(runId, diff) } : {}),
  });
  deps.appendEvent(runId, {
    type: "node.completed",
    nodeId: node.id,
    nodeName: node.name,
    iteration,
    status,
    output: exit.output === "" ? "" : deps.redactText(runId, exit.output),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    ...(settledError === undefined ? {} : { error: deps.redactText(runId, settledError) }),
    ...(exec.viaEdgeId === undefined ? {} : { edgeId: exec.viaEdgeId }),
    ...(attempt > 1 ? { attempt } : {}),
  });
  appendBreadcrumb(deps, runId, state, { kind: "node", nodeId: node.id, iteration });
  deps.log.info({ runId, nodeId: node.id, iteration, status, attempt }, "node finished");

  return {
    status,
    output: exit.output,
    error: settledError,
    sessionId: effectiveSessionId,
  };
}

/**
 * Executes one sub-workflow node execution (#117): StepRun lifecycle +
 * `node.*` events like an agent node, but the work is a CHILD RUN of the
 * referenced workflow — spawned INLINE through `deps.executeChildRun`
 * (never the scheduler; the child counts as part of this run's global
 * slot), awaited to its terminal state. The node's output is the child
 * run's final output; `childRunId` rides the `node.completed` event (the
 * run detail graph view links into the child). Child failure fails the
 * node (v0.2 strict); an aborted child (parent abort or branch
 * cancellation — the child shares this execution's abort chain) settles
 * the node `aborted`. Never throws — failures land in the outcome.
 */
async function runSubworkflowNode(
  deps: GraphEngineDeps,
  runId: string,
  node: SubworkflowGraphNode,
  exec: ScheduledExec,
  state: GraphRunState,
  control: RunControl,
  ctx: ExecContext,
  depth: number,
): Promise<NodeOutcome> {
  const { iteration } = exec;
  const stepRun = deps.beginStepRun(runId, { stepId: node.id }, iteration);
  const startedAtMs = Date.now();
  deps.appendEvent(runId, {
    type: "node.started",
    nodeId: node.id,
    nodeName: node.name,
    iteration,
    ...(exec.viaEdgeId === undefined ? {} : { edgeId: exec.viaEdgeId }),
    rounds: exec.rounds,
  });
  deps.log.info({ runId, nodeId: node.id, iteration }, "sub-workflow node started");

  /** Settles the node execution (StepRun + node.completed + breadcrumb). */
  const settle = (
    status: RunStatus,
    output: string,
    error: string | undefined,
    childRunId: string | undefined,
  ): NodeOutcome => {
    deps.db.stepRuns.update(stepRun.id, {
      status,
      output: output === "" ? "" : deps.redactText(runId, output),
    });
    deps.appendEvent(runId, {
      type: "node.completed",
      nodeId: node.id,
      nodeName: node.name,
      iteration,
      status,
      output: output === "" ? "" : deps.redactText(runId, output),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      ...(error === undefined ? {} : { error: deps.redactText(runId, error) }),
      ...(exec.viaEdgeId === undefined ? {} : { edgeId: exec.viaEdgeId }),
      ...(childRunId === undefined ? {} : { childRunId }),
    });
    appendBreadcrumb(deps, runId, state, { kind: "node", nodeId: node.id, iteration });
    deps.log.info(
      { runId, nodeId: node.id, iteration, status, childRunId },
      "sub-workflow node finished",
    );
    return { status, output, error, sessionId: undefined };
  };

  // Depth cap (#117): spawning one level deeper than allowed fails the
  // node (and through fail-fast, the run) with a clear error instead of
  // recursing forever on self-/mutually-referencing workflows.
  if (depth + 1 > MAX_SUBWORKFLOW_DEPTH) {
    return settle(
      "failed",
      "",
      `sub-workflow nesting depth exceeds the maximum of ${MAX_SUBWORKFLOW_DEPTH}: node "${node.name}" (${node.id}) would spawn a child at depth ${depth + 1}`,
      undefined,
    );
  }

  // The child shares this execution's abort chain: a parent run abort (or a
  // join/fail-fast branch cancellation, #115) aborts the child run through
  // its own frontier.
  const childControl: RunControl = {
    isAbortRequested: () => control.isAbortRequested() || ctx.cancelRequested,
    onHandle: control.onHandle,
  };

  let child: Awaited<ReturnType<GraphEngineDeps["executeChildRun"]>>;
  try {
    child = await deps.executeChildRun({
      parentRunId: runId,
      workflowId: node.config.workflowId,
      revision: node.config.revision,
      depth: depth + 1,
      task: state.task,
      control: childControl,
    });
  } catch (err) {
    return settle("failed", "", `child run crashed: ${describeError(err)}`, undefined);
  }
  if (!child.ok) {
    return settle("failed", "", child.error, undefined);
  }

  // Terminal child → node outcome. Success passes the child's final output
  // through (addressable downstream as {{output:<nodeId>}}); failure keeps
  // the child attribution; aborted settles aborted when the parent is going
  // down with it, else reads as a node failure (v0.2 strict).
  if (child.status === "success") {
    return settle("success", child.output, undefined, child.runId);
  }
  if (child.status === "aborted" && (control.isAbortRequested() || ctx.cancelRequested)) {
    return settle("aborted", "", undefined, child.runId);
  }
  const verb =
    child.status === "aborted" ? "was aborted" : `failed: ${child.error ?? "unknown error"}`;
  return settle("failed", "", `child run ${child.runId} ${verb}`, child.runId);
}

/**
 * Executes one approval gate node execution (#118): StepRun lifecycle +
 * `node.started` like an agent node, but the "work" is a human PAUSE —
 * {@link GraphEngineDeps.awaitApproval} opens the gate (persisting
 * `awaitingNodeId`/`awaitingSince` on the run row and emitting
 * `node.awaiting` on a fresh wait) and the engine blocks on it. On
 * resolution:
 *
 * - **approve** — the node completes `success` with the note (default
 *   `"approved"`) as its output, addressable downstream; routing branches
 *   on the sentinel `"approved"`, never the note text.
 * - **reject / timeout** — the node ALSO completes `success`, with output
 *   `rejected: <note>` (`"timed out"` for a timeout) and the outcome
 *   carries `approvalRejected`: the scheduler fails the run UNLESS the
 *   node's conditional outgoing edges branch on the `"rejected"` sentinel.
 * - **abort** — the node settles `aborted` exactly like an aborted
 *   driver, and the run follows the abort path.
 *
 * A resume after a daemon restart re-enters the wait through the same
 * row (`resumed` keeps the persisted `node.awaiting` event singular) and
 * never re-executes anything — there is nothing to re-execute. Never
 * throws — failures land in the outcome.
 */
async function runApprovalNode(
  deps: GraphEngineDeps,
  runId: string,
  node: ApprovalGraphNode,
  exec: ScheduledExec,
  state: GraphRunState,
  control: RunControl,
  ctx: ExecContext,
): Promise<NodeOutcome> {
  const { iteration } = exec;
  const stepRun = deps.beginStepRun(runId, { stepId: node.id }, iteration);
  const startedAtMs = Date.now();
  deps.appendEvent(runId, {
    type: "node.started",
    nodeId: node.id,
    nodeName: node.name,
    iteration,
    ...(exec.viaEdgeId === undefined ? {} : { edgeId: exec.viaEdgeId }),
    rounds: exec.rounds,
  });
  deps.log.info({ runId, nodeId: node.id, iteration }, "approval node started");

  /** Settles the node execution (StepRun + node.completed + breadcrumb). */
  const settle = (
    status: RunStatus,
    output: string,
    approvalRejected: { note: string } | undefined,
    routingOutput?: string,
  ): NodeOutcome => {
    deps.db.stepRuns.update(stepRun.id, {
      status,
      output: output === "" ? "" : deps.redactText(runId, output),
    });
    deps.appendEvent(runId, {
      type: "node.completed",
      nodeId: node.id,
      nodeName: node.name,
      iteration,
      status,
      output: output === "" ? "" : deps.redactText(runId, output),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      ...(exec.viaEdgeId === undefined ? {} : { edgeId: exec.viaEdgeId }),
    });
    appendBreadcrumb(deps, runId, state, { kind: "node", nodeId: node.id, iteration });
    deps.log.info({ runId, nodeId: node.id, iteration, status }, "approval node finished");
    return {
      status,
      output,
      error: undefined,
      sessionId: undefined,
      ...(approvalRejected === undefined ? {} : { approvalRejected }),
      ...(routingOutput === undefined ? {} : { routingOutput }),
    };
  };

  // A resumed wait keeps the pre-restart node.awaiting event: the run row
  // still carries awaitingNodeId for exactly this node.
  const runRow = deps.db.runs.get(runId);
  const resumed = runRow?.awaitingNodeId === node.id;

  // The execution is now PAUSED (#118): the row reflects the wait (it
  // flips back through running → its settle below on resolution).
  deps.db.stepRuns.update(stepRun.id, { status: "awaiting_approval" });

  // Branch cancellation (fail-fast / any-trigger loser) must wake the gate
  // like run abort does; wiring the ctx flag through a gate-scoped control
  // lets the ONE onAbort listener serve both wake sources.
  const gateControl: RunControl = {
    isAbortRequested: () => control.isAbortRequested() || ctx.cancelRequested,
    onHandle: control.onHandle,
    onAbort: (listener) => {
      ctx.cancelWait = listener;
      const offRunAbort = control.onAbort?.(listener);
      return () => {
        if (ctx.cancelWait === listener) ctx.cancelWait = undefined;
        offRunAbort?.();
      };
    },
  };
  let outcome: ApprovalGateOutcome;
  try {
    outcome = await deps.awaitApproval({
      runId,
      node,
      iteration,
      control: gateControl,
      resumed,
    });
  } finally {
    ctx.cancelWait = undefined;
  }

  if (outcome.reason === "suspend") {
    // Graceful daemon shutdown: settle interrupted while KEEPING the run
    // row's awaiting fields, so resume re-enters this exact wait.
    return settle("interrupted", "", undefined);
  }

  if (outcome.reason === "abort") {
    // Run abort / branch cancellation mid-wait: settle like an aborted
    // driver so the run's abort path proceeds unchanged.
    return settle("aborted", "", undefined);
  }

  if (outcome.reason === "timeout") {
    deps.appendEvent(runId, {
      type: "node.approved",
      nodeId: node.id,
      nodeName: node.name,
      iteration,
      approved: false,
      note: APPROVAL_TIMEOUT_NOTE,
    });
    return settle(
      "success",
      `rejected: ${APPROVAL_TIMEOUT_NOTE}`,
      {
        note: APPROVAL_TIMEOUT_NOTE,
      },
      "rejected",
    );
  }

  const decisionNote = outcome.note?.trim();
  deps.appendEvent(runId, {
    type: "node.approved",
    nodeId: node.id,
    nodeName: node.name,
    iteration,
    approved: outcome.approved,
    ...(decisionNote === undefined || decisionNote.length === 0
      ? {}
      : { note: deps.redactText(runId, decisionNote) }),
  });

  if (outcome.approved) {
    const output =
      decisionNote !== undefined && decisionNote.length > 0 ? decisionNote : "approved";
    // Route on the sentinel, never the note: a note containing "rejected"
    // must not steer an approved gate onto the fix-up branch.
    return settle("success", output, undefined, output === "approved" ? undefined : "approved");
  }
  const note = decisionNote !== undefined && decisionNote.length > 0 ? decisionNote : "";
  const rejectedOutput = note.length > 0 ? `rejected: ${note}` : "rejected";
  return settle("success", rejectedOutput, { note }, "rejected");
}

/** Rejection note used when an approval gate times out (#118). */
export const APPROVAL_TIMEOUT_NOTE = "timed out";

/** Appends a breadcrumb entry in memory + onto the run row (cheap, sync). */
function appendBreadcrumb(
  deps: GraphEngineDeps,
  runId: string,
  state: GraphRunState,
  entry: BreadcrumbEntry,
): void {
  state.breadcrumb = [...state.breadcrumb, entry];
  deps.db.runs.update(runId, { breadcrumb: state.breadcrumb });
}

/**
 * Drives a graph-revision run to a terminal state (#115 parallel frontier).
 * Called by the flow engine's `executeRun` once the run row, worktree and
 * abort guards are in place; never throws (failures funnel into the run row
 * through `deps.finalizeRun`, and the flow engine's outer catch is the last
 * resort).
 *
 * The loop keeps a ready queue of scheduled executions and at most
 * `innerConcurrency` in flight, waiting on the first settlement each round.
 * Terminal actions (fail-fast, abort) cancel + drain every in-flight branch
 * BEFORE the run row turns terminal, so StepRun rows and `node.*` events
 * settle in a deterministic order. An empty frontier finalizes the run:
 * success, unless an engaged join never triggered (attribution in the error).
 */
export async function executeGraphRun(
  deps: GraphEngineDeps,
  run: Run,
  graph: WorkflowGraph,
  worktreePath: string,
  control: RunControl,
  options?: GraphRunOptions,
): Promise<void> {
  const runId = run.id;
  const topology = buildTopology(graph);
  const innerConcurrency = Math.max(
    1,
    Math.min(options?.innerConcurrency ?? DEFAULT_INNER_CONCURRENCY, MAX_INNER_CONCURRENCY),
  );
  /** Sub-workflow nesting depth of THIS run (#117); 0 for top-level runs. */
  const depth = options?.depth ?? 0;
  /** Retry seams (#119): injectable backoff timer + jitter. */
  const retrySeams = options?.retrySeams ?? DEFAULT_RETRY_SEAMS;

  // Compile every edge condition once per run (regex compile failures on
  // schema-bypassing data fail the run with a clear error up front).
  const evaluators = new Map<string, ExitEvaluator>();
  for (const edge of graph.edges) {
    if (isUnconditional(edge)) continue;
    const compiled = compileExitCondition(edge.condition, `edge "${edge.id}" condition `);
    if (compiled instanceof Error) {
      deps.finalizeRun(runId, "failed", { error: compiled.message });
      return;
    }
    evaluators.set(edge.id, compiled);
  }

  const freshRound = (joinId: string): JoinPending => freshJoinPending(topology, joinId);

  const resumed = reconstructGraphResume(deps, run, topology);
  const state: GraphRunState = resumed?.state ?? {
    outputs: new Map(),
    sessions: new Map(),
    execCount: new Map(),
    takenCounts: new Map(),
    joinPending: new Map(),
    joinTriggeredRounds: new Map(),
    breadcrumb: [],
    execRounds: new Map(),
    runOutput: "",
    totalExecutions: 0,
    task: run.task ?? "",
  };
  for (const joinId of topology.joins.keys()) {
    if (!state.joinPending.has(joinId)) state.joinPending.set(joinId, freshRound(joinId));
  }

  const ready: ScheduledExec[] = [];
  /** In-flight executions (their task promises never reject). */
  const contexts = new Set<ExecContext>();
  /** Terminal action once the in-flight branches drain; set = run is dying. */
  let terminal:
    | { kind: "fail-run"; error: string; output?: string }
    | { kind: "abort" }
    | { kind: "interrupt" }
    | undefined;

  /**
   * Schedules one execution: queued StepRun row + `node.queued` event.
   * Restart adoption (#19/#115): when a persisted queued/running/
   * interrupted row already exists for this (node, iteration) it announced
   * itself pre-crash — the row is reused and the `node.queued` event is
   * NOT re-emitted (no duplicates across restart points).
   */
  const scheduleExec = (exec: ScheduledExec): void => {
    const node = topology.nodesById.get(exec.nodeId);
    if (node === undefined || !isRunnableGraphNode(node)) return;
    state.execCount.set(
      exec.nodeId,
      Math.max(state.execCount.get(exec.nodeId) ?? 0, exec.iteration),
    );
    state.execRounds.set(`${exec.nodeId}#${exec.iteration}`, exec.rounds);
    const adopted = deps.db.stepRuns.listByRun(runId).find(
      (row) =>
        row.stepId === node.id &&
        row.iteration === exec.iteration &&
        (row.status === "queued" ||
          row.status === "running" ||
          row.status === "interrupted" ||
          // #118: an interrupted approval wait (not yet swept).
          row.status === "awaiting_approval"),
    );
    if (adopted === undefined) {
      deps.scheduleStepRun(runId, { stepId: node.id }, exec.iteration);
      deps.appendEvent(runId, {
        type: "node.queued",
        nodeId: node.id,
        nodeName: node.name,
        iteration: exec.iteration,
        ...(exec.viaEdgeId === undefined ? {} : { edgeId: exec.viaEdgeId }),
        rounds: exec.rounds,
      });
    }
    ready.push(exec);
  };

  /**
   * Settles a cancelled execution that never started (spliced from the
   * ready queue by an any-trigger / fail-fast / drain, #115): its
   * never-started StepRun row flips `aborted` with empty output —
   * cancelled-not-started unifies with cancelled-in-flight, never swept to
   * the run-level status afterwards (false success on a winning run) — and
   * a terminal `node.completed {status:"aborted"}` event plus breadcrumb
   * entry mirror the in-flight cancel settlement.
   */
  const settleCancelledExec = (exec: ScheduledExec): void => {
    const node = topology.nodesById.get(exec.nodeId);
    if (node === undefined) return;
    const row = deps.db.stepRuns
      .listByRun(runId)
      .find(
        (candidate) =>
          candidate.stepId === node.id &&
          candidate.iteration === exec.iteration &&
          (candidate.status === "queued" ||
            candidate.status === "running" ||
            candidate.status === "interrupted" ||
            candidate.status === "awaiting_approval"),
      );
    if (row !== undefined) deps.db.stepRuns.update(row.id, { status: "aborted", output: "" });
    deps.appendEvent(runId, {
      type: "node.completed",
      nodeId: node.id,
      nodeName: node.name,
      iteration: exec.iteration,
      status: "aborted",
      output: "",
      durationMs: 0,
      ...(exec.viaEdgeId === undefined ? {} : { edgeId: exec.viaEdgeId }),
    });
    appendBreadcrumb(deps, runId, state, {
      kind: "node",
      nodeId: node.id,
      iteration: exec.iteration,
    });
  };

  /**
   * Cancels in-flight executions (aborting their drivers — a loser that
   * ignores the abort still settles `aborted` on its natural exit) and
   * splices still-queued ones, settling their never-started rows (#115).
   */
  const cancelExecutions = (scope: (nodeId: string) => boolean): void => {
    for (const ctx of contexts) {
      if (!scope(ctx.node.id)) continue;
      ctx.cancelRequested = true;
      if (ctx.handle !== undefined) void ctx.handle.abort().catch(() => {});
      // Approval gates and retry backoffs have no handle — the registered
      // wait listener is their abort signal (#118/#119).
      ctx.cancelWait?.();
    }
    for (let i = ready.length - 1; i >= 0; i -= 1) {
      const exec = ready[i];
      if (exec === undefined || !scope(exec.nodeId)) continue;
      ready.splice(i, 1);
      settleCancelledExec(exec);
    }
  };

  /**
   * Fail-fast: cancel every in-flight branch (their drivers abort, their
   * StepRuns settle `aborted`), remember the terminal action — the run row
   * only turns `failed` once the drain completed.
   */
  const failRun = (error: string, output?: string): TaskVerdict => {
    if (terminal === undefined) {
      terminal = { kind: "fail-run", error, ...(output === undefined ? {} : { output }) };
    }
    cancelExecutions(() => true);
    return { kind: "fail-run", error, ...(output === undefined ? {} : { output }) };
  };

  /**
   * Marks the pending join edges sourced at `nodeId` — it finished without
   * delivering to them — and reports an engaged join that became
   * unsatisfiable (mode `any` with every incoming edge failed).
   */
  const markJoinEdges = (
    nodeId: string,
    mark: "failed" | "missed",
    exceptEdgeId?: string,
  ): string | undefined => {
    for (const [joinId, pending] of state.joinPending.entries()) {
      const join = topology.joins.get(joinId);
      if (join === undefined) continue;
      for (const edge of topology.incoming.get(joinId) ?? []) {
        if (edge.source !== nodeId || edge.id === exceptEdgeId) continue;
        if ((pending.states.get(edge.id) ?? "waiting") === "waiting")
          pending.states.set(edge.id, mark);
      }
      if (join.config.mode === "any") {
        const states = new Set(pending.states.values());
        if (
          states.size > 0 &&
          !states.has("waiting") &&
          !states.has("arrived") &&
          !states.has("missed")
        ) {
          return describeUnsatisfiedJoin(topology, join, pending);
        }
      }
    }
    return undefined;
  };

  /** Executes a triggered join instantly; returns its follow-up execs. */
  const triggerJoin = (
    joinId: string,
    siblingsOf: (joinId: string) => void,
    triggerRounds: readonly string[],
  ): ScheduledExec[] | undefined => {
    const join = topology.joins.get(joinId);
    if (join === undefined) return undefined;
    if (join.config.mode === "any") {
      // Racing semantics: the losing siblings are no longer needed — cancel
      // their in-flight/queued executions (#115).
      siblingsOf(joinId);
    }
    const pending = state.joinPending.get(joinId) ?? freshRound(joinId);
    const arrived = new Set(
      [...pending.states.entries()].filter(([, s]) => s === "arrived").map(([id]) => id),
    );
    // Single trigger per round (#115): the consumed arrivals' fan-out round
    // tokens mark this round as triggered — any sibling delivery of the
    // same round (a cancelled loser exiting naturally, or re-running after
    // a resume) is suppressed from re-triggering.
    const rounds = state.joinTriggeredRounds.get(joinId) ?? new Set<string>();
    for (const consumed of new Set(pending.arrivals.values())) rounds.add(consumed);
    state.joinTriggeredRounds.set(joinId, rounds);
    const output = renderJoinOutput(topology, state, joinId, arrived);
    const iteration = (state.execCount.get(joinId) ?? 0) + 1;
    state.execCount.set(joinId, iteration);
    state.execRounds.set(`${joinId}#${iteration}`, [...triggerRounds]);
    deps.appendEvent(runId, {
      type: "node.queued",
      nodeId: join.id,
      nodeName: join.name,
      iteration,
      rounds: [...triggerRounds],
    });
    deps.appendEvent(runId, {
      type: "node.started",
      nodeId: join.id,
      nodeName: join.name,
      iteration,
      rounds: [...triggerRounds],
    });
    deps.appendEvent(runId, {
      type: "node.completed",
      nodeId: join.id,
      nodeName: join.name,
      iteration,
      status: "success",
      output: deps.redactText(runId, output),
      durationMs: 0,
    });
    appendBreadcrumb(deps, runId, state, { kind: "node", nodeId: join.id, iteration });
    state.outputs.set(joinId, output);
    state.joinPending.set(joinId, freshRound(joinId));
    deps.log.info({ runId, joinId, iteration, mode: join.config.mode }, "join triggered");

    // Route out of the join: its single unconditional edge (a join is a
    // synchronizer, not a router — validation enforces the shape).
    const out = (topology.outgoing.get(joinId) ?? []).find(isUnconditional);
    if (out === undefined) return []; // terminal join: the branch ends here
    deps.appendEvent(runId, {
      type: "edge.taken",
      edgeId: out.id,
      source: out.source,
      target: out.target,
      matchedCondition: describeEdgeCondition(out),
      iteration,
    });
    appendBreadcrumb(deps, runId, state, { kind: "edge", edgeId: out.id, iteration });
    deps.log.info({ runId, edgeId: out.id, target: out.target }, "edge taken");
    const target = topology.nodesById.get(out.target);
    if (target === undefined) return undefined;
    if (!isExecutableGraphNode(target)) return []; // exit: the branch ends here
    return [
      {
        nodeId: target.id,
        iteration: (state.execCount.get(target.id) ?? 0) + 1,
        prevOutput: output,
        prevSessionId: state.sessions.get(joinId),
        restartSessionId: undefined,
        viaEdgeId: undefined,
        rounds: [...triggerRounds],
      },
    ];
  };

  /**
   * Satisfies a join's incoming edge (delivered by the source's execution
   * `sourceIteration` running in fan-out round `sourceRound`); triggers the
   * join per its mode, at most once per round.
   */
  const deliverToJoin = (
    edge: GraphEdge,
    sourceIteration: number,
    sourceRounds: readonly string[],
  ): TaskVerdict => {
    const join = topology.joins.get(edge.target);
    if (join === undefined) {
      return failRun(`edge "${edge.id}" targets unknown join "${edge.target}"`);
    }
    // Stale-round delivery (#115): this branch execution belongs to a
    // fan-out round the join already triggered on — suppressed, never
    // re-triggered (the downstream subgraph must execute exactly once per
    // round even if the losing sibling exited naturally or re-ran).
    const roundKey = joinRoundKey(topology, join.id, sourceRounds);
    if (state.joinTriggeredRounds.get(join.id)?.has(roundKey)) {
      deps.log.info(
        { runId, joinId: join.id, edgeId: edge.id, round: roundKey },
        "stale join delivery suppressed (round already triggered)",
      );
      return { kind: "suppressed" };
    }
    const pending = state.joinPending.get(join.id) ?? freshRound(join.id);
    pending.states.set(edge.id, "arrived");
    pending.arrivals.set(edge.id, roundKey);
    state.joinPending.set(join.id, pending);
    const incoming = topology.incoming.get(join.id) ?? [];
    const arrivedCount = [...pending.states.values()].filter((s) => s === "arrived").length;
    const triggered =
      join.config.mode === "any" ? arrivedCount >= 1 : arrivedCount >= incoming.length;
    if (!triggered) return { kind: "continue" }; // the join keeps waiting

    const follow = triggerJoin(
      join.id,
      (scopeJoinId) => {
        cancelExecutions((nodeId) => topology.failureScope.get(nodeId)?.joinId === scopeJoinId);
      },
      sourceRounds,
    );
    if (follow === undefined) return failRun(`join "${join.id}" could not execute`);
    for (const exec of follow) scheduleExec(exec);
    return { kind: "continue" };
  };

  /** Emits `edge.taken`, records the traversal and delivers to the target. */
  const takeEdge = (
    edge: GraphEdge,
    output: string,
    sourceIteration: number,
    sourceRounds: readonly string[],
  ): TaskVerdict => {
    deps.appendEvent(runId, {
      type: "edge.taken",
      edgeId: edge.id,
      source: edge.source,
      target: edge.target,
      matchedCondition: describeEdgeCondition(edge),
      iteration: sourceIteration,
    });
    if (topology.guarded.has(edge.id)) {
      state.takenCounts.set(edge.id, (state.takenCounts.get(edge.id) ?? 0) + 1);
    }
    appendBreadcrumb(deps, runId, state, {
      kind: "edge",
      edgeId: edge.id,
      iteration: sourceIteration,
    });
    deps.log.info({ runId, edgeId: edge.id, target: edge.target }, "edge taken");

    // The source routed HERE: its other pending join-edges can never arrive.
    const unsatisfiable = markJoinEdges(edge.source, "missed", edge.id);
    if (unsatisfiable !== undefined) return failRun(unsatisfiable);

    const target = topology.nodesById.get(edge.target);
    if (target === undefined) {
      return failRun(`edge "${edge.id}" targets unknown node "${edge.target}"`);
    }
    if (target.type === "exit") {
      // Reaching an exit ends this branch successfully; the run finalizes
      // once every branch has settled.
      return { kind: "branch-done" };
    }
    if (target.type === "join") {
      return deliverToJoin(edge, sourceIteration, sourceRounds);
    }
    scheduleExec({
      nodeId: target.id,
      iteration: (state.execCount.get(target.id) ?? 0) + 1,
      prevOutput: output,
      prevSessionId: state.sessions.get(edge.source),
      restartSessionId: undefined,
      viaEdgeId: undefined,
      rounds: [...sourceRounds],
    });
    return { kind: "continue" };
  };

  /**
   * Advances out of a successfully completed node: a fan-out source starts
   * one parallel branch per always edge; a router/chain node evaluates its
   * conditional siblings in `order` (first match wins, `invert` negates),
   * applies the cycle guard and takes the winner or the `always` fallback;
   * with no outgoing edges at all the branch ends. Join nodes reach here
   * only through resume re-derivation (their live advance happens inside
   * `triggerJoin`): their single unconditional edge delivers like a chain.
   */
  const advance = (
    node: GraphNode,
    output: string,
    sourceIteration: number,
    sourceRounds: readonly string[],
  ): TaskVerdict => {
    const siblings = topology.outgoing.get(node.id) ?? [];
    const unconditional = siblings.filter(isUnconditional);
    const conditional = siblings
      .filter((edge) => !isUnconditional(edge))
      .sort((a, b) => (topology.order.get(a.id) ?? 0) - (topology.order.get(b.id) ?? 0));
    const fallback = unconditional.find(isUnconditional);

    // Fan-out (#115): every always edge starts a parallel branch. Fan-out
    // edges are never guarded and emit no edge.taken — the branches are
    // reported by the targets' node.queued events carrying the branch edgeId.
    if (unconditional.length >= 2) {
      // Fan-out lineage push (#115): every branch spawned by THIS source
      // execution carries the token `<source>#<exec>` appended to the
      // lineage — inner loops keep the lineage, and a later re-entry into
      // the fan-out source mints a fresh token for its branches.
      const branchLineage = [...sourceRounds, `${node.id}#${sourceIteration}`];
      for (const edge of unconditional) {
        const target = topology.nodesById.get(edge.target);
        if (target === undefined || !isExecutableGraphNode(target)) {
          return failRun(
            `fan-out edge "${edge.id}" targets ${target === undefined ? "unknown" : target.type} node "${edge.target}"`,
          );
        }
        scheduleExec({
          nodeId: target.id,
          iteration: (state.execCount.get(target.id) ?? 0) + 1,
          prevOutput: output,
          prevSessionId: state.sessions.get(node.id),
          restartSessionId: undefined,
          viaEdgeId: edge.id,
          rounds: [...branchLineage],
        });
      }
      deps.log.info(
        { runId, nodeId: node.id, branches: unconditional.length },
        "fan-out: parallel branches scheduled",
      );
      return { kind: "continue" };
    }

    const winner = conditional.find((edge) => {
      const match = evaluateExitCondition(evaluators.get(edge.id) as ExitEvaluator, output);
      return edge.invert === true ? !match : match;
    });

    if (winner !== undefined && topology.guarded.has(winner.id)) {
      const { max, clampedFrom } = effectiveMaxIterations(winner);
      const taken = state.takenCounts.get(winner.id) ?? 0;
      if (taken >= max) {
        deps.appendEvent(runId, {
          type: "edge.cap-reached",
          edgeId: winner.id,
          source: winner.source,
          target: winner.target,
          taken,
          maxIterations: max,
          detail:
            `condition ${describeEdgeCondition(winner)} matched after ${taken} traversal(s) of edge "${winner.id}"` +
            (clampedFrom === undefined
              ? ` but maxIterations is ${max}`
              : ` but maxIterations is ${max} (configured ${clampedFrom}, clamped to the hard cap ${MAX_EDGE_ITERATIONS})`),
        });
        if (fallback === undefined) {
          return failRun(
            `cycle guard reached on edge "${winner.id}" (${node.name} → ${winner.target}): the condition matched ${taken} time(s) ` +
              `but maxIterations is ${max}` +
              (clampedFrom === undefined
                ? ""
                : ` (configured ${clampedFrom}, clamped to the hard cap ${MAX_EDGE_ITERATIONS})`) +
              ` and node "${node.id}" has no always fallback edge to take instead`,
          );
        }
        deps.log.warn(
          { runId, edgeId: winner.id, taken, max },
          "edge cycle guard reached; taking always fallback",
        );
        return takeEdge(fallback, output, sourceIteration, sourceRounds);
      }
    }

    const edge = winner ?? fallback;
    if (edge === undefined) {
      // No outgoing edges (or none left): this branch ends here; the run
      // finalizes once every branch has settled.
      const unsatisfiable = markJoinEdges(node.id, "missed");
      if (unsatisfiable !== undefined) return failRun(unsatisfiable);
      return { kind: "branch-done" };
    }
    return takeEdge(edge, output, sourceIteration, sourceRounds);
  };

  /** Processes one settled node execution into a scheduler verdict. */
  const processCompletion = (ctx: ExecContext, outcome: NodeOutcome): TaskVerdict => {
    const { node } = ctx;
    const { iteration } = ctx.exec;

    if (outcome.status === "interrupted") {
      // Graceful shutdown suspended an approval gate (#118).
      return { kind: "interrupt" };
    }

    if (outcome.status === "aborted") {
      // Branch cancellation (fail-fast / any-trigger): already accounted for.
      if (ctx.cancelRequested) return { kind: "branch-done" };
      return { kind: "abort" };
    }

    if (outcome.status === "failed") {
      const attribution = `node "${node.name}" (${node.id}) failed: ${outcome.error ?? "unknown error"}`;
      const scope = topology.failureScope.get(node.id);
      const unsatisfiable = markJoinEdges(node.id, "failed");
      // Fail-fast (#115 default): runs without joins, mode-`all` scopes,
      // and serial prefixes of an `any` join (no sibling alternate path —
      // `tolerant` is false) all die immediately, siblings cancelled.
      if (scope === undefined || scope.mode === "all" || !scope.tolerant) {
        return failRun(attribution, outcome.output);
      }
      if (unsatisfiable !== undefined) {
        return failRun(`${attribution}; ${unsatisfiable}`);
      }
      // mode "any" on a parallel branch: tolerated while another incoming
      // branch can still arrive.
      deps.log.warn(
        { runId, nodeId: node.id, joinId: scope.joinId, iteration },
        "branch failure tolerated (join mode any)",
      );
      return { kind: "branch-done" };
    }

    // Success: record the output/session and advance.
    state.outputs.set(node.id, outcome.output);
    state.sessions.set(node.id, outcome.sessionId);
    // #107: scan the node's final output for listening ports (sandboxed
    // runs only; persists detectedPorts on the run row as it goes).
    deps.recordDetectedPorts(runId, outcome.output);

    // #118: a REJECTED approval gate fails the run — unless the node has
    // conditional outgoing edges, in which case routing owns the outcome
    // (e.g. `outputContains "rejected"` → a fix-up branch, `"approved"` →
    // the shipping branch; the node's output is `rejected: <note>`).
    if (outcome.approvalRejected !== undefined) {
      const branchable = (topology.outgoing.get(node.id) ?? []).some(
        (edge) => !isUnconditional(edge),
      );
      if (!branchable) {
        const note = outcome.approvalRejected.note;
        return failRun(
          `approval node "${node.name}" (${node.id}) rejected${note.length > 0 ? `: ${note}` : ""}`,
          outcome.output,
        );
      }
    }

    const verdict = advance(
      node,
      outcome.routingOutput ?? outcome.output,
      iteration,
      ctx.exec.rounds,
    );
    // A rejected gate with conditional branches that match NONE of them must
    // not dead-end into a false success (#118).
    if (outcome.approvalRejected !== undefined && verdict.kind === "branch-done") {
      return failRun(
        `approval node "${node.name}" (${node.id}) rejected and no outgoing branch matched`,
        outcome.output,
      );
    }
    // A superseded loser's output is never the run's final verdict text
    // (#115): the winner (or the join's downstream path) already decided it.
    if (verdict.kind !== "suppressed") state.runOutput = outcome.output;
    return verdict;
  };

  /** Runs one scheduled execution to its verdict (never rejects). */
  const runTask = async (ctx: ExecContext): Promise<TaskVerdict> => {
    state.totalExecutions += 1;
    try {
      const outcome = await runNode(
        deps,
        runId,
        worktreePath,
        ctx.node,
        ctx.exec,
        state,
        control,
        ctx,
        diffBase,
        depth,
        retrySeams,
      );
      return processCompletion(ctx, outcome);
    } catch (err) {
      // runNode never throws by contract; a crash here is an engine-level
      // failure: fail the run with attribution.
      return failRun(`node "${ctx.node.name}" (${ctx.node.id}) crashed: ${describeError(err)}`);
    }
  };

  const diffBase = { ref: "HEAD" };

  // Seed the ready queue: the entry node for fresh runs, the reconstructed
  // restart set (+ re-derived routing) for resumed ones. This happens
  // BEFORE firing an un-persisted join trigger so the trigger's sibling
  // cancellation can splice the reconstructed losing branches (an any-join
  // round that already triggered pre-crash needs its interrupted losers
  // settled `aborted`, not re-run — their deliveries would be stale).
  if (resumed === undefined) {
    const entry = topology.nodesById.get(graph.entryNodeId);
    if (entry === undefined || !isExecutableGraphNode(entry)) {
      deps.finalizeRun(runId, "failed", {
        error: `entry node "${graph.entryNodeId}" is not an executable (agent/subworkflow) node in the pinned graph revision`,
      });
      return;
    }
    scheduleExec({
      nodeId: entry.id,
      iteration: 1,
      prevOutput: "",
      prevSessionId: undefined,
      restartSessionId: undefined,
      viaEdgeId: undefined,
      rounds: ["root"],
    });
  } else {
    for (const exec of resumed.initial) scheduleExec(exec);
    // Routing that never persisted is re-driven through the REAL advance:
    // deterministic (same output, same conditions) and it re-emits exactly
    // the routing events that were lost.
    if (resumed.redrive !== undefined) {
      const node = topology.nodesById.get(resumed.redrive.nodeId);
      if (node === undefined || node.type === "exit") {
        deps.finalizeRun(runId, "failed", {
          error: `cannot re-drive routing from node "${resumed.redrive.nodeId}": not a known executable node`,
        });
        return;
      }
      const verdict = advance(
        node,
        resumed.redrive.output,
        resumed.redrive.iteration,
        resumed.redrive.rounds,
      );
      if (verdict.kind === "fail-run" && terminal === undefined) {
        terminal = verdict;
      } else if (verdict.kind === "abort" && terminal === undefined) {
        terminal = { kind: "abort" };
      }
    }
  }

  // A join trigger that never persisted (crash between the completing edge
  // entry and the join execution) fires once the restart set is seeded,
  // with the SAME sibling cancellation a live trigger applies.
  if (resumed !== undefined && resumed.pendingJoinTrigger !== undefined) {
    const follow = triggerJoin(
      resumed.pendingJoinTrigger,
      (scopeJoinId) => {
        cancelExecutions((nodeId) => topology.failureScope.get(nodeId)?.joinId === scopeJoinId);
      },
      resumed.pendingTriggerRounds ?? ["root"],
    );
    if (follow === undefined) {
      deps.finalizeRun(runId, "failed", {
        error: `join "${resumed.pendingJoinTrigger}" could not execute on resume`,
      });
      return;
    }
    for (const exec of follow) scheduleExec(exec);
  }

  /** Cancels everything still in flight and drains the verdicts. */
  const drain = async (): Promise<void> => {
    cancelExecutions(() => true);
    await Promise.allSettled([...contexts].map((ctx) => ctx.done));
  };

  try {
    while (terminal === undefined) {
      if (control.isAbortRequested()) {
        terminal = { kind: "abort" };
        break;
      }

      // Start as many ready executions as the inner concurrency cap allows.
      while (ready.length > 0 && contexts.size < innerConcurrency) {
        if (control.isAbortRequested() || terminal !== undefined) break;
        const exec = ready.shift();
        if (exec === undefined) break;
        const node = topology.nodesById.get(exec.nodeId);
        if (node === undefined || !isRunnableGraphNode(node)) {
          terminal = {
            kind: "fail-run",
            error: `node "${exec.nodeId}" does not exist as a runnable (agent/subworkflow/approval) node in the pinned graph revision`,
          };
          break;
        }
        if (state.totalExecutions >= MAX_TOTAL_NODE_EXECUTIONS) {
          terminal = {
            kind: "fail-run",
            error: `graph execution exceeded ${MAX_TOTAL_NODE_EXECUTIONS} node executions without terminating; aborting as a safety measure`,
          };
          break;
        }
        const ctx: ExecContext = {
          exec,
          node,
          handle: undefined,
          cancelRequested: false,
          cancelWait: undefined,
          done: Promise.resolve({ kind: "continue" }),
        };
        const task = runTask(ctx);
        ctx.done = task;
        contexts.add(ctx);
      }
      if (terminal !== undefined) break;

      if (contexts.size === 0) {
        if (ready.length > 0) continue; // abort arrived mid-start: re-check
        break; // frontier empty
      }

      // Wait for the first settlement, collect its verdict.
      const settled = await Promise.race(
        [...contexts].map((ctx) => ctx.done.then((verdict) => ({ ctx, verdict }))),
      );
      contexts.delete(settled.ctx);
      if (settled.verdict.kind === "abort" && terminal === undefined) {
        terminal = { kind: "abort" };
      } else if (settled.verdict.kind === "interrupt" && terminal === undefined) {
        terminal = { kind: "interrupt" };
      } else if (settled.verdict.kind === "fail-run" && terminal === undefined) {
        terminal = settled.verdict;
      }
    }

    if (terminal !== undefined) {
      // Cancel + drain every in-flight branch BEFORE the run turns terminal
      // (deterministic StepRun/event settlement).
      await drain();
      if (terminal.kind === "abort") {
        deps.abortRun(runId);
      } else if (terminal.kind === "interrupt") {
        deps.finalizeRun(runId, "interrupted", {});
      } else {
        deps.finalizeRun(runId, "failed", {
          error: terminal.error,
          ...(terminal.output === undefined || terminal.output.length === 0
            ? {}
            : { output: terminal.output }),
        });
      }
      return;
    }

    // Frontier empty. An engaged join that never triggered fails the run
    // with attribution (a join untouched by any delivery was fully bypassed
    // by the taken paths and stays silent).
    for (const [joinId, pending] of state.joinPending.entries()) {
      const join = topology.joins.get(joinId);
      if (join === undefined) continue;
      const states = [...pending.states.values()];
      const engaged = states.some((s) => s !== "waiting");
      if (!engaged) continue;
      const allArrived = states.every((s) => s === "arrived");
      if (allArrived) continue; // cannot happen (trigger resets), defensive
      deps.finalizeRun(runId, "failed", {
        error: describeUnsatisfiedJoin(topology, join, pending),
      });
      return;
    }

    deps.finalizeRun(runId, "success", { output: state.runOutput });
  } finally {
    control.onHandle?.(undefined);
  }
}
