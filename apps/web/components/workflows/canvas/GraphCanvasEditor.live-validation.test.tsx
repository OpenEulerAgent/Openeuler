// @vitest-environment jsdom
//
// Live canvas validation (#68): the real editor renders React Flow in jsdom
// and the whole interactive loop is exercised — palette drop → immediate
// amber hint (unreachable) with NO prompt blocker (prefilled {{task}}
// default), connect via handle clicks → hint clears and save succeeds,
// save attempt with hint-only issues stays blocked, and a manually cleared
// prompt turns into a live red blocker. Nothing here needs a save attempt
// for findings to appear.

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
  // React Flow's click-to-connect resolves the drop target through
  // elementFromPoint; jsdom lacks it, and a null return makes React Flow
  // fall back to the clicked handle's own data-id (what we want).
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

// Hoisted so the vi.mock factory can close over it without init-order issues.
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
  render(createElement(ToastProvider, null, createElement(GraphCanvasEditor, { workflow, drivers: ["opencode"] })));
};

const text = (): string => container?.textContent ?? "";
const panel = (): HTMLElement | null => document.querySelector("[data-validation-panel]");
const agentCards = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('[data-canvas-node="agent"]')];
const nodeIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")].map(
    (node) => node.getAttribute("data-id") as string,
  );

/** The palette-dropped node's id: the agent node that is not the entry. */
const droppedNodeId = (): string => nodeIds().find((id) => id !== "entry") as string;

const click = (el: Element | null | undefined): void => {
  if (el === null || el === undefined) throw new Error("click target not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

const addAgentFromPalette = (): void => {
  click(document.querySelector('[aria-label="Add Agent step"]'));
};

const clickSave = (): void => {
  const save = [...document.querySelectorAll<HTMLButtonElement>("header button")].find((button) =>
    button.textContent?.trim() === "Save",
  );
  if (save === undefined) throw new Error("save button not found");
  act(() => {
    save.click();
  });
};

/** Click-to-connect two nodes through React Flow handles (source, then target). */
const connectHandles = (sourceNodeId: string, targetNodeId: string): void => {
  click(
    document.querySelector(
      `.react-flow__handle.source[data-nodeid="${sourceNodeId}"]`,
    ),
  );
  click(
    document.querySelector(
      `.react-flow__handle.target[data-nodeid="${targetNodeId}"]`,
    ),
  );
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

describe("GraphCanvasEditor live validation (#68)", () => {
  it("a pristine doc shows no findings; a palette drop immediately shows the unreachable hint and NO prompt blocker", () => {
    renderEditor();

    // Pristine single-entry doc: valid, so no panel at all.
    expect(panel()).toBeNull();
    expect(agentCards()).toHaveLength(1);

    addAgentFromPalette();

    // Node landed and was auto-selected (drawer opens for it).
    expect(agentCards()).toHaveLength(2);
    const dropped = droppedNodeId();
    expect(dropped).toBeDefined();

    // Live hint BEFORE any save attempt: 1 hint, connect-me copy, no blockers.
    expect(panel()).not.toBeNull();
    expect(text()).toContain("1 hint — fix to save");
    expect(text()).toContain("Connect this node to the flow");
    expect(text()).not.toContain("blocker");
    // The prefilled {{task}} prompt means no promptTemplate complaint.
    expect(text()).not.toContain("promptTemplate must be a non-empty string");

    // The dropped node carries an amber hint badge; the entry carries none.
    const droppedCard = document.querySelector(
      `.react-flow__node[data-id="${dropped}"] [data-issue-badges]`,
    );
    expect(droppedCard?.querySelector('[aria-label="1 validation hint"]')).not.toBeNull();
    expect(droppedCard?.querySelector('[aria-label^="1 validation blocker"]')).toBeNull();
    const entryCard = document.querySelector('.react-flow__node[data-id="entry"] [data-issue-badges]');
    expect(entryCard).toBeNull();
  });

  it("save stays blocked while only a hint exists, then succeeds once the node is connected", async () => {
    renderEditor();
    addAgentFromPalette();
    const dropped = droppedNodeId();

    // Hint-only state: save is refused, no graph request leaves the page.
    clickSave();
    await act(async () => {});
    expect(text()).toContain("Cannot save yet");
    expect(text()).toContain("1 hint must be fixed");
    expect(
      apiMock.state.calls.some((call) => call.path.includes("/graph") && call.init?.method === "PUT"),
    ).toBe(false);

    // Connect entry → dropped node via handle clicks: the hint clears live.
    // (The earlier toast may linger; the panel is the live signal.)
    connectHandles("entry", dropped);
    expect(panel()).toBeNull();

    // Now the save goes through: PUT graph + success toast + revision badge.
    clickSave();
    await act(async () => {});
    const put = apiMock.state.calls.find(
      (call) => call.path.includes("/graph") && call.init?.method === "PUT",
    );
    expect(put).toBeDefined();
    expect(text()).toContain("Saved revision 2");
  });

  it("clearing the prefilled prompt turns into a live red blocker", async () => {
    renderEditor();
    addAgentFromPalette();
    const dropped = droppedNodeId();
    connectHandles("entry", dropped);
    expect(panel()).toBeNull();

    // Open the node's drawer by clicking its card, then clear the prompt.
    click(document.querySelector(`.react-flow__node[data-id="${dropped}"] [data-canvas-node="agent"]`));
    const prompt = document.querySelector<HTMLTextAreaElement>("#node-prompt");
    if (prompt === null) throw new Error("prompt textarea not found");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(prompt, "");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Blocker appears LIVE (no save attempt): red badge + panel grouping.
    expect(text()).toContain("1 blocker — fix to save");
    expect(text()).toContain("promptTemplate must be a non-empty string");
    const droppedCard = document.querySelector(
      `.react-flow__node[data-id="${dropped}"] [data-issue-badges]`,
    );
    expect(droppedCard?.querySelector('[aria-label="1 validation blocker"]')).not.toBeNull();

    // And the save is blocked again, still without a request.
    clickSave();
    await act(async () => {});
    expect(text()).toContain("Cannot save yet");
    expect(text()).toContain("1 blocker must be fixed");
    expect(
      apiMock.state.calls.some((call) => call.path.includes("/graph") && call.init?.method === "PUT"),
    ).toBe(false);
  });

  it("clicking a hint row focuses the offending node (drawer opens)", () => {
    renderEditor();
    addAgentFromPalette();
    const dropped = droppedNodeId();

    const hintRow = document.querySelector("[data-validation-hints] button");
    if (hintRow === null) throw new Error("hint row not found");
    click(hintRow);

    // Focus selects the node: the inspector drawer opens for it.
    expect(document.querySelector("#node-prompt")).not.toBeNull();
    expect(text()).toContain("Agent step");
    void dropped;
  });
});
