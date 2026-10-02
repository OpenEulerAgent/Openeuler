// @vitest-environment jsdom
//
// Guided edge-condition flow (#69): connecting a node's second outgoing
// edge auto-converts it to a conditional placeholder — the new edge is
// selected, its drawer opens focused on the pattern input, the canvas chip
// reads "set condition…", the save-block message names the edge by its
// source → target, and filling the pattern clears the amber chip live and
// unblocks the save (with the condition surviving the revision round-trip).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import type { WorkflowGraph } from "@openeuler/core";
import { GraphCanvasEditor } from "./GraphCanvasEditor";
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

const agentNode = (id: string, x: number): WorkflowGraph["nodes"][number] => ({
  id,
  type: "agent",
  name: id,
  position: { x, y: 0 },
  config: {
    driver: "opencode",
    mode: "auto",
    promptTemplate: "work: {{task}}",
    continueSession: false,
  },
});

// entry → review → fix → exit, all `always`: a valid chain whose `review`
// node still holds its router fallback when a second outgoing edge lands.
const graph: WorkflowGraph = {
  entryNodeId: "entry",
  nodes: [
    agentNode("entry", 0),
    agentNode("review", 320),
    agentNode("fix", 640),
    { id: "exit", type: "exit", name: "Exit", position: { x: 960, y: 0 } },
  ],
  edges: [
    { id: "e-entry-review", source: "entry", target: "review", condition: { type: "always" } },
    { id: "e-review-fix", source: "review", target: "fix", condition: { type: "always" } },
    { id: "e-fix-exit", source: "fix", target: "exit", condition: { type: "always" } },
  ],
};

const workflow: WorkflowWithGraph = {
  id: "w1",
  projectId: "p1",
  name: "Router workflow",
  steps: ["entry", "review", "fix"].map((id) => ({
    id,
    name: id,
    driver: "opencode",
    mode: "auto" as const,
    promptTemplate: "work: {{task}}",
    continueSession: false,
  })),
  latestRevision: { id: "r1", number: 1 },
  graph,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (element: ReactElement): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
};

const renderEditor = (): void => {
  apiMock.state.routes = {
    "/api/projects/p1/presets": () => ({ presets: [] }),
    "/api/workflows/w1/graph": (init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { graph: WorkflowGraph };
      return {
        workflow: { ...workflow, graph: body.graph },
        revision: { id: "r2", number: 2 },
      };
    },
  };
  apiMock.state.calls = [];
  render(
    createElement(
      ToastProvider,
      null,
      createElement(GraphCanvasEditor, { workflow, drivers: ["opencode"] }),
    ),
  );
};

const text = (): string => container?.textContent ?? "";
/** Drawer content portals into document.body, not the editor container. */
const bodyText = (): string => document.body.textContent ?? "";
const panel = (): HTMLElement | null => document.querySelector("[data-validation-panel]");

const click = (el: Element | null | undefined): void => {
  if (el === null || el === undefined) throw new Error("click target not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

const clickSave = (): void => {
  const save = [...document.querySelectorAll<HTMLButtonElement>("header button")].find(
    (button) => button.textContent?.trim() === "Save",
  );
  if (save === undefined) throw new Error("save button not found");
  act(() => {
    save.click();
  });
};

/** Click-to-connect two nodes through React Flow handles (source, then target). */
const connectHandles = (sourceNodeId: string, targetNodeId: string): void => {
  click(document.querySelector(`.react-flow__handle.source[data-nodeid="${sourceNodeId}"]`));
  click(document.querySelector(`.react-flow__handle.target[data-nodeid="${targetNodeId}"]`));
};

/** Types into a controlled input the way a real keystroke would. */
const setInputValue = (input: HTMLInputElement, value: string): void => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const graphPut = (): { path: string; init: RequestInit | undefined } | undefined =>
  apiMock.state.calls.find((call) => call.path.includes("/graph") && call.init?.method === "PUT");

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  apiMock.state.routes = {};
});

describe("GraphCanvasEditor guided edge-condition flow (#69)", () => {
  it("a converted edge is selected + drawer-focused, blocks save by name, then clears live and round-trips", async () => {
    renderEditor();
    expect(panel()).toBeNull();

    // Second outgoing edge on `review` → born conditional (empty pattern).
    connectHandles("review", "exit");

    expect(text()).toContain("Edge added as conditional");

    // The edge is selected: its drawer is open, pattern input focused.
    const pattern = document.querySelector<HTMLInputElement>("#edge-pattern");
    expect(pattern).not.toBeNull();
    expect(document.activeElement).toBe(pattern);
    expect(bodyText()).toContain("review → Exit");

    // Canvas chip: the attention call-to-action, never `contains ""`.
    expect(bodyText()).toContain("set condition…");
    expect(bodyText()).not.toContain('contains ""');

    // Live hint (#68) names the edge via the "source → target" badge.
    expect(text()).toContain("Set a condition on this edge");

    // Save is blocked and the message calls the edge out by name.
    clickSave();
    await act(async () => {});
    expect(text()).toContain("Cannot save yet");
    expect(text()).toContain("Set a condition on review → Exit.");
    expect(graphPut()).toBeUndefined();

    // Fill the pattern: amber chip + panel clear LIVE, without any save.
    const patternInput = document.querySelector<HTMLInputElement>("#edge-pattern");
    if (patternInput === null) throw new Error("pattern input vanished");
    setInputValue(patternInput, "LGTM");
    expect(panel()).toBeNull();
    expect(bodyText()).not.toContain("set condition…");

    // Save now succeeds and the condition rides into the revision.
    clickSave();
    await act(async () => {});
    const put = graphPut();
    expect(put).toBeDefined();
    const body = JSON.parse(String(put?.init?.body)) as { graph: WorkflowGraph };
    const savedEdge = body.graph.edges.find((edge) => edge.id === "e-review-exit");
    expect(savedEdge?.condition).toEqual({ type: "outputContains", pattern: "LGTM" });
    expect(text()).toContain("Saved revision 2");

    // Round-trip: the saved revision reloads into the doc with the condition.
    const after = document.querySelector<HTMLInputElement>("#edge-pattern");
    expect(after?.value).toBe("LGTM");
    expect(bodyText()).toContain('contains "LGTM"');
  });

  it("merely selecting the router node converts nothing and opens no edge drawer", () => {
    renderEditor();
    click(document.querySelector('.react-flow__node[data-id="review"] [data-canvas-node="agent"]'));

    expect(document.querySelector("#node-prompt")).not.toBeNull();
    expect(document.querySelector("#edge-pattern")).toBeNull();
    expect(text()).not.toContain("Edge added as conditional");
    expect(panel()).toBeNull();
  });

  it("daemon 422 findings supplement live validation and drop on the next doc change", async () => {
    renderEditor();
    apiMock.state.routes["/api/workflows/w1/graph"] = () => {
      throw new ApiError("VALIDATION_ERROR", "The daemon rejected the graph", 422, {
        details: [
          { path: "graph.nodes.1.config.driver", message: 'driver "ghost" is not available' },
        ],
      });
    };

    clickSave();
    await act(async () => {});
    expect(text()).toContain("The daemon rejected the graph");
    expect(panel()).not.toBeNull();
    expect(text()).toContain('driver "ghost" is not available');

    // Any doc change (a selection here) clears the daemon supplement in the
    // same render — the live mirror of this doc is clean, panel gone at once.
    click(document.querySelector('.react-flow__node[data-id="review"] [data-canvas-node="agent"]'));
    expect(panel()).toBeNull();
  });
});
