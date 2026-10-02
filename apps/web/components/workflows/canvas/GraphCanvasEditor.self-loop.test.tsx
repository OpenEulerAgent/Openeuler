// @vitest-environment jsdom
//
// Self-loop guided creation (#73): dragging a handle onto the node's own
// handle creates a BORN-CONDITIONAL edge (an unconditional self-loop is an
// unconditional cycle the schema rejects), the edge drawer opens focused on
// the pattern input, the toast explains the repeat-while semantics, the
// placeholder blocks saving until the condition is set — then the save
// round-trips the self-loop with its condition into the revision.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
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
  // Click-to-connect resolves the drop target through elementFromPoint;
  // a null return makes React Flow use the clicked handle's own node.
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

// entry → review → exit, all `always`: drawing a handle onto `review`
// itself is a second outgoing edge — the self-loop must still be born
// conditional with the self-loop hint, not the router-fallback copy.
const graph: WorkflowGraph = {
  entryNodeId: "entry",
  nodes: [agentNode("entry", 0), agentNode("review", 320), agentNode("fix", 640)],
  edges: [
    { id: "e-entry-review", source: "entry", target: "review", condition: { type: "always" } },
    { id: "e-review-fix", source: "review", target: "fix", condition: { type: "always" } },
  ],
};

const workflow: WorkflowWithGraph = {
  id: "w1",
  projectId: "p1",
  name: "Self-loop workflow",
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

describe("GraphCanvasEditor self-loop guided creation (#73)", () => {
  it("drawing a self-loop creates a conditional edge, opens the drawer focused, hints via toast, then saves and round-trips", async () => {
    renderEditor();
    expect(panel()).toBeNull();

    // Handle onto the node's own handle: a self-loop.
    connectHandles("review", "review");

    // The self-loop hint toast (not the router-fallback copy).
    expect(text()).toContain("Self-loop added as conditional");
    expect(text()).toContain("A self-loop repeats this node while its condition holds");
    expect(text()).not.toContain("Edge added as conditional");

    // The loop edge is selected: its drawer is open, pattern input focused.
    const pattern = document.querySelector<HTMLInputElement>("#edge-pattern");
    expect(pattern).not.toBeNull();
    expect(document.activeElement).toBe(pattern);
    expect(bodyText()).toContain("review → review");

    // Canvas chip: the attention call-to-action, never `contains ""`.
    expect(bodyText()).toContain("set condition…");
    expect(bodyText()).not.toContain('contains ""');

    // The placeholder blocks saving; the message names the loop.
    clickSave();
    await act(async () => {});
    expect(text()).toContain("Cannot save yet");
    expect(text()).toContain("Set a condition on review → review.");
    expect(graphPut()).toBeUndefined();

    // Fill the pattern: chip + panel clear LIVE, without any save.
    const patternInput = document.querySelector<HTMLInputElement>("#edge-pattern");
    if (patternInput === null) throw new Error("pattern input vanished");
    setInputValue(patternInput, "RETRY");
    expect(panel()).toBeNull();
    expect(bodyText()).not.toContain("set condition…");

    // Save succeeds; the self-loop rides into the revision with its
    // condition (a conditional cycle is legal).
    clickSave();
    await act(async () => {});
    const put = graphPut();
    expect(put).toBeDefined();
    const body = JSON.parse(String(put?.init?.body)) as { graph: WorkflowGraph };
    const savedLoop = body.graph.edges.find((edge) => edge.id === "e-review-review");
    expect(savedLoop).toMatchObject({
      source: "review",
      target: "review",
      condition: { type: "outputContains", pattern: "RETRY" },
    });
    expect(text()).toContain("Saved revision 2");

    // Round-trip: the saved revision reloads with the loop + condition.
    const after = document.querySelector<HTMLInputElement>("#edge-pattern");
    expect(after?.value).toBe("RETRY");
    expect(bodyText()).toContain('contains "RETRY"');
  });

  it("a self-loop on a node with no other outgoing edge is born conditional too", () => {
    renderEditor();

    connectHandles("fix", "fix");

    expect(text()).toContain("Self-loop added as conditional");
    const pattern = document.querySelector<HTMLInputElement>("#edge-pattern");
    expect(pattern).not.toBeNull();
    expect(document.activeElement).toBe(pattern);
    // The loop is the only conditional on `fix`: no fallback was converted,
    // the loop itself is the placeholder.
    expect(bodyText()).toContain("set condition…");
  });
});
