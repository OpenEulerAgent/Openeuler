import { describe, expect, it } from "vitest";
import type {
  EdgeCapReachedEvent,
  EdgeTakenEvent,
  NodeCompletedEvent,
  NodeQueuedEvent,
  NodeStartedEvent,
  RunStatusEvent,
  StepCompletedEvent,
  StepStartedEvent,
} from "@openeuler/core";
import type { RunStreamEvent } from "@/lib/run-events";
import {
  buildRunGraphState,
  foldRunGraphEvent,
  foldRunGraphEvents,
  EMPTY_RUN_GRAPH_STATE,
} from "./fold";

// -------------------------------------------------------------------------
// Event fixtures (seq assigned in order below).
//

let nextSeq = 0;
const seq = (): number => nextSeq++;

const runStatus = (status: RunStatusEvent["status"]): RunStatusEvent => ({
  type: "run.status",
  seq: seq(),
  status,
});

const queued = (nodeId: string, iteration = 1, nodeName = nodeId): NodeQueuedEvent => ({
  type: "node.queued",
  seq: seq(),
  nodeId,
  nodeName,
  iteration,
});

const started = (nodeId: string, iteration = 1, nodeName = nodeId): NodeStartedEvent => ({
  type: "node.started",
  seq: seq(),
  nodeId,
  nodeName,
  iteration,
});

const completed = (
  nodeId: string,
  iteration: number,
  status: NodeCompletedEvent["status"] = "success",
  extra: Partial<NodeCompletedEvent> = {},
): NodeCompletedEvent => ({
  type: "node.completed",
  seq: seq(),
  nodeId,
  nodeName: nodeId,
  iteration,
  status,
  output: `out:${nodeId}:${iteration}`,
  durationMs: 100 * iteration,
  ...extra,
});

const edgeTaken = (
  edgeId: string,
  source: string,
  target: string,
  iteration = 1,
): EdgeTakenEvent => ({
  type: "edge.taken",
  seq: seq(),
  edgeId,
  source,
  target,
  matchedCondition: "always",
  iteration,
});

const capReached = (edgeId: string, source: string, target: string): EdgeCapReachedEvent => ({
  type: "edge.cap-reached",
  seq: seq(),
  edgeId,
  source,
  target,
  taken: 3,
  maxIterations: 3,
});

const stepStarted = (stepId: string, iteration = 1): StepStartedEvent => ({
  type: "step.started",
  seq: seq(),
  stepId,
  stepName: stepId,
  iteration,
});

const stepCompleted = (
  stepId: string,
  iteration: number,
  status: StepCompletedEvent["status"] = "success",
): StepCompletedEvent => ({
  type: "step.completed",
  seq: seq(),
  stepId,
  stepName: stepId,
  iteration,
  status,
});

/** One full loop-graph execution: a → b → (loop b) → b → exit. */
function loopRunEvents(): RunStreamEvent[] {
  return [
    runStatus("running"),
    queued("a"),
    started("a"),
    completed("a", 1),
    edgeTaken("e-a-b", "a", "b", 1),
    queued("b"),
    started("b"),
    completed("b", 1),
    edgeTaken("e-loop-b", "b", "b", 1),
    queued("b"),
    started("b"),
    completed("b", 2),
    edgeTaken("e-b-exit", "b", "exit", 2),
    runStatus("success"),
  ];
}

describe("fold: node state transitions", () => {
  it("walks queued → running → success and carries output/duration per execution", () => {
    const state = buildRunGraphState([queued("a"), started("a"), completed("a", 1)]);
    expect(state.nodes["a"]?.status).toBe("success");
    expect(state.nodes["a"]?.executionCount).toBe(1);
    expect(state.nodes["a"]?.executions).toEqual([
      { iteration: 1, status: "success", output: "out:a:1", durationMs: 100 },
    ]);
  });

  it("keeps the LATEST state per node (re-entry after loop)", () => {
    const state = buildRunGraphState(loopRunEvents());
    const b = state.nodes["b"];
    expect(b?.status).toBe("success");
    expect(b?.executionCount).toBe(2);
    expect(b?.executions.map((row) => row.iteration)).toEqual([1, 2]);
  });

  it("records failed completions with their error", () => {
    const state = buildRunGraphState([
      queued("a"),
      started("a"),
      completed("a", 1, "failed", { error: "boom", output: "" }),
    ]);
    expect(state.nodes["a"]?.status).toBe("failed");
    expect(state.nodes["a"]?.executions[0]?.error).toBe("boom");
  });

  it("marks untouched nodes by absence (not-reached)", () => {
    const state = buildRunGraphState([queued("a")]);
    expect(state.nodes["a"]).toBeDefined();
    expect(state.nodes["zzz"]).toBeUndefined();
  });

  it("settles live nodes when the run itself ends interrupted", () => {
    const state = buildRunGraphState([
      runStatus("running"),
      queued("a"),
      started("a"),
      started("b"),
      runStatus("interrupted"),
    ]);
    expect(state.nodes["a"]?.status).toBe("interrupted");
    expect(state.nodes["b"]?.status).toBe("interrupted");
  });

  it("folds legacy step.started/step.completed runs identically (linear workflows)", () => {
    const state = buildRunGraphState([
      stepStarted("s1"),
      stepCompleted("s1", 1),
      stepStarted("s2"),
      stepCompleted("s2", 1),
      stepStarted("s1", 2),
      stepCompleted("s1", 2),
      runStatus("success"),
    ]);
    expect(state.nodes["s1"]?.status).toBe("success");
    expect(state.nodes["s1"]?.executionCount).toBe(2);
    expect(state.nodes["s2"]?.status).toBe("success");
    expect(state.totalExecutions).toBe(3);
    expect(state.breadcrumb.map((entry) => `${entry.id}#${entry.iteration}`)).toEqual([
      "s1#1",
      "s2#1",
      "s1#2",
    ]);
  });
});

describe("fold: edges + breadcrumb", () => {
  it("counts traversals, tracks the last taken edge and builds the breadcrumb", () => {
    const state = buildRunGraphState(loopRunEvents());
    expect(state.edges["e-loop-b"]?.takeCount).toBe(1);
    expect(state.edges["e-a-b"]?.takeCount).toBe(1);
    expect(state.lastTakenEdgeId).toBe("e-b-exit");
    expect(state.breadcrumb.map((entry) => entry.kind)).toEqual([
      "node",
      "edge",
      "node",
      "edge",
      "node",
      "edge",
    ]);
    expect(state.breadcrumb[0]).toMatchObject({
      id: "a",
      iteration: 1,
      durationMs: 100,
      status: "success",
    });
  });

  it("records cap-reached edges with their guard detail (timeline row, no breadcrumb entry)", () => {
    const state = buildRunGraphState([
      completed("a", 1),
      edgeTaken("e-a-b", "a", "b", 1),
      completed("b", 1),
      capReached("e-loop-b", "b", "b"),
      edgeTaken("e-b-exit", "b", "exit", 1),
    ]);
    expect(state.edges["e-loop-b"]?.cap).toMatchObject({ taken: 3, maxIterations: 3 });
    expect(state.breadcrumb.some((entry) => entry.kind === "cap")).toBe(false);
    expect(state.timeline.some((entry) => entry.kind === "cap")).toBe(true);
  });

  it("counts total node executions across iterations", () => {
    const state = buildRunGraphState(loopRunEvents());
    expect(state.totalExecutions).toBe(3); // a#1, b#1, b#2
  });
});

describe("fold: idempotence / replay safety", () => {
  it("folds the same events to the same state regardless of delivery shape", () => {
    const events = loopRunEvents();
    const live = buildRunGraphState(events);
    // Replay = same sequence re-folded from scratch, plus an overlapping
    // resend tail (what an EventSource reconnect redelivers).
    const replayed = foldRunGraphEvents(EMPTY_RUN_GRAPH_STATE, [...events, ...events.slice(-3)]);
    expect(replayed).toEqual(live);
  });

  it("ignores out-of-order duplicates via the seq cursor", () => {
    const events = loopRunEvents();
    const state = buildRunGraphState(events);
    const dupe = foldRunGraphEvent(state, events[1] as RunStreamEvent);
    expect(dupe).toBe(state);
  });

  it("keeps sub-state object identity for untouched nodes (React Flow memoization)", () => {
    let state = buildRunGraphState(loopRunEvents());
    const aBefore = state.nodes["a"];
    const bBefore = state.nodes["b"];
    state = foldRunGraphEvent(state, queued("a", 3));
    expect(state.nodes["b"]).toBe(bBefore);
    expect(state.nodes["a"]).not.toBe(aBefore);
  });

  it("advances the seq cursor on driver events without touching graph state", () => {
    const events: RunStreamEvent[] = [{ type: "session", seq: 5, sessionId: "s1" }];
    const state = foldRunGraphEvents(EMPTY_RUN_GRAPH_STATE, events);
    expect(state.lastSeq).toBe(5);
    expect(state.nodes).toEqual({});
  });
});
