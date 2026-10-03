// @vitest-environment jsdom
//
// Canvas interaction polish (#72): zoom Controls render bottom-right (never
// under the bottom-left ValidationPanel, with or without issues), the
// "Your team" roster shows skeleton rows while its fetch is in flight and
// an early preset drop/click toasts instead of no-op'ing, an add that
// lands outside the visible viewport triggers fitView on the new node, and
// click-to-add centers on the CANVAS pane's rect (not the window).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import type { AgentPreset, WorkflowGraph } from "@openeuler/core";
import { GraphCanvasEditor } from "./GraphCanvasEditor";
import { CANVAS_NODE_MIME, CANVAS_PRESET_MIME } from "./Palette";
import type { WorkflowWithGraph } from "@/lib/workflows-api";

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
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    (globalThis as Record<string, unknown>).crypto = {
      randomUUID: () => Math.random().toString(36).slice(2),
    };
  }
  if (typeof document.elementFromPoint !== "function") {
    document.elementFromPoint = () => null;
  }
});

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
}));

// The editor's useReactFlow() surface, mocked so tests can pan the
// viewport, capture fitView calls, and observe screenToFlowPosition args.
// Everything else from @xyflow/react (ReactFlow, provider, Controls, …)
// stays real — only the consumer-facing hook is swapped.
const flowMock = vi.hoisted(() => {
  const state = {
    viewport: { x: 0, y: 0, zoom: 1 },
    fitView: vi.fn(),
    screenToFlowPosition: vi.fn((point: { x: number; y: number }) => ({ ...point })),
    getViewport: () => ({ ...state.viewport }),
  };
  return state;
});

vi.mock("@xyflow/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@xyflow/react")>();
  return { ...original, useReactFlow: () => flowMock };
});

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

const graph: WorkflowGraph = {
  entryNodeId: "entry",
  nodes: [
    {
      id: "entry",
      type: "agent",
      name: "Agent",
      position: { x: 80, y: 160 },
      config: {
        driver: "opencode",
        mode: "auto",
        promptTemplate: "{{task}}",
        continueSession: false,
      },
    },
  ],
  edges: [],
};

const workflow: WorkflowWithGraph = {
  id: "w1",
  projectId: "p1",
  name: "Demo workflow",
  steps: [
    {
      id: "entry",
      name: "Agent",
      driver: "opencode",
      mode: "auto",
      promptTemplate: "{{task}}",
      continueSession: false,
    },
  ],
  latestRevision: { id: "r1", number: 1 },
  graph,
};

const rosterPreset: AgentPreset = {
  id: "preset-1",
  projectId: "p1",
  name: "Senior Reviewer",
  description: "Reviews everything twice.",
  icon: "🔍",
  config: {
    driver: "opencode",
    mode: "auto",
    promptTemplate: "Review twice: {{task}}",
    continueSession: false,
  },
  builtin: true,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (element: ReactElement): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
};

const renderEditor = (presetsRoute: RouteHandler): void => {
  apiMock.state.routes = {
    "/api/projects/p1/presets": presetsRoute,
    "/api/workflows/w1/graph": () => ({}),
  };
  apiMock.state.calls = [];
  flowMock.viewport = { x: 0, y: 0, zoom: 1 };
  flowMock.fitView.mockClear();
  flowMock.screenToFlowPosition.mockClear();
  render(
    createElement(
      ToastProvider,
      null,
      createElement(GraphCanvasEditor, { workflow, drivers: ["opencode"] }),
    ),
  );
};

const text = (): string => container?.textContent ?? "";
const nodeIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")].map(
    (node) => node.getAttribute("data-id") as string,
  );

const click = (el: Element | null | undefined): void => {
  if (el === null || el === undefined) throw new Error("click target not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

const addAgentFromPalette = (): void => {
  click(document.querySelector('[aria-label="Add Agent step"]'));
};

/**
 * jsdom gives every element a zero rect; the interaction math needs the
 * real editor layout (240px palette left, 4rem header above).
 */
const stubCanvasRect = (): void => {
  const pane = document.querySelector<HTMLElement>("[data-canvas-canvas]");
  if (pane === null) throw new Error("canvas pane not found");
  pane.getBoundingClientRect = () =>
    ({
      left: 240,
      top: 64,
      right: 1040,
      bottom: 664,
      width: 800,
      height: 600,
      x: 240,
      y: 64,
      toJSON: () => ({}),
    }) as DOMRect;
};

/** Drop-event with a stubbed dataTransfer carrying the preset MIME. */
const dropPreset = (presetId: string): void => {
  const pane = document.querySelector<HTMLElement>("[data-canvas-canvas]");
  if (pane === null) throw new Error("canvas pane not found");
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      getData: (mime: string) => (mime === CANVAS_PRESET_MIME ? presetId : ""),
    },
  });
  Object.defineProperty(event, "clientX", { value: 600 });
  Object.defineProperty(event, "clientY", { value: 400 });
  act(() => {
    pane.dispatchEvent(event);
  });
};

/** Drop-event carrying a palette node kind (agent / exit / join). */
const dropNode = (kind: string): void => {
  const pane = document.querySelector<HTMLElement>("[data-canvas-canvas]");
  if (pane === null) throw new Error("canvas pane not found");
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      getData: (mime: string) => (mime === CANVAS_NODE_MIME ? kind : ""),
    },
  });
  Object.defineProperty(event, "clientX", { value: 620 });
  Object.defineProperty(event, "clientY", { value: 420 });
  act(() => {
    pane.dispatchEvent(event);
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  apiMock.state.routes = {};
});

describe("GraphCanvasEditor canvas interaction (#72)", () => {
  it("renders zoom Controls bottom-right, clear of the bottom-left ValidationPanel", () => {
    renderEditor(() => ({ presets: [] }));

    // Pristine doc: no panel, Controls already bottom-right.
    const controls = document.querySelector<HTMLElement>('[data-testid="rf__controls"]');
    expect(controls).not.toBeNull();
    expect(controls?.className).toContain("bottom");
    expect(controls?.className).toContain("right");
    expect(controls?.className).not.toContain("left");

    // Issue state: the panel owns bottom-left; Controls stay bottom-right.
    addAgentFromPalette();
    const panel = document.querySelector<HTMLElement>("[data-validation-panel]");
    expect(panel).not.toBeNull();
    expect(panel?.className).toContain("left-3");
    const settled = document.querySelector<HTMLElement>('[data-testid="rf__controls"]');
    expect(settled?.className).toContain("right");
    expect(settled?.className).not.toContain("left");
  });

  it("shows skeleton roster rows while presets fetch, then the roster", async () => {
    let resolveRoster: ((body: { presets: AgentPreset[] }) => void) | undefined;
    renderEditor(
      () =>
        new Promise((resolve) => {
          resolveRoster = resolve;
        }),
    );

    // In flight: skeleton rows, no empty-roster hint, no preset items.
    expect(document.querySelector("[data-palette-skeleton]")).not.toBeNull();
    expect(text()).not.toContain("No presets yet");
    expect(document.querySelector("[data-palette-preset]")).toBeNull();

    await act(async () => {
      resolveRoster?.({ presets: [rosterPreset] });
    });

    expect(document.querySelector("[data-palette-skeleton]")).toBeNull();
    expect(document.querySelector('[data-palette-preset="preset-1"]')).not.toBeNull();
  });

  it("an early preset drop while the roster loads toasts instead of no-op'ing", async () => {
    renderEditor(
      () =>
        new Promise(() => {
          // Never resolves within the test.
        }),
    );
    stubCanvasRect();

    dropPreset("preset-1");

    expect(text()).toContain("Team roster is still loading");
    expect(nodeIds()).toHaveLength(1); // only the pinned entry node

    // Repeated early drops within the dedupe window fire one toast, not a stack.
    dropPreset("preset-1");
    dropPreset("preset-1");
    const viewport = document.querySelector('div[aria-label="Notifications"]');
    const toasts = viewport?.querySelectorAll('[role="status"], [role="alert"]') ?? [];
    expect(toasts.length).toBeLessThanOrEqual(1);
  });

  it("a settled empty roster fails open: skeleton gives way to the empty hint", async () => {
    let rejectRoster: ((cause: Error) => void) | undefined;
    renderEditor(
      () =>
        new Promise((_resolve, reject) => {
          rejectRoster = reject;
        }),
    );
    expect(document.querySelector("[data-palette-skeleton]")).not.toBeNull();

    await act(async () => {
      rejectRoster?.(new Error("daemon offline"));
    });

    expect(document.querySelector("[data-palette-skeleton]")).toBeNull();
    expect(text()).toContain("No presets yet");
  });

  it("an add outside the visible viewport fitViews the new node; in-view adds do not", () => {
    renderEditor(() => ({ presets: [] }));
    stubCanvasRect();

    // Identity viewport shows flow x ∈ [0, 800]: the auto-placed node at
    // x=360 (right of the entry at 80) is in view — no re-framing.
    addAgentFromPalette();
    expect(nodeIds()).toHaveLength(2);
    expect(flowMock.fitView).not.toHaveBeenCalled();

    // Pan 5000 right (visible flow x ∈ [5000, 5800]): the next auto-placed
    // node lands off-screen and scrolls into view (#72).
    flowMock.viewport = { x: -5000, y: 0, zoom: 1 };
    const before = nodeIds();
    addAgentFromPalette();
    expect(nodeIds()).toHaveLength(3);
    const added = nodeIds().find((id) => !before.includes(id));
    expect(added).toBeDefined();
    expect(flowMock.fitView).toHaveBeenCalledTimes(1);
    expect(flowMock.fitView).toHaveBeenCalledWith({
      nodes: [{ id: added }],
      duration: 300,
      maxZoom: 1,
      padding: 0.3,
    });
  });

  it("click-add centers on the canvas pane rect, not the window", async () => {
    renderEditor(() => ({ presets: [rosterPreset] }));
    stubCanvasRect();
    await act(async () => {});

    click(document.querySelector('[data-palette-preset="preset-1"]'));

    // The pane center is (640, 364); the window center in jsdom would be
    // (512, 384). The jittered point must stay within ±40 of the pane
    // center and away from the window center's x.
    const calls = flowMock.screenToFlowPosition.mock.calls as Array<[{ x: number; y: number }]>;
    const drop = calls.at(-1)?.[0];
    expect(drop).toBeDefined();
    expect(Math.abs(drop!.x - 640)).toBeLessThanOrEqual(40);
    expect(Math.abs(drop!.y - 364)).toBeLessThanOrEqual(40);
    expect(Math.abs(drop!.x - 512)).toBeGreaterThan(40);

    // And the preset node actually landed.
    expect(nodeIds()).toHaveLength(2);
    expect(text()).toContain("Senior Reviewer");
  });

  it("palette Join: click and drop create join nodes (mode all); the drawer toggles mode (#116)", async () => {
    renderEditor(() => ({ presets: [] }));
    stubCanvasRect();
    await act(async () => {});

    // The palette carries the Join item in the Steps section.
    const joinItem = document.querySelector('[aria-label="Add Join"]');
    expect(joinItem).not.toBeNull();
    expect(joinItem?.textContent).toContain("Merge parallel branches");

    // Click-to-add: a join node lands with its default mode-all config.
    click(joinItem);
    expect(nodeIds()).toHaveLength(2);
    expect(text()).toContain("join · all");

    // The drawer opened on the fresh join (it portals to document.body,
    // outside the render container): join title + mode toggle, and none
    // of the agent-only fields.
    const drawerText = document.body.textContent ?? "";
    expect(drawerText).toContain("Join node");
    expect(document.querySelector("[data-join-mode]")?.getAttribute("data-join-mode")).toBe("all");
    expect(document.getElementById("node-prompt")).toBeNull();
    expect(document.getElementById("node-driver")).toBeNull();

    // Toggling any patches the doc through the debounced inspector path.
    const anyOption = [...document.querySelectorAll("[data-join-mode] button")].find(
      (button): button is HTMLButtonElement =>
        button instanceof HTMLButtonElement && button.textContent?.includes("any") === true,
    );
    expect(anyOption).toBeDefined();
    act(() => anyOption?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(text()).toContain("join · any");
    expect(document.body.textContent ?? "").toContain("first branch to complete wins");
  });

  it("drag-and-drop of the Join palette item lands a join at the drop point (#116)", async () => {
    renderEditor(() => ({ presets: [] }));
    stubCanvasRect();
    await act(async () => {});

    const before = nodeIds();
    dropNode("join");
    expect(nodeIds()).toHaveLength(before.length + 1);
    expect(text()).toContain("join · all");
    // The drop point (620, 420) was converted through screenToFlowPosition.
    const calls = flowMock.screenToFlowPosition.mock.calls as Array<[{ x: number; y: number }]>;
    expect(calls.at(-1)?.[0]).toEqual({ x: 620, y: 420 });
  });
});
