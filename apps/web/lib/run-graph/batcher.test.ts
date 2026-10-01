import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunStreamEvent } from "@/lib/run-events";
import { RunGraphFoldBatcher, FOLD_BATCH_INTERVAL_MS } from "./batcher";
import { buildRunGraphState } from "./fold";

const nodeEvent = (seq: number): RunStreamEvent => ({
  type: "node.queued",
  seq,
  nodeId: `n${seq}`,
  nodeName: `n${seq}`,
  iteration: 1,
});

describe("RunGraphFoldBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies at most one state update per interval window under a burst", () => {
    const onState = vi.fn();
    const batcher = new RunGraphFoldBatcher({ onState });

    // 500-event replay burst within one window.
    for (let seq = 0; seq < 500; seq += 1) batcher.push(nodeEvent(seq));

    expect(onState).not.toHaveBeenCalled(); // nothing before the window ends
    vi.advanceTimersByTime(FOLD_BATCH_INTERVAL_MS);
    expect(onState).toHaveBeenCalledTimes(1);

    // A second burst in the next window: again exactly one emission.
    for (let seq = 500; seq < 700; seq += 1) batcher.push(nodeEvent(seq));
    vi.advanceTimersByTime(FOLD_BATCH_INTERVAL_MS);
    expect(onState).toHaveBeenCalledTimes(2);

    batcher.dispose();
  });

  it("keeps folding immediately (state getter) while emissions throttle", () => {
    const onState = vi.fn();
    const batcher = new RunGraphFoldBatcher({ onState });
    batcher.push({ type: "run.status", seq: 0, status: "running" });
    batcher.push(nodeEvent(1));
    expect(batcher.state.lastSeq).toBe(1);
    expect(batcher.state.nodes["n1"]?.status).toBe("queued");
    expect(onState).not.toHaveBeenCalled();
    batcher.dispose();
  });

  it("emits the COMPLETE folded state — no dropped updates", () => {
    const events: RunStreamEvent[] = [
      { type: "run.status", seq: 0, status: "running" },
      nodeEvent(1),
      nodeEvent(2),
      { type: "node.started", seq: 3, nodeId: "n1", nodeName: "n1", iteration: 1 },
      {
        type: "node.completed",
        seq: 4,
        nodeId: "n1",
        nodeName: "n1",
        iteration: 1,
        status: "success",
        output: "done",
        durationMs: 5,
      },
      { type: "run.status", seq: 5, status: "success" },
    ];
    const onState = vi.fn();
    const batcher = new RunGraphFoldBatcher({ onState });
    for (const event of events) batcher.push(event);

    batcher.flush();
    expect(onState).toHaveBeenCalledTimes(1);
    // The emitted state equals folding the whole sequence from scratch.
    expect(onState).toHaveBeenCalledWith(buildRunGraphState(events));
    batcher.dispose();
  });

  it("flush() emits immediately and cancels the pending timer", () => {
    const onState = vi.fn();
    const batcher = new RunGraphFoldBatcher({ onState, intervalMs: 1000 });
    batcher.push(nodeEvent(0));
    batcher.flush();
    expect(onState).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(onState).toHaveBeenCalledTimes(1); // timer was cancelled, not re-fired

    batcher.dispose();
  });

  it("dispose() stops emissions and ignores further pushes", () => {
    const onState = vi.fn();
    const batcher = new RunGraphFoldBatcher({ onState });
    batcher.push(nodeEvent(0));
    batcher.dispose();
    batcher.push(nodeEvent(1));
    vi.advanceTimersByTime(FOLD_BATCH_INTERVAL_MS * 2);
    expect(onState).not.toHaveBeenCalled();
  });
});
