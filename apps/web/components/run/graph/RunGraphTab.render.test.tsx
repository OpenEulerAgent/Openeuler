// @vitest-environment jsdom
//
// Graph tab render (jsdom + React Flow): the pinned revision canvas renders
// node cards with their folded execution states, replay controls appear for
// finished runs, and the node drawer groups StepRuns by iteration with a
// working diff deep link.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StepRun, WorkflowGraph } from "@openeuler/core";
import { toCanvasDocument } from "@/lib/graph/canvas-document";
import { buildRunGraphState } from "@/lib/run-graph/fold";
import type { RunStreamEvent } from "@/lib/run-events";
import { RunGraphTab } from "./RunGraphTab";
import { NodeRunDrawer, nodeIterationRows } from "./NodeRunDrawer";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

// React Flow v12 requires browser APIs jsdom lacks.
beforeEach(() => {
  (globalThis as Record<string, unknown>).ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = class DOMMatrixReadOnly {
    m22 = 1;
  };
  if (!HTMLElement.prototype.scrollTo) {
    HTMLElement.prototype.scrollTo = (): void => {};
  }
});

const graph: WorkflowGraph = {
  entryNodeId: "a",
  nodes: [
    {
      id: "a",
      type: "agent",
      name: "Worker A",
      position: { x: 0, y: 0 },
      config: { driver: "fake", mode: "auto", promptTemplate: "{{task}}", continueSession: false },
    },
    {
      id: "b",
      type: "agent",
      name: "Worker B",
      position: { x: 300, y: 0 },
      config: { driver: "fake", mode: "auto", promptTemplate: "{{task}}", continueSession: false },
    },
    { id: "exit", type: "exit", name: "Exit", position: { x: 600, y: 0 } },
  ],
  edges: [
    { id: "e-a-b", source: "a", target: "b", condition: { type: "always" } },
    {
      id: "e-loop",
      source: "b",
      target: "a",
      condition: { type: "outputNotContains", pattern: "done" },
      order: 0,
      maxIterations: 3,
    },
    { id: "e-b-exit", source: "b", target: "exit", condition: { type: "always" } },
  ],
};

const events: RunStreamEvent[] = [
  { type: "node.queued", seq: 0, nodeId: "a", nodeName: "Worker A", iteration: 1 },
  { type: "node.started", seq: 1, nodeId: "a", nodeName: "Worker A", iteration: 1 },
  {
    type: "node.completed",
    seq: 2,
    nodeId: "a",
    nodeName: "Worker A",
    iteration: 1,
    status: "success",
    output: "a-1",
    durationMs: 1200,
  },
  {
    type: "edge.taken",
    seq: 3,
    edgeId: "e-a-b",
    source: "a",
    target: "b",
    matchedCondition: "always",
    iteration: 1,
  },
  { type: "node.queued", seq: 4, nodeId: "b", nodeName: "Worker B", iteration: 1 },
  { type: "node.started", seq: 5, nodeId: "b", nodeName: "Worker B", iteration: 1 },
  {
    type: "node.completed",
    seq: 6,
    nodeId: "b",
    nodeName: "Worker B",
    iteration: 1,
    status: "success",
    output: "b-1",
    durationMs: 3400,
  },
  {
    type: "edge.taken",
    seq: 7,
    edgeId: "e-loop",
    source: "b",
    target: "a",
    matchedCondition: 'not-contains "done"',
    iteration: 1,
  },
  { type: "node.queued", seq: 8, nodeId: "a", nodeName: "Worker A", iteration: 2 },
  { type: "node.started", seq: 9, nodeId: "a", nodeName: "Worker A", iteration: 2 },
  {
    type: "node.completed",
    seq: 10,
    nodeId: "a",
    nodeName: "Worker A",
    iteration: 2,
    status: "success",
    output: "a-2",
    durationMs: 800,
  },
  {
    type: "edge.taken",
    seq: 11,
    edgeId: "e-a-b",
    source: "a",
    target: "b",
    matchedCondition: "always",
    iteration: 2,
  },
  {
    type: "node.completed",
    seq: 14,
    nodeId: "b",
    nodeName: "Worker B",
    iteration: 2,
    status: "failed",
    output: "",
    durationMs: 300,
    error: "agent exploded",
  },
  { type: "run.status", seq: 15, status: "failed" },
];

const steps: StepRun[] = [
  {
    id: "sr-a1",
    runId: "r",
    stepId: "a",
    iteration: 1,
    sessionId: "sess-a",
    status: "success",
    output: "a-1",
    diff: "@@ a",
  },
  {
    id: "sr-b1",
    runId: "r",
    stepId: "b",
    iteration: 1,
    sessionId: "sess-b",
    status: "success",
    output: "b-1",
  },
  {
    id: "sr-a2",
    runId: "r",
    stepId: "a",
    iteration: 2,
    sessionId: "sess-a",
    status: "success",
    output: "a-2",
    diff: "@@ b",
  },
  { id: "sr-b2", runId: "r", stepId: "b", iteration: 2, status: "failed", output: "" },
];

let root: Root | null = null;
let container: HTMLElement | null = null;

const render = (node: ReactNode): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("RunGraphTab (jsdom)", () => {
  it("renders node cards with their folded states and iteration badges", () => {
    const state = buildRunGraphState(events);
    render(
      createElement(RunGraphTab, {
        graph: { kind: "revision", doc: toCanvasDocument(graph), revisionNumber: 1 },
        state,
        live: false,
        steps,
        onOpenDiff: () => {},
      }),
    );

    const cards = [...document.querySelectorAll("[data-run-node]")];
    // DOM order = doc order [a, b, exit]: a's LATEST execution succeeded
    // (×2 badge), b failed, the exit node never executes.
    expect(cards.map((card) => card.getAttribute("data-run-node-status"))).toEqual([
      "success",
      "failed",
      "not-reached",
    ]);
    // Node a shows its ×2 badge (two executions).
    expect(document.body.textContent).toContain("×2");
    expect(document.querySelector("[data-replay-controls]")).not.toBeNull();
    const slider = document.querySelector('input[type="range"]') as HTMLInputElement;
    expect(Number(slider.getAttribute("max"))).toBe(state.breadcrumb.length - 1);
  });

  it("shows the graph-unavailable card for ad-hoc runs", () => {
    render(
      createElement(RunGraphTab, {
        graph: { kind: "adhoc" },
        state: buildRunGraphState([]),
        live: true,
        steps: [],
        onOpenDiff: () => {},
      }),
    );
    expect(document.body.textContent).toContain("Graph unavailable");
  });

  it("renders the diamond: join card + two branches running concurrently (#116)", () => {
    // a fans out to b and c; both converge at join j before the exit.
    const diamond: WorkflowGraph = {
      entryNodeId: "a",
      nodes: [
        {
          id: "a",
          type: "agent",
          name: "Split",
          position: { x: 0, y: 0 },
          config: {
            driver: "fake",
            mode: "auto",
            promptTemplate: "{{task}}",
            continueSession: false,
          },
        },
        {
          id: "b",
          type: "agent",
          name: "Left",
          position: { x: 300, y: -140 },
          config: {
            driver: "fake",
            mode: "auto",
            promptTemplate: "{{task}}",
            continueSession: false,
          },
        },
        {
          id: "c",
          type: "agent",
          name: "Right",
          position: { x: 300, y: 140 },
          config: {
            driver: "fake",
            mode: "auto",
            promptTemplate: "{{task}}",
            continueSession: false,
          },
        },
        {
          id: "j",
          type: "join",
          name: "Merge",
          position: { x: 600, y: 0 },
          config: { mode: "all" },
        },
        { id: "exit", type: "exit", name: "Exit", position: { x: 900, y: 0 } },
      ],
      edges: [
        { id: "e-a-b", source: "a", target: "b", condition: { type: "always" } },
        { id: "e-a-c", source: "a", target: "c", condition: { type: "always" } },
        { id: "e-b-j", source: "b", target: "j", condition: { type: "always" } },
        { id: "e-c-j", source: "c", target: "j", condition: { type: "always" } },
        { id: "e-j-exit", source: "j", target: "exit", condition: { type: "always" } },
      ],
    };
    // Mid-run: a finished; b and c are BOTH running (fan-out), the join and
    // exit have not been reached yet.
    const mid = buildRunGraphState([
      { type: "run.status", seq: 0, status: "running" },
      { type: "node.queued", seq: 1, nodeId: "a", nodeName: "Split", iteration: 1 },
      { type: "node.started", seq: 2, nodeId: "a", nodeName: "Split", iteration: 1 },
      {
        type: "node.completed",
        seq: 3,
        nodeId: "a",
        nodeName: "Split",
        iteration: 1,
        status: "success",
        output: "split-out",
        durationMs: 900,
      },
      { type: "node.queued", seq: 4, nodeId: "b", nodeName: "Left", iteration: 1, edgeId: "e-a-b" },
      {
        type: "node.queued",
        seq: 5,
        nodeId: "c",
        nodeName: "Right",
        iteration: 1,
        edgeId: "e-a-c",
      },
      {
        type: "node.started",
        seq: 6,
        nodeId: "b",
        nodeName: "Left",
        iteration: 1,
        edgeId: "e-a-b",
      },
      {
        type: "node.started",
        seq: 7,
        nodeId: "c",
        nodeName: "Right",
        iteration: 1,
        edgeId: "e-a-c",
      },
    ]);
    render(
      createElement(RunGraphTab, {
        graph: { kind: "revision", doc: toCanvasDocument(diamond), revisionNumber: 1 },
        state: mid,
        live: true,
        steps: [],
        onOpenDiff: () => {},
      }),
    );

    const cards = [...document.querySelectorAll("[data-run-node]")];
    expect(cards.map((card) => card.getAttribute("data-run-node"))).toEqual([
      "agent",
      "agent",
      "agent",
      "join",
      "exit",
    ]);
    // Both branches live at once; the join waits (not-reached), and its
    // card shows the synchronizer identity.
    expect(cards.map((card) => card.getAttribute("data-run-node-status"))).toEqual([
      "success",
      "running",
      "running",
      "not-reached",
      "not-reached",
    ]);
    const joinCard = cards[3] as HTMLElement;
    expect(joinCard.textContent).toContain("Merge");
    expect(joinCard.textContent).toContain("join · all");
  });
});

describe("NodeRunDrawer", () => {
  it("joins fold executions with StepRun rows grouped by iteration", () => {
    const state = buildRunGraphState(events);
    const rows = nodeIterationRows(
      state.nodes["a"] ?? null,
      steps.filter((step) => step.stepId === "a"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      iteration: 1,
      status: "success",
      durationMs: 1200,
      output: "a-1",
      stepRun: { id: "sr-a1", sessionId: "sess-a" },
    });
    expect(rows[1]?.stepRun?.id).toBe("sr-a2");
  });

  it("renders iterations as an accordion with a diff deep-link per execution", () => {
    const state = buildRunGraphState(events);
    const onOpenDiff = vi.fn();
    render(
      createElement(NodeRunDrawer, {
        open: true,
        onClose: () => {},
        nodeId: "a",
        nodeName: "Worker A",
        node: state.nodes["a"] ?? null,
        steps,
        onOpenDiff,
      }),
    );

    const sections = document.querySelectorAll("[data-node-drawer-iterations] > details");
    expect(sections).toHaveLength(2);
    expect(sections[0]?.getAttribute("open")).toBe("");
    expect(sections[1]?.getAttribute("open")).toBeNull();

    const buttons = [...document.querySelectorAll("[data-node-drawer-iterations] button")].filter(
      (button) => button.textContent?.includes("View diff"),
    );
    expect(buttons).toHaveLength(2);

    act(() => {
      (buttons[1] as HTMLElement).click();
    });
    expect(onOpenDiff).toHaveBeenCalledWith("sr-a2");
  });

  it("falls back to StepRun rows when the fold has none", () => {
    const rows = nodeIterationRows(
      null,
      steps.filter((step) => step.stepId === "b"),
    );
    expect(rows.map((row) => [row.iteration, row.output])).toEqual([
      [1, "b-1"],
      [2, ""],
    ]);
  });
});
