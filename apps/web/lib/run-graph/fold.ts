import type { RunStatus } from "@openeuler/core";
import { TERMINAL_RUN_STATUSES } from "@openeuler/core";
import type { RunStreamEvent } from "@/lib/run-events";

/**
 * Event → execution-state fold for the live graph view (#52).
 *
 * Pure, deterministic and idempotent over the ordered event sequence of a
 * run: SSE replay (#12 Last-Event-ID) re-delivers the same events, so
 * `fold(live events)` and `fold(replayed events)` must produce the exact
 * same state. That holds because the fold
 *
 * - only consumes engine events (`node.*`, `edge.*`, `step.*`,
 *   `run.status`) in `seq` order, skipping anything at or below the last
 *   folded seq (overlapping resends after a reconnect dedupe themselves),
 * - keeps per-node/per-edge sub-state objects referentially stable while
 *   nothing about that node/edge changed (React Flow node memoization).
 *
 * Legacy linear runs fold the same way off `step.started`/`step.completed`
 * (their `stepId`s are the node ids `linearToGraph` reuses), so the graph
 * view, timeline and replay work for them too.
 */

/** Visual state of one node, derived from its latest event. */
export type NodeVisualStatus =
  "not-reached" | "queued" | "running" | "success" | "failed" | "aborted" | "interrupted";

/** Statuses a node execution itself reports (event order decides "latest"). */
export type NodeExecutionStatus = "queued" | "running" | RunStatus;

/** One execution of a node (a loop re-entry appends another). */
export interface NodeExecutionInfo {
  iteration: number;
  status: NodeExecutionStatus;
  /** Final output (set on completion). */
  output?: string;
  durationMs?: number;
  error?: string;
  /**
   * The fan-out branch edge this execution runs on (#115), when the engine
   * reported one — the parallel-branch marker in the drawer/timeline.
   */
  edgeId?: string;
  /**
   * The child run this sub-workflow execution spawned (#117), when the
   * engine reported one — the parent↔child link in the node drawer.
   */
  childRunId?: string;
}

/** Folded state of one node. Referentially stable while the node is idle. */
export interface NodeFoldState {
  status: NodeVisualStatus;
  /** Executions ascending by iteration (only announced ones). */
  executions: readonly NodeExecutionInfo[];
  /** Highest announced execution number (drives the iteration badge). */
  executionCount: number;
}

/** Folded state of one edge. Referentially stable while untaken. */
export interface EdgeFoldState {
  source: string;
  target: string;
  takeCount: number;
  lastTakenSeq: number;
  /** Condition text of the latest traversal (timeline detail). */
  lastMatchedCondition?: string;
  /** Set when the cycle guard blocked a matching traversal. */
  cap: { taken: number; maxIterations: number; detail?: string } | null;
}

/** Kind of one timeline row. */
export type TimelineKind = "node" | "edge" | "cap";

/** One execution-history row (breadcrumb order + cap warnings interleaved). */
export interface TimelineFoldEntry {
  kind: TimelineKind;
  /** 0-based breadcrumb position; cap rows repeat the position they follow. */
  position: number;
  seq: number;
  /** nodeId (node) or edgeId (edge/cap). */
  id: string;
  name: string;
  /** 1-based execution number of the node (node/edge) — source's for edges. */
  iteration: number;
  /** Node execution duration (node rows, once completed). */
  durationMs?: number;
  status?: RunStatus;
  detail?: string;
}

/** The whole folded execution state of a run. */
export interface RunGraphFoldState {
  lastSeq: number;
  runStatus: RunStatus | null;
  nodes: Readonly<Record<string, NodeFoldState>>;
  edges: Readonly<Record<string, EdgeFoldState>>;
  /** Completed node executions + taken edges, in order (#45 breadcrumb). */
  breadcrumb: readonly TimelineFoldEntry[];
  /** Breadcrumb + interleaved `edge.cap-reached` warnings. */
  timeline: readonly TimelineFoldEntry[];
  lastTakenEdgeId: string | null;
  /** Total node executions announced (header "iterations" chip). */
  totalExecutions: number;
}

export const EMPTY_RUN_GRAPH_STATE: RunGraphFoldState = {
  lastSeq: -1,
  runStatus: null,
  nodes: {},
  edges: {},
  breadcrumb: [],
  timeline: [],
  lastTakenEdgeId: null,
  totalExecutions: 0,
};

/** True for statuses a run never leaves. */
const isTerminalRunStatus = (status: RunStatus): boolean =>
  (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

/** Upserts one execution row, preserving order + row identity when unchanged. */
function patchExecution(
  executions: readonly NodeExecutionInfo[],
  patch: { iteration: number } & Partial<NodeExecutionInfo>,
): readonly NodeExecutionInfo[] {
  const index = executions.findIndex((row) => row.iteration === patch.iteration);
  if (index === -1) {
    return [...executions, { status: "queued", ...patch }];
  }
  const current = executions[index] as NodeExecutionInfo;
  const next: NodeExecutionInfo = { ...current, ...patch };
  if (
    next.status === current.status &&
    next.output === current.output &&
    next.durationMs === current.durationMs &&
    next.error === current.error &&
    next.edgeId === current.edgeId &&
    next.childRunId === current.childRunId
  ) {
    return executions;
  }
  const copy = [...executions];
  copy[index] = next;
  return copy;
}

interface NodeFoldPatch {
  status?: NodeVisualStatus;
  execution?: { iteration: number } & Partial<NodeExecutionInfo>;
}

/** Applies a node patch, keeping the sub-object identity when nothing moved. */
function patchNode(
  nodes: Readonly<Record<string, NodeFoldState>>,
  nodeId: string,
  patch: NodeFoldPatch,
): Readonly<Record<string, NodeFoldState>> {
  const current = nodes[nodeId];
  if (current === undefined) {
    const executions: readonly NodeExecutionInfo[] =
      patch.execution === undefined ? [] : patchExecution([], patch.execution);
    return {
      ...nodes,
      [nodeId]: {
        status: patch.status ?? "queued",
        executions,
        executionCount: patch.execution?.iteration ?? 0,
      },
    };
  }
  const executions =
    patch.execution === undefined
      ? current.executions
      : patchExecution(current.executions, patch.execution);
  const executionCount = patch.execution
    ? Math.max(current.executionCount, patch.execution.iteration)
    : current.executionCount;
  const status = patch.status ?? current.status;
  if (
    executions === current.executions &&
    executionCount === current.executionCount &&
    status === current.status
  ) {
    return nodes;
  }
  return { ...nodes, [nodeId]: { status, executions, executionCount } };
}

/** Settles live nodes when the run itself ends (interrupted/aborted sweep). */
function settleNodes(
  nodes: Readonly<Record<string, NodeFoldState>>,
  status: RunStatus,
): Readonly<Record<string, NodeFoldState>> {
  let changed = false;
  const next: Record<string, NodeFoldState> = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (node.status === "queued" || node.status === "running") {
      next[id] = { ...node, status };
      changed = true;
    } else {
      next[id] = node;
    }
    const liveExecution = next[id].executions.find(
      (exec) => exec.status === "queued" || exec.status === "running",
    );
    if (liveExecution) {
      next[id] = {
        ...next[id],
        executions: next[id].executions.map((exec) =>
          exec.status === "queued" || exec.status === "running" ? { ...exec, status } : exec,
        ),
      };
      changed = true;
    }
  }
  return changed ? next : nodes;
}

/**
 * Folds ONE stream event into the state. Driver events (messages, tools, …)
 * only advance the seq cursor; events already covered by the cursor (SSE
 * replay overlap) return the state unchanged.
 */
export function foldRunGraphEvent(
  state: RunGraphFoldState,
  event: RunStreamEvent,
): RunGraphFoldState {
  if (event.seq <= state.lastSeq) return state;

  switch (event.type) {
    case "node.queued":
    case "node.started":
    case "node.completed": {
      const { nodeId, nodeName, iteration } = event;
      const execution =
        event.type === "node.queued"
          ? { iteration, status: "queued" as const }
          : event.type === "node.started"
            ? { iteration, status: "running" as const }
            : {
                iteration,
                status: event.status,
                output: event.output,
                durationMs: event.durationMs,
                ...(event.error === undefined ? {} : { error: event.error }),
              };
      // #115: fan-out branch executions carry their branch edge id; #117:
      // sub-workflow completions carry the child run id they spawned.
      const withEdge =
        "edgeId" in event && event.edgeId !== undefined
          ? { ...execution, edgeId: event.edgeId }
          : execution;
      const withExtras =
        event.type === "node.completed" && "childRunId" in event && event.childRunId !== undefined
          ? { ...withEdge, childRunId: event.childRunId }
          : withEdge;
      const nodes = patchNode(state.nodes, nodeId, {
        status:
          event.type === "node.queued"
            ? "queued"
            : event.type === "node.started"
              ? "running"
              : event.status,
        execution: withExtras,
      });
      let next: RunGraphFoldState = { ...state, lastSeq: event.seq };
      if (nodes !== state.nodes) next = { ...next, nodes };
      if (event.type === "node.completed") {
        const entry: TimelineFoldEntry = {
          kind: "node",
          position: state.breadcrumb.length,
          seq: event.seq,
          id: nodeId,
          name: nodeName,
          iteration,
          durationMs: event.durationMs,
          status: event.status,
        };
        next = {
          ...next,
          breadcrumb: [...state.breadcrumb, entry],
          timeline: [...state.timeline, entry],
        };
      }
      // Total executions counts every newly announced (nodeId, iteration).
      const known = (state.nodes[nodeId]?.executions ?? []).some(
        (row) => row.iteration === iteration,
      );
      if (!known) next = { ...next, totalExecutions: state.totalExecutions + 1 };
      return next;
    }

    // Legacy linear runs: same fold, minus outputs/durations (StepRun rows
    // fill those in the node drawer).
    case "step.started":
    case "step.completed": {
      const { stepId, stepName, iteration } = event;
      const execution =
        event.type === "step.started"
          ? { iteration, status: "running" as const }
          : { iteration, status: event.status };
      const nodes = patchNode(state.nodes, stepId, {
        status: event.type === "step.started" ? "running" : event.status,
        execution,
      });
      let next: RunGraphFoldState = { ...state, lastSeq: event.seq };
      if (nodes !== state.nodes) next = { ...next, nodes };
      if (event.type === "step.completed") {
        const entry: TimelineFoldEntry = {
          kind: "node",
          position: state.breadcrumb.length,
          seq: event.seq,
          id: stepId,
          name: stepName,
          iteration,
          status: event.status,
        };
        next = {
          ...next,
          breadcrumb: [...state.breadcrumb, entry],
          timeline: [...state.timeline, entry],
        };
      }
      const known = (state.nodes[stepId]?.executions ?? []).some(
        (row) => row.iteration === iteration,
      );
      if (!known) next = { ...next, totalExecutions: state.totalExecutions + 1 };
      return next;
    }

    case "edge.taken": {
      const existing = state.edges[event.edgeId];
      const edges: Record<string, EdgeFoldState> = {
        ...state.edges,
        [event.edgeId]: {
          source: event.source,
          target: event.target,
          takeCount: (existing?.takeCount ?? 0) + 1,
          lastTakenSeq: event.seq,
          lastMatchedCondition: event.matchedCondition,
          cap: existing?.cap ?? null,
        },
      };
      const entry: TimelineFoldEntry = {
        kind: "edge",
        position: state.breadcrumb.length,
        seq: event.seq,
        id: event.edgeId,
        name: `${event.source} → ${event.target}`,
        iteration: event.iteration,
        detail: event.matchedCondition,
      };
      return {
        ...state,
        lastSeq: event.seq,
        edges,
        breadcrumb: [...state.breadcrumb, entry],
        timeline: [...state.timeline, entry],
        lastTakenEdgeId: event.edgeId,
      };
    }

    case "edge.cap-reached": {
      const existing = state.edges[event.edgeId];
      const edges: Record<string, EdgeFoldState> = {
        ...state.edges,
        [event.edgeId]: {
          source: event.source,
          target: event.target,
          takeCount: existing?.takeCount ?? 0,
          lastTakenSeq: existing?.lastTakenSeq ?? -1,
          ...(existing?.lastMatchedCondition === undefined
            ? {}
            : { lastMatchedCondition: existing.lastMatchedCondition }),
          cap: {
            taken: event.taken,
            maxIterations: event.maxIterations,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
          },
        },
      };
      const warning: TimelineFoldEntry = {
        kind: "cap",
        position: state.breadcrumb.length,
        seq: event.seq,
        id: event.edgeId,
        name: `${event.source} → ${event.target}`,
        iteration: 0,
        detail:
          event.detail ??
          `condition matched but the edge already reached maxIterations ${event.maxIterations}`,
      };
      return { ...state, lastSeq: event.seq, edges, timeline: [...state.timeline, warning] };
    }

    case "run.status": {
      const nodes = isTerminalRunStatus(event.status)
        ? settleNodes(state.nodes, event.status)
        : state.nodes;
      return nodes === state.nodes && state.runStatus === event.status
        ? { ...state, lastSeq: event.seq }
        : { ...state, lastSeq: event.seq, runStatus: event.status, nodes };
    }

    default:
      return { ...state, lastSeq: event.seq };
  }
}

/** Folds a batch of events in order (bulk replay / throttled live batch). */
export function foldRunGraphEvents(
  state: RunGraphFoldState,
  events: readonly RunStreamEvent[],
): RunGraphFoldState {
  return events.reduce<RunGraphFoldState>((acc, event) => foldRunGraphEvent(acc, event), state);
}

/** Folds a whole event sequence from scratch (replay / tests). */
export function buildRunGraphState(events: readonly RunStreamEvent[]): RunGraphFoldState {
  return foldRunGraphEvents(EMPTY_RUN_GRAPH_STATE, events);
}
