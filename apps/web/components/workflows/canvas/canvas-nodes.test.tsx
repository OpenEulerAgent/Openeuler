// @vitest-environment jsdom
//
// Node card render coverage (#88): AgentNodeCard, ExitNodeCard, toFlowNodes
// and canvasNodeTypes previously had ZERO tests — seven canvas fixes landed
// without anything asserting a card actually paints. This file renders the
// REAL React Flow (no @xyflow/react mock) under jsdom:
//
//  - the ResizeObserver/DOMMatrixReadOnly shims come from
//    RunGraphTab.render.test.tsx, extended with a measuring stand-in:
//    jsdom has no layout engine (offsetWidth/offsetHeight are always 0), so
//    node wrappers report their token-box dimensions and the observer fires
//    like a browser's would. That drives React Flow's real measurement path
//    (ResizeObserver -> updateNodeInternals) and flips nodes from their
//    initial `visibility: hidden` to `visible` — the closest a headless box
//    without a real browser gets to the "cards paint" repro. No browser
//    recording is possible here (headless chromium lacks system libs).
//
// Asserted: cards are mounted, measured visible, token-sized, carry their
// content and handles; geometry tokens <-> Tailwind classes <-> dagre
// NODE_SIZES agree; toFlowNodes preserves non-entry node identity;
// canvasNodeTypes keeps a stable identity across re-renders.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReactFlow, ReactFlowProvider, type Edge } from "@xyflow/react";
import { ToastProvider } from "@/components/ui/toast";
import type { WorkflowGraph } from "@openeuler/core";
import { CANVAS_NODE_SIZE_CLASSES, CANVAS_NODE_SIZES } from "@/lib/graph/canvas-geometry";
import { NODE_SIZES } from "@/lib/graph/layout";
import type { CanvasDocument, CanvasNode } from "@/lib/graph/canvas-document";
import { GraphCanvasEditor } from "./GraphCanvasEditor";
import {
  NodeHintCountsContext,
  NodeIssueCountsContext,
  WorkflowNamesContext,
  canvasNodeTypes,
  toFlowNodes,
} from "./canvas-nodes";
import type { WorkflowWithGraph } from "@/lib/workflows-api";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

// jsdom lacks a layout engine: React Flow measures node wrappers through
// offsetWidth/offsetHeight (always 0 in jsdom) driven by ResizeObserver
// callbacks. The observer below fires like a browser's (async, on observe)
// so React Flow's real updateNodeInternals path runs; the prototype
// getters below then answer with the geometry-token box for node wrappers
// (and a viewport for the canvas container) so nodes measure and flip
// visibility: hidden -> visible exactly as in a browser.
type ObserverCallback = (entries: Array<{ target: Element }>, observer: unknown) => void;

const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

const wrapperBox = (element: HTMLElement): { width: number; height: number } => {
  if (
    element.classList.contains("react-flow") ||
    element.classList.contains("react-flow__renderer")
  ) {
    return { width: 800, height: 600 };
  }
  if (element.querySelector('[data-canvas-node="agent"]') !== null) return CANVAS_NODE_SIZES.agent;
  if (element.querySelector('[data-canvas-node="exit"]') !== null) return CANVAS_NODE_SIZES.exit;
  if (element.querySelector('[data-canvas-node="join"]') !== null) return CANVAS_NODE_SIZES.join;
  if (element.querySelector('[data-canvas-node="subworkflow"]') !== null) {
    return CANVAS_NODE_SIZES.subworkflow;
  }
  return { width: 0, height: 0 };
};

/** A ResizeObserverEntry stand-in carrying the element's token-box rect. */
const entryFor = (target: Element): { target: Element; contentRect: DOMRect } => {
  const { width, height } = wrapperBox(target as HTMLElement);
  return {
    target,
    contentRect: {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      width,
      height,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    } as DOMRect,
  };
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).ResizeObserver = class ResizeObserver {
    private readonly callback: ObserverCallback;
    private readonly fired = new Set<Element>();
    constructor(callback: ObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element): void {
      if (this.fired.has(target)) return;
      this.fired.add(target);
      queueMicrotask(() => this.callback([entryFor(target)], this));
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = class DOMMatrixReadOnly {
    m22 = 1;
  };
  if (!HTMLElement.prototype.scrollTo) {
    HTMLElement.prototype.scrollTo = (): void => {};
  }
  if (typeof document.elementFromPoint !== "function") {
    document.elementFromPoint = () => null;
  }
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains("react-flow__node") || this.classList.contains("react-flow")
        ? wrapperBox(this).width
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains("react-flow__node") || this.classList.contains("react-flow")
        ? wrapperBox(this).height
        : 0;
    },
  });
});

afterEach(() => {
  if (originalOffsetWidth) {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
  }
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
  }
});

const entry: CanvasNode = {
  id: "planner",
  type: "agent",
  position: { x: 0, y: 0 },
  data: {
    kind: "agent",
    name: "Planner",
    isEntry: true,
    config: {
      driver: "opencode",
      model: "glm-4.5",
      mode: "auto",
      promptTemplate: "plan: {{task}}",
      continueSession: true,
    },
  },
};

const worker: CanvasNode = {
  id: "worker",
  type: "agent",
  position: { x: 320, y: 0 },
  data: {
    kind: "agent",
    name: "Worker",
    isEntry: false,
    config: {
      driver: "claude",
      mode: "ask",
      promptTemplate: "do: {{task}}",
      continueSession: false,
    },
  },
};

const exitNode: CanvasNode = {
  id: "exit",
  type: "exit",
  position: { x: 640, y: 0 },
  data: { kind: "exit", name: "Done" },
};

const joinNode: CanvasNode = {
  id: "merge",
  type: "join",
  position: { x: 640, y: 0 },
  data: { kind: "join", name: "Merge", config: { mode: "all" } },
};

const subworkflowNode: CanvasNode = {
  id: "sub",
  type: "subworkflow",
  position: { x: 320, y: 160 },
  data: {
    kind: "subworkflow",
    name: "Spawn",
    config: { workflowId: "wf-child", revision: "latest" },
  },
};

const doc: CanvasDocument = {
  nodes: [entry, worker, joinNode, exitNode],
  edges: [
    {
      id: "e-planner-worker",
      source: "planner",
      target: "worker",
      data: { condition: { type: "always" } },
    },
    {
      id: "e-worker-merge",
      source: "worker",
      target: "merge",
      data: { condition: { type: "always" } },
    },
    {
      id: "e-merge-exit",
      source: "merge",
      target: "exit",
      data: { condition: { type: "always" } },
    },
  ],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = async (element: ReactElement): Promise<void> => {
  // A second render into the existing root is a re-render (same tree),
  // which is exactly what the identity tests exercise.
  if (root === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(element);
  });
  // Flush the measuring ResizeObserver microtasks so nodes are measured.
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {});
  }
};

/** Renders the doc's nodes through the REAL React Flow + canvas node types. */
const renderFlow = async (
  nodes: readonly CanvasNode[],
  edges: readonly { id: string; source: string; target: string }[],
): Promise<void> => {
  await render(
    createElement(
      ReactFlowProvider,
      null,
      createElement(ReactFlow, {
        nodes: toFlowNodes(nodes),
        edges: edges as unknown as Edge[],
        nodeTypes: canvasNodeTypes,
        fitView: true,
      }),
    ),
  );
};

const nodeWrapper = (id: string): HTMLElement => {
  const wrapper = document.querySelector(`.react-flow__node[data-id="${id}"]`);
  if (wrapper === null) throw new Error(`node wrapper ${id} not found`);
  return wrapper as HTMLElement;
};

const card = (id: string): HTMLElement => {
  const el = nodeWrapper(id).querySelector<HTMLElement>("[data-canvas-node]");
  if (el === null) throw new Error(`node card ${id} not found`);
  return el;
};

const handleCount = (id: string, kind: "source" | "target"): number =>
  nodeWrapper(id).querySelectorAll(`.react-flow__handle.${kind}`).length;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("canvas node cards under the real React Flow (#88)", () => {
  it("paint: mounted, measured visible, token-sized, content present", async () => {
    await renderFlow(doc.nodes, doc.edges);

    // Every node wrapper mounted AND measured: React Flow keeps unmeasured
    // nodes visibility:hidden, so this is the headless stand-in for "the
    // card is actually visible on the canvas".
    for (const node of doc.nodes) {
      const wrapper = nodeWrapper(node.id);
      expect(wrapper.style.visibility).toBe("visible");
      expect(wrapper.getAttribute("data-id")).toBe(node.id);
    }

    // Deterministic boxes: the cards pin exactly the geometry tokens
    // (dagre reserves the same px via NODE_SIZES — asserted below).
    expect(card("planner").className).toContain(CANVAS_NODE_SIZE_CLASSES.agent.width);
    expect(card("planner").className).toContain(CANVAS_NODE_SIZE_CLASSES.agent.height);
    expect(card("worker").className).toContain(CANVAS_NODE_SIZE_CLASSES.agent.width);
    expect(card("worker").className).toContain(CANVAS_NODE_SIZE_CLASSES.agent.height);
    expect(card("exit").className).toContain(CANVAS_NODE_SIZE_CLASSES.exit.width);
    expect(card("exit").className).toContain(CANVAS_NODE_SIZE_CLASSES.exit.height);
    // Join card (#116): its OWN geometry token (not borrowed from exit) —
    // same 140×64 box today, but the pair can diverge without touching
    // either card.
    expect(card("merge").className).toContain(CANVAS_NODE_SIZE_CLASSES.join.width);
    expect(card("merge").className).toContain(CANVAS_NODE_SIZE_CLASSES.join.height);
    expect(CANVAS_NODE_SIZE_CLASSES.join).not.toBe(CANVAS_NODE_SIZE_CLASSES.exit);

    // Content: name, driver, model, mode, session pill, terminal marker.
    const planner = card("planner").textContent ?? "";
    expect(planner).toContain("Planner");
    expect(planner).toContain("opencode");
    expect(planner).toContain("glm-4.5");
    expect(planner).toContain("auto");
    expect(planner).toContain("session");
    expect(planner).toContain("Entry");
    const workerText = card("worker").textContent ?? "";
    expect(workerText).toContain("Worker");
    expect(workerText).toContain("claude");
    expect(workerText).toContain("ask");
    const exitText = card("exit").textContent ?? "";
    expect(exitText).toContain("Done");
    expect(exitText).toContain("terminal");
    const joinText = card("merge").textContent ?? "";
    expect(joinText).toContain("Merge");
    expect(joinText).toContain("join · all");
  });

  it("geometry tokens, Tailwind classes and dagre NODE_SIZES agree (1 unit = 4px)", () => {
    for (const kind of ["agent", "exit", "join", "subworkflow"] as const) {
      const widthUnit = Number(CANVAS_NODE_SIZE_CLASSES[kind].width.slice(2));
      const heightUnit = Number(CANVAS_NODE_SIZE_CLASSES[kind].height.slice(2));
      expect(widthUnit * 4).toBe(CANVAS_NODE_SIZES[kind].width);
      expect(heightUnit * 4).toBe(CANVAS_NODE_SIZES[kind].height);
    }
    // Single source of truth: dagre's reserved boxes ARE the token objects.
    expect(NODE_SIZES).toBe(CANVAS_NODE_SIZES);
  });

  it("handles: entry has source only, other agents both, exit target only, join both", async () => {
    await renderFlow(doc.nodes, doc.edges);
    expect(handleCount("planner", "source")).toBe(1);
    expect(handleCount("planner", "target")).toBe(0);
    expect(handleCount("worker", "source")).toBe(1);
    expect(handleCount("worker", "target")).toBe(1);
    expect(handleCount("exit", "source")).toBe(0);
    expect(handleCount("exit", "target")).toBe(1);
    expect(handleCount("merge", "source")).toBe(1);
    expect(handleCount("merge", "target")).toBe(1);
  });

  it("badge contexts drive issue/hint/warning chips on the cards", async () => {
    await render(
      createElement(
        ReactFlowProvider,
        null,
        createElement(
          NodeIssueCountsContext.Provider,
          { value: new Map([["worker", 2]]) },
          createElement(
            NodeHintCountsContext.Provider,
            { value: new Map([["worker", 1]]) },
            createElement(ReactFlow, {
              nodes: toFlowNodes(doc.nodes),
              edges: doc.edges as unknown as Edge[],
              nodeTypes: canvasNodeTypes,
              fitView: true,
            }),
          ),
        ),
      ),
    );
    expect(card("worker").querySelector("[data-issue-badges]")).not.toBeNull();
    expect(card("worker").textContent).toContain("2");
    expect(card("planner").querySelector("[data-issue-badges]")).toBeNull();
  });
});

describe("toFlowNodes (#88)", () => {
  it("sets deletable:false on the entry only", () => {
    const flow = toFlowNodes(doc.nodes);
    expect(flow[0]?.id).toBe("planner");
    expect(flow[0]?.deletable).toBe(false);
    expect(flow[1]?.deletable).toBeUndefined();
    expect(flow[2]?.deletable).toBeUndefined();
  });

  it("preserves non-entry node identity; editing one node leaves the others untouched", () => {
    const flow = toFlowNodes(doc.nodes);
    // Pass-through: non-entry nodes are the SAME objects (no spread).
    expect(flow[1]).toBe(doc.nodes[1]);
    expect(flow[2]).toBe(doc.nodes[2]);
    // The entry carries a runtime flag, so it gets a stamped object — but
    // the stamp is cached against its document node: recomputing without
    // editing the entry returns the SAME object, so React Flow never
    // re-adopts it (which would wipe its measured dimensions and flash
    // the card hidden — the blank-card symptom).
    expect(flow[0]).not.toBe(doc.nodes[0]);
    expect(flow[0]?.deletable).toBe(false);
    expect(toFlowNodes([entry, worker, exitNode])[0]).toBe(flow[0]);

    // Rename the worker: only its flow node changes identity.
    const renamedWorker: CanvasNode = {
      ...worker,
      data: { ...worker.data, name: "Renamed" },
    };
    const next = toFlowNodes([entry, renamedWorker, joinNode, exitNode]);
    expect(next[1]).not.toBe(flow[1]);
    expect(next[2]).toBe(flow[2]);
    expect(next[3]).toBe(flow[3]);
    expect(next[0]).toBe(flow[0]);
    expect(next[1]?.data.name).toBe("Renamed");

    // Editing the entry itself does restamp it (fresh deletable:false).
    const renamedEntry: CanvasNode = {
      ...entry,
      data: { ...entry.data, name: "Renamed entry" },
    };
    const restamped = toFlowNodes([renamedEntry, worker, joinNode, exitNode]);
    expect(restamped[0]).not.toBe(flow[0]);
    expect(restamped[0]?.deletable).toBe(false);
  });
});

describe("canvasNodeTypes identity (#88)", () => {
  it("is the module-scope registry with all card kinds", () => {
    expect(Object.keys(canvasNodeTypes)).toEqual([
      "agent",
      "exit",
      "join",
      "subworkflow",
      "approval",
    ]);
  });

  it("keeps cards mounted across re-renders (stable component identity)", async () => {
    await renderFlow(doc.nodes, doc.edges);
    const workerCard = card("worker");

    const extra: CanvasNode = {
      id: "reviewer",
      type: "agent",
      position: { x: 320, y: 160 },
      data: {
        kind: "agent",
        name: "Reviewer",
        isEntry: false,
        config: {
          driver: "codex",
          mode: "auto",
          promptTemplate: "review: {{task}}",
          continueSession: false,
        },
      },
    };
    await renderFlow(
      [...doc.nodes, extra],
      [...doc.edges, { id: "e-worker-reviewer", source: "worker", target: "reviewer" }],
    );

    // The same DOM node survives: a rebuilt nodeTypes registry would have
    // unmounted and remounted every card.
    expect(card("worker")).toBe(workerCard);
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(5);
    expect(card("reviewer").textContent).toContain("Reviewer");
  });
});

describe("unguarded config reads (#88)", () => {
  it("renders a '—' driver chip when driver is empty and no chip for an absent model", async () => {
    const bare: CanvasNode = {
      id: "bare",
      type: "agent",
      position: { x: 0, y: 0 },
      data: {
        kind: "agent",
        name: "",
        isEntry: false,
        config: {
          driver: "",
          mode: "auto",
          promptTemplate: "{{task}}",
          continueSession: false,
        },
      },
    };
    await renderFlow([bare], []);
    const bareCard = card("bare");
    expect(bareCard.textContent).toContain("—");
    expect(bareCard.textContent).toContain("Untitled agent");
    expect(bareCard.textContent).toContain("auto");
    // Only the driver chip is mono — no empty model badge sneaks in.
    expect(bareCard.querySelectorAll(".font-mono")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Editor-level repro stand-in (#88): the full GraphCanvasEditor mounting the
// real (unmocked) React Flow with a 3-node graph. No real browser exists on
// this box, so this jsdom render is the closest available repro for "nodes
// render blank / invisible": it asserts the exact paint pipeline end to end.
//

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
}));

type RouteHandler = (init?: RequestInit) => unknown;

interface ApiMockState {
  calls: Array<{ path: string; init: RequestInit | undefined }>;
  routes: Record<string, RouteHandler>;
}

const apiMock = vi.hoisted(() => {
  const state: ApiMockState = { calls: [], routes: {} };
  const apiFetch = async (path: string, init?: RequestInit): Promise<unknown> => {
    state.calls.push({ path, init });
    const handler = Object.entries(state.routes)
      .sort((a, b) => b[0].length - a[0].length)
      .find(([prefix]) => path.startsWith(prefix))?.[1];
    if (handler === undefined) throw new Error(`no mock route for ${path}`);
    return handler(init);
  };
  return { state, apiFetch };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, apiFetch: apiMock.apiFetch };
});

const graphAgent = (id: string, x: number): WorkflowGraph["nodes"][number] => ({
  id,
  type: "agent",
  name: id === "entry" ? "Entry agent" : `Agent ${id}`,
  position: { x, y: 0 },
  config: {
    driver: "opencode",
    mode: "auto",
    promptTemplate: "work: {{task}}",
    continueSession: false,
  },
});

const threeNodeGraph: WorkflowGraph = {
  entryNodeId: "entry",
  nodes: [
    graphAgent("entry", 0),
    graphAgent("n1", 320),
    { id: "exit", type: "exit", name: "Exit", position: { x: 640, y: 0 } },
  ],
  edges: [
    { id: "e-entry-n1", source: "entry", target: "n1", condition: { type: "always" } },
    { id: "e-n1-exit", source: "n1", target: "exit", condition: { type: "always" } },
  ],
};

const workflowFor = (graph: WorkflowGraph): WorkflowWithGraph => ({
  id: "w1",
  projectId: "p1",
  name: "Demo workflow",
  steps: graph.nodes
    .filter((node) => node.type === "agent")
    .map((node) => ({
      id: node.id,
      name: node.name,
      driver: "opencode",
      mode: "auto" as const,
      promptTemplate: "work: {{task}}",
      continueSession: false,
    })),
  latestRevision: { id: "r1", number: 1 },
  graph,
});

describe("GraphCanvasEditor 3-node repro stand-in (#88)", () => {
  it("every card paints: wrapper measured visible, card token-sized with content", async () => {
    apiMock.state.routes = {
      "/api/projects/p1/presets": () => ({ presets: [] }),
    };
    await render(
      createElement(
        ToastProvider,
        null,
        createElement(GraphCanvasEditor, {
          workflow: workflowFor(threeNodeGraph),
          drivers: ["opencode"],
        }),
      ),
    );

    for (const id of ["entry", "n1", "exit"]) {
      const wrapper = nodeWrapper(id);
      expect(wrapper.style.visibility).toBe("visible");
    }
    const agentCard = card("n1");
    expect(agentCard.className).toContain(CANVAS_NODE_SIZE_CLASSES.agent.width);
    expect(agentCard.className).toContain(CANVAS_NODE_SIZE_CLASSES.agent.height);
    expect(agentCard.textContent).toContain("Agent n1");
    const exitCard = card("exit");
    expect(exitCard.className).toContain(CANVAS_NODE_SIZE_CLASSES.exit.width);
    expect(exitCard.className).toContain(CANVAS_NODE_SIZE_CLASSES.exit.height);
    expect(exitCard.textContent).toContain("Exit");
    // Pane collapse insurance: the canvas pane keeps an explicit min-height.
    const pane = document.querySelector("[data-canvas-canvas]");
    expect(pane?.className).toContain("min-h-[480px]");
  });
});

describe("sub-workflow node card (#117)", () => {
  it("paints with the agent-size token, shows the workflow name from the names context, both handles", async () => {
    await render(
      createElement(
        ReactFlowProvider,
        null,
        createElement(
          WorkflowNamesContext.Provider,
          { value: new Map([["wf-child", "Child flow"]]) },
          createElement(ReactFlow, {
            nodes: toFlowNodes([subworkflowNode]),
            edges: [] as unknown as Edge[],
            nodeTypes: canvasNodeTypes,
            fitView: true,
          }),
        ),
      ),
    );
    for (let i = 0; i < 12; i += 1) {
      await act(async () => {});
    }
    const wrapper = nodeWrapper("sub");
    expect(wrapper.style.visibility).toBe("visible");
    const el = card("sub");
    expect(el.getAttribute("data-canvas-node")).toBe("subworkflow");
    expect(el.className).toContain(CANVAS_NODE_SIZE_CLASSES.subworkflow.width);
    expect(el.className).toContain(CANVAS_NODE_SIZE_CLASSES.subworkflow.height);
    expect(el.textContent).toContain("Spawn");
    // The referenced workflow renders by NAME (resolved via context), with
    // the latest/pin badge.
    expect(el.textContent).toContain("Child flow");
    expect(el.textContent).toContain("latest");
    expect(handleCount("sub", "source")).toBe(1);
    expect(handleCount("sub", "target")).toBe(1);
  });

  it("falls back to the raw workflow id when no name resolves; pinned revision shows rev N", async () => {
    await render(
      createElement(
        ReactFlowProvider,
        null,
        createElement(ReactFlow, {
          nodes: toFlowNodes([
            {
              ...subworkflowNode,
              data: {
                ...subworkflowNode.data,
                kind: "subworkflow" as const,
                config: { workflowId: "wf-unknown", revision: 2 },
              },
            },
          ]),
          edges: [] as unknown as Edge[],
          nodeTypes: canvasNodeTypes,
          fitView: true,
        }),
      ),
    );
    for (let i = 0; i < 12; i += 1) {
      await act(async () => {});
    }
    const el = card("sub");
    expect(el.textContent).toContain("wf-unknown");
    expect(el.textContent).toContain("rev 2");
  });
});
