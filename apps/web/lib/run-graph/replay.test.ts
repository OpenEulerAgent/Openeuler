import { describe, expect, it } from "vitest";
import type { RunStreamEvent } from "@/lib/run-events";
import { buildRunGraphState } from "./fold";
import { replayAsOf, replayRange } from "./replay";

// Event fixtures (same shapes the engine emits; seqs assigned in order).
let nextSeq = 0;
const seq = (): number => nextSeq++;

const node = (
  nodeId: string,
  iteration: number,
  status: "success" | "failed" = "success",
): RunStreamEvent[] => [
  { type: "node.queued", seq: seq(), nodeId, nodeName: nodeId, iteration },
  { type: "node.started", seq: seq(), nodeId, nodeName: nodeId, iteration },
  {
    type: "node.completed",
    seq: seq(),
    nodeId,
    nodeName: nodeId,
    iteration,
    status,
    output: `out:${nodeId}:${iteration}`,
    durationMs: 10,
  },
];

const edge = (
  edgeId: string,
  source: string,
  target: string,
  iteration: number,
): RunStreamEvent => ({
  type: "edge.taken",
  seq: seq(),
  edgeId,
  source,
  target,
  matchedCondition: "always",
  iteration,
});

/**
 * Multi-iteration loop run: a → b → (loop b) → b → exit.
 * Breadcrumb: [a#1, e-a-b, b#1, e-loop, b#2, e-exit]
 */
function loopRun(): RunStreamEvent[] {
  return [
    { type: "run.status", seq: seq(), status: "running" },
    ...node("a", 1),
    edge("e-a-b", "a", "b", 1),
    ...node("b", 1),
    edge("e-loop-b", "b", "b", 1),
    ...node("b", 2),
    edge("e-b-exit", "b", "exit", 2),
    { type: "run.status", seq: seq(), status: "success" },
  ];
}

describe("replayAsOf", () => {
  it("returns null without a breadcrumb or out of range", () => {
    expect(replayAsOf(buildRunGraphState([]), 0)).toBeNull();
    const state = buildRunGraphState(loopRun());
    expect(replayRange(state)).toEqual({ min: 0, max: 5 });
    expect(replayAsOf(state, -1)).toBeNull();
    expect(replayAsOf(state, 6)).toBeNull();
  });

  it("at the first node completion: that node runs, everything else not-reached", () => {
    const state = buildRunGraphState(loopRun());
    const view = replayAsOf(state, 0);
    expect(view).not.toBeNull();
    expect(view?.nodes).toEqual({ a: { status: "running", executionCount: 1 } });
    expect(view?.edges).toEqual({});
    expect(view?.focusNodeId).toBe("a");
  });

  it("mid-loop: the loop node shows running, its first iteration success, downstream not-reached", () => {
    const state = buildRunGraphState(loopRun());
    // Position 4 = b#2's completion entry.
    const view = replayAsOf(state, 4);
    expect(view?.nodes["a"]).toEqual({ status: "success", executionCount: 1 });
    // b ran once before (iteration 1 = success) and is mid-execution as #2.
    expect(view?.nodes["b"]).toEqual({ status: "running", executionCount: 2 });
    expect(view?.nodes["exit"]).toBeUndefined();
    expect(view?.focusNodeId).toBe("b");
    // The loop edge that routed back into b animates.
    expect(view?.animatedEdgeId).toBe("e-loop-b");
    expect(view?.edges["e-loop-b"]).toEqual({ taken: true, animated: true, takeCount: 1 });
    expect(view?.edges["e-a-b"]).toEqual({ taken: true, animated: false, takeCount: 1 });
    expect(view?.edges["e-b-exit"]).toBeUndefined();
  });

  it("at an edge position: the edge animates and its target is queued", () => {
    const state = buildRunGraphState(loopRun());
    // Position 3 = the loop edge back into b (b#1 already succeeded).
    const view = replayAsOf(state, 3);
    expect(view?.nodes["b"]).toEqual({ status: "queued", executionCount: 1 });
    expect(view?.animatedEdgeId).toBe("e-loop-b");
    expect(view?.focusNodeId).toBeNull();
  });

  it("at the final edge: everything before is success, exit still queued, exit edge animates", () => {
    const state = buildRunGraphState(loopRun());
    const view = replayAsOf(state, 5);
    expect(view?.nodes).toEqual({
      a: { status: "success", executionCount: 1 },
      b: { status: "success", executionCount: 2 },
      exit: { status: "queued", executionCount: 0 },
    });
    expect(view?.animatedEdgeId).toBe("e-b-exit");
  });

  it("reflects failed executions in history positions", () => {
    nextSeq = 100;
    const events: RunStreamEvent[] = [
      ...node("a", 1),
      edge("e-a-b", "a", "b", 1),
      ...node("b", 1, "failed"),
    ];
    const state = buildRunGraphState(events);
    const view = replayAsOf(state, 2);
    expect(view?.nodes["b"]?.status).toBe("running");
    expect(view?.nodes["a"]?.status).toBe("success");
    // Position 1 (the edge): b is queued-ahead, a successful behind.
    const atEdge = replayAsOf(state, 1);
    expect(atEdge?.nodes["b"]).toEqual({ status: "queued", executionCount: 0 });
  });
});
