import { describe, expect, it } from "vitest";
import type {
  EdgeCapReachedEvent,
  EdgeTakenEvent,
  NodeApprovedEvent,
  NodeAwaitingEvent,
  NodeCompletedEvent,
  NodeQueuedEvent,
  NodeRetryEvent,
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

const awaiting = (
  nodeId: string,
  iteration = 1,
  extra: Partial<NodeAwaitingEvent> = {},
): NodeAwaitingEvent => ({
  type: "node.awaiting",
  seq: seq(),
  nodeId,
  nodeName: nodeId,
  iteration,
  prompt: "Ship it?",
  ...extra,
});

const approved = (
  nodeId: string,
  approvedFlag: boolean,
  iteration = 1,
  note?: string,
): NodeApprovedEvent => ({
  type: "node.approved",
  seq: seq(),
  nodeId,
  nodeName: nodeId,
  iteration,
  approved: approvedFlag,
  ...(note === undefined ? {} : { note }),
});

const retry = (
  nodeId: string,
  attempt: number,
  iteration = 1,
  nextInMs = 100 * 2 ** (attempt - 1),
): NodeRetryEvent => ({
  type: "node.retry",
  seq: seq(),
  nodeId,
  nodeName: nodeId,
  iteration,
  attempt,
  nextInMs,
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

  it("settles live executions when the run ends interrupted (node drawer)", () => {
    const state = buildRunGraphState([
      runStatus("running"),
      queued("a"),
      started("a"),
      runStatus("interrupted"),
    ]);
    expect(state.nodes["a"]?.executions[0]?.status).toBe("interrupted");
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

describe("fold: approval gates (#118)", () => {
  it("node.awaiting flips the node to the awaiting visual state", () => {
    const state = buildRunGraphState([queued("gate"), started("gate"), awaiting("gate")]);
    expect(state.nodes["gate"]?.status).toBe("awaiting");
    expect(state.nodes["gate"]?.executions[0]).toMatchObject({
      iteration: 1,
      status: "awaiting",
    });
    // No timeline/breadcrumb rows: node.started already announced it.
    expect(state.breadcrumb).toHaveLength(0);
  });

  it("node.approved records the decision on the execution; completion follows", () => {
    const state = buildRunGraphState([
      queued("gate"),
      started("gate"),
      awaiting("gate"),
      approved("gate", false, 1, "needs work"),
      completed("gate", 1),
    ]);
    expect(state.nodes["gate"]?.status).toBe("success");
    expect(state.nodes["gate"]?.executions[0]).toMatchObject({
      approval: { approved: false, note: "needs work" },
      output: "out:gate:1",
    });
  });

  it("a terminal run.status settles an awaiting node (interrupted sweep)", () => {
    const state = buildRunGraphState([
      queued("gate"),
      started("gate"),
      awaiting("gate"),
      runStatus("interrupted"),
    ]);
    expect(state.nodes["gate"]?.status).toBe("interrupted");
    expect(state.nodes["gate"]?.executions[0]?.status).toBe("interrupted");
  });

  it("node.awaiting carries the timeout window through", () => {
    const state = buildRunGraphState([awaiting("gate", 1, { timeoutMinutes: 5 })]);
    expect(state.nodes["gate"]?.executions[0]?.status).toBe("awaiting");
  });
});

describe("fold: node retries (#119)", () => {
  it("retries stay inside ONE execution: attempt + pending backoff on the row, node stays running", () => {
    const state = buildRunGraphState([
      queued("a"),
      started("a"),
      retry("a", 1, 1, 100),
      retry("a", 2, 1, 200),
    ]);
    const a = state.nodes["a"];
    expect(a?.status).toBe("running");
    expect(a?.executions).toHaveLength(1);
    expect(a?.executions[0]).toMatchObject({
      iteration: 1,
      status: "running",
      attempt: 3,
      retryInMs: 200,
    });
  });

  it("the settled completion records the final attempt and clears the pending backoff", () => {
    const state = buildRunGraphState([
      started("a"),
      retry("a", 1),
      completed("a", 1, "success", { attempt: 2 }),
    ]);
    expect(state.nodes["a"]?.executions[0]).toMatchObject({
      status: "success",
      attempt: 2,
      retryInMs: undefined,
    });
  });

  it("summary counts: executions +1 per execution, attempts +1 per execution and per retry", () => {
    const plain = buildRunGraphState([started("a"), completed("a", 1)]);
    expect(plain.totalExecutions).toBe(1);
    expect(plain.totalAttempts).toBe(1);

    const retried = buildRunGraphState([
      started("a"),
      retry("a", 1),
      retry("a", 2),
      completed("a", 1, "success", { attempt: 3 }),
      started("b"),
      completed("b", 1),
    ]);
    expect(retried.totalExecutions).toBe(2);
    // a ran 3 attempts (1 + 2 retries), b ran 1.
    expect(retried.totalAttempts).toBe(4);
  });

  it("retries on a not-yet-announced node create the execution running", () => {
    const state = buildRunGraphState([retry("a", 1)]);
    expect(state.nodes["a"]?.status).toBe("running");
    expect(state.nodes["a"]?.executions[0]).toMatchObject({ attempt: 2, retryInMs: 100 });
    expect(state.totalAttempts).toBe(1);
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

  it("ignores sandbox.log events (seq-only) — no nodes, edges, or timeline rows (#104)", () => {
    const base = buildRunGraphState(loopRunEvents());
    const logs: RunStreamEvent[] = [
      { type: "sandbox.log", seq: 900, sandboxId: "sb-1", stream: "stdout", line: "l1" },
      { type: "sandbox.log", seq: 901, sandboxId: "sb-1", stream: "stderr", line: "l2" },
      { type: "sandbox.log-truncated", seq: 902, sandboxId: "sb-1", dropped: 3, kept: 2000 },
    ];
    const state = foldRunGraphEvents(base, logs);
    expect(state.nodes).toEqual(base.nodes);
    expect(state.edges).toEqual(base.edges);
    expect(state.timeline).toEqual(base.timeline);
    expect(state.breadcrumb).toEqual(base.breadcrumb);
    expect(state.lastSeq).toBe(902); // cursor still advances (dedupe stays sound)
  });
});

// -------------------------------------------------------------------------
// #115: parallel fan-out + join — the fold keeps concurrent node states.
//

describe("fold: parallel fan-out + join (#115)", () => {
  /** Diamond a→(b, c)→j→d→exit with both branches running concurrently. */
  function diamondRunEvents(): RunStreamEvent[] {
    return [
      runStatus("running"),
      queued("a"),
      started("a"),
      completed("a", 1),
      // Fan-out schedules both branches up front (branch edgeIds carried);
      // no edge.taken for the fan-out itself.
      { ...queued("b"), edgeId: "e-a-b" },
      { ...queued("c"), edgeId: "e-a-c" },
      { ...started("b"), edgeId: "e-a-b" },
      { ...started("c"), edgeId: "e-a-c" },
      completed("b", 1),
      edgeTaken("e-b-j", "b", "j", 1),
      completed("c", 1),
      edgeTaken("e-c-j", "c", "j", 1),
      // The join executes instantly with the merged outputs map.
      queued("j"),
      started("j"),
      { ...completed("j", 1), output: '{"b":"B-OUT","c":"C-OUT"}' },
      edgeTaken("e-j-d", "j", "d", 1),
      queued("d"),
      started("d"),
      completed("d", 1),
      edgeTaken("e-d-exit", "d", "exit", 1),
      runStatus("success"),
    ];
  }

  it("renders the diamond: two nodes running at once, branch edgeIds on executions", () => {
    const events = diamondRunEvents();
    // Slice up to both branches running: b and c are running CONCURRENTLY —
    // the fold is keyed by node id, so both stay live independently.
    const mid = buildRunGraphState(events.slice(0, 8));
    expect(mid.nodes["a"]?.status).toBe("success");
    expect(mid.nodes["b"]?.status).toBe("running");
    expect(mid.nodes["c"]?.status).toBe("running");
    expect(mid.nodes["b"]?.executions[0]).toMatchObject({ edgeId: "e-a-b" });
    expect(mid.nodes["c"]?.executions[0]).toMatchObject({ edgeId: "e-a-c" });
    expect(mid.totalExecutions).toBe(3); // a + b + c announced so far

    const state = buildRunGraphState(events);
    // Final state: every node settled, join included with its merged output.
    expect(state.nodes["j"]?.status).toBe("success");
    expect(state.nodes["j"]?.executions[0]).toMatchObject({
      iteration: 1,
      output: '{"b":"B-OUT","c":"C-OUT"}',
    });
    expect(state.nodes["d"]?.status).toBe("success");
    expect(state.runStatus).toBe("success");
    // Fan-out edges produce no edge.taken; only the merge/chain edges do.
    expect(state.edges["e-b-j"]?.takeCount).toBe(1);
    expect(state.edges["e-c-j"]?.takeCount).toBe(1);
    expect(state.edges["e-a-b"]).toBeUndefined();
    expect(state.edges["e-a-c"]).toBeUndefined();
    // Timeline follows the breadcrumb: completions + taken edges in order.
    expect(state.timeline.map((entry) => entry.id)).toEqual([
      "a",
      "b",
      "e-b-j",
      "c",
      "e-c-j",
      "j",
      "e-j-d",
      "d",
      "e-d-exit",
    ]);
  });

  it("settles still-running branches when the run terminalizes (fail-fast cancel)", () => {
    const events = diamondRunEvents();
    // Crash-cut variant: b done, c running, then the run fails (b's sibling
    // cancelled → run.status failed sweeps c to failed).
    const cut = [
      ...events.slice(0, 3),
      { ...queued("b"), edgeId: "e-a-b" },
      { ...queued("c"), edgeId: "e-a-c" },
      { ...started("b"), edgeId: "e-a-b" },
      { ...started("c"), edgeId: "e-a-c" },
      completed("b", 1, "failed"),
      runStatus("failed"),
    ];
    const state = buildRunGraphState(cut);
    expect(state.nodes["b"]?.status).toBe("failed");
    expect(state.nodes["c"]?.status).toBe("failed"); // swept by the terminal
    expect(state.nodes["c"]?.executions[0]?.status).toBe("failed");
  });
});

describe("fold sub-workflow child run ids (#117)", () => {
  it("node.completed with childRunId threads it onto the execution row", () => {
    const state = buildRunGraphState([
      queued("sub"),
      started("sub"),
      completed("sub", 1, "success", { childRunId: "child-run-1" }),
    ]);
    expect(state.nodes["sub"]?.executions).toEqual([
      {
        iteration: 1,
        status: "success",
        childRunId: "child-run-1",
        output: "out:sub:1",
        durationMs: 100,
      },
    ]);
  });

  it("ordinary completions carry no childRunId, and re-folding the same events is idempotent", () => {
    const events = [
      queued("a"),
      started("a"),
      completed("a", 1),
      queued("sub"),
      started("sub"),
      completed("sub", 1, "success", { childRunId: "child-run-1" }),
      runStatus("success"),
    ];
    const state = buildRunGraphState(events);
    expect(state.nodes["a"]?.executions[0]?.childRunId).toBeUndefined();
    expect(state.nodes["sub"]?.executions[0]?.childRunId).toBe("child-run-1");
    // SSE replay re-delivery (seq at or below the cursor) changes nothing.
    expect(foldRunGraphEvents(state, events)).toBe(state);
  });
});
