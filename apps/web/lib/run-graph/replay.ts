import type {
  NodeExecutionStatus,
  NodeVisualStatus,
  RunGraphFoldState,
  TimelineFoldEntry,
} from "./fold";

/**
 * Replay scrubbing (#52): as-of views of the execution at one breadcrumb
 * position. The approximation is deliberately the one the issue specifies:
 *
 * - node entries BEFORE position k show their recorded status as-of that
 *   point (the execution that completed there — success, or failed/aborted
 *   when that execution ended so),
 * - the node AT position k renders as `running` (we scrub to the moment it
 *   was executing); when k is an edge entry, that edge animates and its
 *   target renders `queued` (the moment just before it starts),
 * - nodes never mentioned at-or-before k are `not-reached`.
 */

/** Per-node visual slice for one scrub position (absent = not-reached). */
export interface ReplayNodeState {
  status: NodeVisualStatus;
  /** Executions announced at-or-before k (the iteration badge). */
  executionCount: number;
}

/** Per-edge visual slice for one scrub position. */
export interface ReplayEdgeState {
  taken: boolean;
  /** True for the most recent traversal at-or-before k (marching dashes). */
  animated: boolean;
  takeCount: number;
}

export interface ReplayView {
  /** Breadcrumb position this view is anchored at. */
  position: number;
  nodes: Readonly<Record<string, ReplayNodeState>>;
  edges: Readonly<Record<string, ReplayEdgeState>>;
  /** The edge animating at this position, if any. */
  animatedEdgeId: string | null;
  /** The node rendered `running` at this position, if any. */
  focusNodeId: string | null;
}

/** Node statuses an execution may have completed with, scrub-safe. */
const completedStatus = (entry: TimelineFoldEntry): NodeExecutionStatus =>
  entry.status ?? "success";

/**
 * As-of view at breadcrumb position `k` (0-based). `null` when the run has
 * no breadcrumb or `k` is out of range.
 */ export function replayAsOf(state: RunGraphFoldState, position: number): ReplayView | null {
  const { breadcrumb } = state;
  if (position < 0 || position >= breadcrumb.length) return null;

  const nodes: Record<string, ReplayNodeState> = {};
  const edges: Record<string, ReplayEdgeState> = {};

  // Everything strictly before k is history.
  for (let index = 0; index < position; index += 1) {
    const entry = breadcrumb[index] as TimelineFoldEntry;
    if (entry.kind === "node") {
      nodes[entry.id] = {
        status: completedStatus(entry),
        executionCount: Math.max(nodes[entry.id]?.executionCount ?? 0, entry.iteration),
      };
    } else {
      edges[entry.id] = {
        taken: true,
        animated: false,
        takeCount: (edges[entry.id]?.takeCount ?? 0) + 1,
      };
    }
  }

  // The entry at k is "now".
  const at = breadcrumb[position] as TimelineFoldEntry;
  if (at.kind === "node") {
    nodes[at.id] = {
      status: "running",
      executionCount: Math.max(nodes[at.id]?.executionCount ?? 0, at.iteration),
    };
  } else {
    edges[at.id] = {
      taken: true,
      animated: true,
      takeCount: (edges[at.id]?.takeCount ?? 0) + 1,
    };
    // The edge's target is the node about to run next: it renders queued,
    // keeping the execution count it accumulated so far (loop re-entry).
    const target = state.edges[at.id]?.target;
    if (target !== undefined) {
      nodes[target] = {
        status: "queued",
        executionCount: nodes[target]?.executionCount ?? 0,
      };
    }
  }

  // The animated edge is the most recent traversal at-or-before k: the entry
  // at k when it is an edge, else the latest edge entry before it.
  let animatedEdgeId: string | null = at.kind === "edge" ? at.id : null;
  if (animatedEdgeId === null) {
    for (let index = position - 1; index >= 0; index -= 1) {
      const entry = breadcrumb[index] as TimelineFoldEntry;
      if (entry.kind === "edge") {
        animatedEdgeId = entry.id;
        break;
      }
    }
  }
  if (animatedEdgeId !== null) {
    const edge = edges[animatedEdgeId];
    if (edge !== undefined) edges[animatedEdgeId] = { ...edge, animated: true };
  }

  return {
    position,
    nodes,
    edges,
    animatedEdgeId,
    focusNodeId: at.kind === "node" ? at.id : null,
  };
}

/** Breadcrumb positions a run can scrub through (0..n-1). */
export function replayRange(state: RunGraphFoldState): { min: number; max: number } | null {
  if (state.breadcrumb.length === 0) return null;
  return { min: 0, max: state.breadcrumb.length - 1 };
}
