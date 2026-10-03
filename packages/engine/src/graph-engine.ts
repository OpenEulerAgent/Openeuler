import { DEFAULT_EDGE_MAX_ITERATIONS, renderPromptTemplate } from "@openeuler/core";
import type {
  AgentGraphNode,
  BreadcrumbEntry,
  GraphEdge,
  GraphNode,
  Run,
  RunStatus,
  StepRun,
  WorkflowGraph,
} from "@openeuler/core";
import type { Db, EventInput } from "@openeuler/db";
import type { PersistedEvent } from "@openeuler/core";
import type { AgentDriver, DriverRegistry } from "@openeuler/drivers";
import {
  compileExitCondition,
  describeCondition,
  evaluateExitCondition,
  type ExitEvaluator,
} from "./conditions.js";
import type { RunControl, RunSandboxContext } from "./flow-engine.js";
import type { WorktreeManager } from "./worktree.js";

/**
 * Serial DAG graph execution engine (#45).
 *
 * ## Execution semantics (v0.1 — SERIAL)
 *
 * Execution starts at `entryNodeId` and follows exactly ONE outgoing edge per
 * node completion: drawing multiple conditional edges from a node models
 * if/else-style paths, NOT concurrency (parallel fan-out with join/merge is
 * explicitly v0.2). On node completion the engine evaluates the node's
 * conditional outgoing edges in `order` (first match wins; `invert` negates
 * the match result) against the node's FINAL output. The first matching edge
 * is taken; when none matches, the node's single `always` fallback edge is
 * taken; with no outgoing edges at all — or an `exit` node reached — the run
 * ends `success`.
 *
 * ## Iteration semantics
 *
 * Each node EXECUTION counts: a node re-entered by a conditional back-edge
 * runs as execution 1, 2, 3, … (per node, not global), and that number is
 * what the node's StepRun row, its `node.*` events and the `{{iterations}}`
 * template variable carry. `{{prevOutput}}` is the output of the node that
 * routed INTO the current execution (the taken edge's source); a node's own
 * `{{output:<nodeId>}}` reference resolves to that node's MOST RECENT
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
 * Unconditional (`always`) edges are never guarded, and non-back-edge
 * conditional edges cannot cycle so they need no guard.
 *
 * ## Events
 *
 * Graph runs emit `node.queued` / `node.started` / `node.completed` /
 * `edge.taken` / `edge.cap-reached` INSTEAD of the legacy `step.*` /
 * `loop.iteration` events (cleaner for the live graph view, #52), plus the
 * usual `run.status` transitions and the streamed driver events. Replaying
 * `node.completed` + `edge.taken` reconstructs the persisted run breadcrumb
 * exactly.
 *
 * ## Breadcrumb
 *
 * The run row carries an ordered `breadcrumb` (JSON column): one
 * `{kind: "node", nodeId, iteration}` entry per completed node execution
 * and one `{kind: "edge", edgeId, iteration}` entry per taken edge
 * (`iteration` = the source node's execution number). It is appended
 * synchronously as execution proceeds and powers replay in #52; together
 * with the StepRun rows it also reconstructs the resume position (#19).
 */

/** Hard ceiling on how often one guarded edge may be taken, regardless of configuration. */
export const MAX_EDGE_ITERATIONS = 25;

/** Defensive bound on total node executions per run (bug guard, not configurable). */
const MAX_TOTAL_NODE_EXECUTIONS = 5_000;

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Whether an edge is unconditional — an always edge that is not inverted. */
const isUnconditional = (edge: GraphEdge): boolean =>
  edge.condition.type === "always" && edge.invert !== true;

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
}

/** Terminal outcome of one node execution. */
interface NodeOutcome {
  status: RunStatus;
  output: string;
  error: string | undefined;
  /** Session this execution ran in (announced, restarted or inherited). */
  sessionId: string | undefined;
}

/** Where execution continues: run a node, or route out of a completed one. */
type Cursor =
  | {
      kind: "execute";
      nodeId: string;
      /** This execution's 1-based number (per-node). */
      iteration: number;
      /** Output of the node that routed into this execution ("" at the entry). */
      prevOutput: string;
      /** Session of the routing source node, for `continueSession` chaining. */
      prevSessionId: string | undefined;
      /** SessionId recorded on an interrupted StepRun to restart into. */
      restartSessionId: string | undefined;
    }
  | {
      kind: "route";
      nodeId: string;
      output: string;
      /** Execution number of the source node whose output routes. */
      sourceIteration: number;
    };

/** Mutable per-run graph execution state. */
interface GraphRunState {
  /** Node id → its most recent completed output (`{{output:<id>}}` source). */
  outputs: Map<string, string>;
  /** Node id → its most recent effective session (routing-source chaining). */
  sessions: Map<string, string | undefined>;
  /** Node id → highest started execution number (1-based, per-node). */
  execCount: Map<string, number>;
  /** Guarded edge id → times taken so far. */
  takenCounts: Map<string, number>;
  /** Ordered breadcrumb, mirrored onto the run row on every append. */
  breadcrumb: BreadcrumbEntry[];
  /** Output of the last successfully completed agent node (final run output). */
  runOutput: string;
  /** Total node executions started (defensive termination bound). */
  totalExecutions: number;
  /** The run's task description (`{{task}}`). */
  task: string;
}

/** Outgoing-edge lookup + guard classification, precomputed per run. */
interface GraphTopology {
  nodesById: Map<string, GraphNode>;
  /** edge id → edge. */
  edgesById: Map<string, GraphEdge>;
  /** node id → outgoing edges, in edges-array order. */
  outgoing: Map<string, GraphEdge[]>;
  /** edge id → effective router order among its node's conditional siblings. */
  order: Map<string, number>;
  /** Conditional back-edges (target reaches source) that carry a cycle guard. */
  guarded: Set<string>;
}

function buildTopology(graph: WorkflowGraph): GraphTopology {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const bucket = outgoing.get(edge.source);
    if (bucket === undefined) outgoing.set(edge.source, [edge]);
    else bucket.push(edge);
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
  return { nodesById, edgesById, outgoing, order, guarded };
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

/**
 * Reconstructs the graph execution state + resume cursor from the recorded
 * StepRun rows and the persisted breadcrumb:
 *
 * - a non-terminal StepRun (queued/running/interrupted) is the restart point:
 *   the node re-runs as its recorded execution number, restarting in its own
 *   recorded session;
 * - else the last breadcrumb entry decides: an `edge` entry means the next
 *   node is its target (the edge was already taken — it is NOT re-emitted);
 *   a `node` entry means routing out of it never persisted, so it is
 *   re-derived (deterministic: same output, same conditions);
 * - runs executed by the pre-#45 shim (rows but no breadcrumb) get a
 *   fallback breadcrumb replayed from the rows (iteration-major order,
 *   per-node renumbering) — correct for the chain+loop shapes the shim ran.
 *
 * Returns undefined for runs that never started a node (fresh execution).
 */
function reconstructGraphResume(
  deps: GraphEngineDeps,
  run: Run,
  topology: GraphTopology,
): { state: GraphRunState; cursor: Cursor | undefined } | undefined {
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
    breadcrumb: entries,
    runOutput: "",
    totalExecutions: 0,
    task: run.task ?? "",
  };
  const rowsByKey = new Map(rows.map((row) => [`${row.stepId}#${row.iteration}`, row]));
  for (const entry of entries) {
    if (entry.kind === "node") {
      state.execCount.set(
        entry.nodeId,
        Math.max(state.execCount.get(entry.nodeId) ?? 0, entry.iteration),
      );
      const row = rowsByKey.get(`${entry.nodeId}#${entry.iteration}`);
      if (row !== undefined && row.status === "success") {
        state.outputs.set(entry.nodeId, row.output);
        state.sessions.set(entry.nodeId, row.sessionId);
        state.runOutput = row.output;
      }
    } else {
      state.takenCounts.set(entry.edgeId, (state.takenCounts.get(entry.edgeId) ?? 0) + 1);
    }
  }

  // Restart point: the latest non-terminal StepRun, if any.
  const pending = rows
    .filter(
      (row) => row.status === "queued" || row.status === "running" || row.status === "interrupted",
    )
    .sort((a, b) => b.iteration - a.iteration)[0];
  if (pending !== undefined) {
    state.execCount.set(
      pending.stepId,
      Math.max(state.execCount.get(pending.stepId) ?? 0, pending.iteration),
    );
    // Routing context = the last traversal into this execution.
    const lastEdgeEntry = [...entries].reverse().find((entry) => entry.kind === "edge");
    const lastNodeEntry = [...entries].reverse().find((entry) => entry.kind === "node");
    const lastEdge =
      lastEdgeEntry !== undefined && lastEdgeEntry.kind === "edge"
        ? topology.edgesById.get(lastEdgeEntry.edgeId)
        : undefined;
    const prevSource =
      lastEdge !== undefined
        ? lastEdge.source
        : lastNodeEntry !== undefined && lastNodeEntry.kind === "node"
          ? lastNodeEntry.nodeId
          : undefined;
    return {
      state,
      cursor: {
        kind: "execute",
        nodeId: pending.stepId,
        iteration: pending.iteration,
        prevOutput: prevSource === undefined ? "" : (state.outputs.get(prevSource) ?? ""),
        prevSessionId: prevSource === undefined ? undefined : state.sessions.get(prevSource),
        restartSessionId: pending.sessionId,
      },
    };
  }

  const last = entries[entries.length - 1];
  if (last === undefined) return undefined;
  if (last.kind === "edge") {
    const edge = topology.edgesById.get(last.edgeId);
    const target = edge === undefined ? undefined : topology.nodesById.get(edge.target);
    if (edge === undefined || target === undefined || target.type === "exit") {
      // The traversal was persisted but the success finalize was not: finish.
      deps.finalizeRun(run.id, "success", { output: state.runOutput });
      return { state, cursor: undefined };
    }
    return {
      state,
      cursor: {
        kind: "execute",
        nodeId: target.id,
        iteration: (state.execCount.get(target.id) ?? 0) + 1,
        prevOutput: state.outputs.get(edge.source) ?? "",
        prevSessionId: state.sessions.get(edge.source),
        restartSessionId: undefined,
      } satisfies Cursor,
    };
  }
  // Routing never persisted: re-derive it from the recorded output.
  return {
    state,
    cursor: {
      kind: "route",
      nodeId: last.nodeId,
      output: state.outputs.get(last.nodeId) ?? "",
      sourceIteration: last.iteration,
    },
  };
}

/**
 * Executes one node execution: StepRun lifecycle (reuse/restart aware),
 * `node.*` events, prompt rendering against the graph variable map, driver
 * invocation, streamed-event persistence, per-step diff, session recording.
 * Never throws — failures land in the returned outcome.
 */
async function runNode(
  deps: GraphEngineDeps,
  runId: string,
  worktreePath: string,
  node: AgentGraphNode,
  cursor: Extract<Cursor, { kind: "execute" }>,
  state: GraphRunState,
  control: RunControl,
  diffBase: { ref: string },
): Promise<NodeOutcome> {
  const { iteration } = cursor;
  deps.appendEvent(runId, {
    type: "node.queued",
    nodeId: node.id,
    nodeName: node.name,
    iteration,
  });
  const stepRun = deps.beginStepRun(runId, { stepId: node.id }, iteration);
  const currentRow = deps.db.runs.get(runId);
  if (currentRow !== undefined && currentRow.iteration !== iteration - 1) {
    deps.db.runs.update(runId, { iteration: iteration - 1 });
  }
  const startedAtMs = Date.now();
  deps.appendEvent(runId, {
    type: "node.started",
    nodeId: node.id,
    nodeName: node.name,
    iteration,
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
      prevOutput: cursor.prevOutput,
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
            ?.sessionId ?? cursor.prevSessionId)
        : cursor.prevSessionId;
  }
  const sessionId = cursor.restartSessionId ?? inherited;
  // Project secrets (#93): decrypted env merged into the driver process.
  const secretEnv = deps.runSecretsEnv(runId);
  // Sandboxed runs (#102): driver cwd becomes the CONTAINER workspace and
  // the command runs through the sandbox exec seam.
  const sandbox = deps.runSandbox(runId);
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
  control.onHandle?.(handle);

  let lastErrorMessage: string | undefined;
  let sessionFromEvents: string | undefined;
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

  const exit = await handle.exited;
  control.onHandle?.(undefined);
  const diff = await deps.captureDiff(runId, worktreePath, diffBase);

  let status: RunStatus;
  let error: string | undefined;
  if (exit.reason === "exit" && exit.code === 0) {
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

  const effectiveSessionId = sessionFromEvents ?? cursor.restartSessionId ?? inherited;
  deps.db.stepRuns.update(stepRun.id, {
    status,
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
    ...(error === undefined ? {} : { error: deps.redactText(runId, error) }),
  });
  appendBreadcrumb(deps, runId, state, { kind: "node", nodeId: node.id, iteration });
  deps.log.info({ runId, nodeId: node.id, iteration, status }, "node finished");

  return { status, output: exit.output, error, sessionId: effectiveSessionId };
}

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
 * Routes out of a completed node: evaluates the conditional siblings in
 * `order` (first match wins, `invert` negates), applies the cycle guard,
 * emits `edge.taken` / `edge.cap-reached`, appends the breadcrumb and
 * returns the next cursor — or undefined when the run settled here
 * (success, cap failure).
 */
function routeFromNode(
  deps: GraphEngineDeps,
  runId: string,
  topology: GraphTopology,
  evaluators: Map<string, ExitEvaluator>,
  state: GraphRunState,
  source: AgentGraphNode,
  output: string,
  sourceIteration: number,
): Cursor | undefined {
  const siblings = topology.outgoing.get(source.id) ?? [];
  const conditional = siblings
    .filter((edge) => !isUnconditional(edge))
    .sort((a, b) => (topology.order.get(a.id) ?? 0) - (topology.order.get(b.id) ?? 0));
  const fallback = siblings.find(isUnconditional);

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
        deps.finalizeRun(runId, "failed", {
          error:
            `cycle guard reached on edge "${winner.id}" (${source.name} → ${winner.target}): the condition matched ${taken} time(s) ` +
            `but maxIterations is ${max}` +
            (clampedFrom === undefined
              ? ""
              : ` (configured ${clampedFrom}, clamped to the hard cap ${MAX_EDGE_ITERATIONS})`) +
            ` and node "${source.id}" has no always fallback edge to take instead`,
        });
        return undefined;
      }
      deps.log.warn(
        { runId, edgeId: winner.id, taken, max },
        "edge cycle guard reached; taking always fallback",
      );
      return takeEdge(deps, runId, topology, state, fallback, output, sourceIteration, source);
    }
  }

  const edge = winner ?? fallback;
  if (edge === undefined) {
    // No outgoing edges (or none left): terminal, the run succeeds here.
    deps.finalizeRun(runId, "success", { output: state.runOutput });
    return undefined;
  }
  return takeEdge(deps, runId, topology, state, edge, output, sourceIteration, source);
}

/** Emits `edge.taken`, records the traversal and builds the next cursor. */
function takeEdge(
  deps: GraphEngineDeps,
  runId: string,
  topology: GraphTopology,
  state: GraphRunState,
  edge: GraphEdge,
  output: string,
  sourceIteration: number,
  source: AgentGraphNode,
): Cursor | undefined {
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

  const target = topology.nodesById.get(edge.target);
  if (target === undefined) {
    deps.finalizeRun(runId, "failed", {
      error: `edge "${edge.id}" targets unknown node "${edge.target}"`,
    });
    return undefined;
  }
  if (target.type === "exit") {
    deps.finalizeRun(runId, "success", { output: state.runOutput });
    return undefined;
  }
  return {
    kind: "execute",
    nodeId: target.id,
    iteration: (state.execCount.get(target.id) ?? 0) + 1,
    prevOutput: output,
    prevSessionId: state.sessions.get(source.id),
    restartSessionId: undefined,
  };
}

/**
 * Drives a graph-revision run to a terminal state. Called by the flow
 * engine's `executeRun` once the run row, worktree and abort guards are in
 * place; never throws (failures funnel into the run row through
 * `deps.finalizeRun`, and the flow engine's outer catch is the last resort).
 */
export async function executeGraphRun(
  deps: GraphEngineDeps,
  run: Run,
  graph: WorkflowGraph,
  worktreePath: string,
  control: RunControl,
): Promise<void> {
  const runId = run.id;
  const topology = buildTopology(graph);

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

  const resumed = reconstructGraphResume(deps, run, topology);
  const state: GraphRunState = resumed?.state ?? {
    outputs: new Map(),
    sessions: new Map(),
    execCount: new Map(),
    takenCounts: new Map(),
    breadcrumb: [],
    runOutput: "",
    totalExecutions: 0,
    task: run.task ?? "",
  };
  let cursor: Cursor | undefined = resumed?.cursor ?? {
    kind: "execute",
    nodeId: graph.entryNodeId,
    iteration: 1,
    prevOutput: "",
    prevSessionId: undefined,
    restartSessionId: undefined,
  };
  if (cursor === undefined) return; // Resume settled the run (already finalized).

  const diffBase = { ref: "HEAD" };

  while (cursor !== undefined) {
    if (cursor.kind === "route") {
      const node = topology.nodesById.get(cursor.nodeId);
      if (node === undefined || node.type !== "agent") {
        deps.finalizeRun(runId, "failed", {
          error: `cannot route from node "${cursor.nodeId}": not a known agent node`,
        });
        return;
      }
      cursor = routeFromNode(
        deps,
        runId,
        topology,
        evaluators,
        state,
        node,
        cursor.output,
        cursor.sourceIteration,
      );
      continue;
    }

    if (control.isAbortRequested()) {
      deps.abortRun(runId);
      return;
    }
    if (state.totalExecutions >= MAX_TOTAL_NODE_EXECUTIONS) {
      deps.finalizeRun(runId, "failed", {
        error: `graph execution exceeded ${MAX_TOTAL_NODE_EXECUTIONS} node executions without terminating; aborting as a safety measure`,
      });
      return;
    }

    const node = topology.nodesById.get(cursor.nodeId);
    if (node === undefined) {
      deps.finalizeRun(runId, "failed", {
        error: `node "${cursor.nodeId}" does not exist in the pinned graph revision`,
      });
      return;
    }
    if (node.type === "exit") {
      // Exit nodes never execute; reaching one ends the run successfully.
      deps.finalizeRun(runId, "success", { output: state.runOutput });
      return;
    }

    state.execCount.set(node.id, Math.max(state.execCount.get(node.id) ?? 0, cursor.iteration));
    state.totalExecutions += 1;
    const outcome = await runNode(
      deps,
      runId,
      worktreePath,
      node,
      cursor,
      state,
      control,
      diffBase,
    );

    if (outcome.status !== "success") {
      const error =
        outcome.error === undefined
          ? undefined
          : outcome.status === "failed"
            ? `node "${node.name}" (${node.id}) failed: ${outcome.error}`
            : outcome.error;
      deps.finalizeRun(runId, outcome.status, {
        output: outcome.output,
        ...(error === undefined ? {} : { error }),
      });
      return;
    }

    state.outputs.set(node.id, outcome.output);
    state.sessions.set(node.id, outcome.sessionId);
    state.runOutput = outcome.output;
    // #107: scan the node's final output for listening ports (sandboxed
    // runs only; persists detectedPorts on the run row as it goes).
    deps.recordDetectedPorts(runId, outcome.output);
    cursor = {
      kind: "route",
      nodeId: node.id,
      output: outcome.output,
      sourceIteration: cursor.iteration,
    };
  }
}
