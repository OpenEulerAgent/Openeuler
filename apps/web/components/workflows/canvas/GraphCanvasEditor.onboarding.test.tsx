// @vitest-environment jsdom
//
// Canvas onboarding (#77): coach hints render from the pure hint machine,
// auto-hide when their condition clears, and persist per-hint dismissal in
// localStorage (`openeuler.canvasHints`); the header "rev N" chip opens the
// revision-history drawer (fetched from the daemon), "View" loads a
// revision snapshot into the read-only render (no editing affordances),
// and Back-to-editor returns to the editing canvas with dirty state intact.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import type { WorkflowGraph } from "@openeuler/core";
import { CANVAS_HINTS_STORAGE_KEY } from "@/lib/graph/canvas-hints";
import { GraphCanvasEditor } from "./GraphCanvasEditor";
import type { WorkflowWithGraph } from "@/lib/workflows-api";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

// React Flow v12 requires browser APIs jsdom lacks.
beforeEach(() => {
  window.localStorage.clear();
  (globalThis as Record<string, unknown>)["ResizeObserver"] = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as Record<string, unknown>)["DOMMatrixReadOnly"] = class DOMMatrixReadOnly {
    m22 = 1;
  };
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    (globalThis as Record<string, unknown>)["crypto"] = {
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

/** The editing canvas: a fresh one-entry-node graph. */
const entryNode: WorkflowGraph["nodes"][number] = {
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
};

const currentGraph: WorkflowGraph = {
  entryNodeId: "entry",
  nodes: [entryNode],
  edges: [],
};

/** Revision 1's snapshot: entry wired to a second agent (2 nodes, 1 edge). */
const revision1Graph: WorkflowGraph = {
  entryNodeId: "entry",
  nodes: [
    entryNode,
    {
      id: "second",
      type: "agent",
      name: "Reviewer",
      position: { x: 400, y: 160 },
      config: {
        driver: "opencode",
        mode: "auto",
        promptTemplate: "Review: {{task}}",
        continueSession: false,
      },
    },
  ],
  edges: [
    {
      id: "e-entry-second",
      source: "entry",
      target: "second",
      condition: { type: "always" },
    },
  ],
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
  latestRevision: { id: "r2", number: 2 },
  graph: currentGraph,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const renderEditor = (): void => {
  apiMock.state.routes = {
    "/api/projects/p1/presets": () => ({ presets: [] }),
    "/api/workflows/w1/revisions/1": () => ({
      revision: { id: "r1", number: 1, graph: revision1Graph },
    }),
    "/api/workflows/w1/revisions": () => ({
      revisions: [
        { id: "r1", number: 1, createdAt: "2026-10-01T09:00:00Z" },
        { id: "r2", number: 2, createdAt: "2026-10-01T12:00:00Z" },
      ],
    }),
  };
  apiMock.state.calls = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(
        ToastProvider,
        null,
        createElement(GraphCanvasEditor, { workflow, drivers: ["opencode"] }),
      ),
    );
  });
};

const text = (): string => document.body.textContent ?? "";

const getSubmittedPaths = (): string[] =>
  apiMock.state.calls.filter((call) => !call.init?.method).map((call) => call.path);

/** Types into a controlled textarea the way a real keystroke would. */
const setTextAreaValue = (area: HTMLTextAreaElement, value: string): void => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

/** Dirties the doc through a valid prompt edit on the entry node. */
const editEntryPrompt = (value: string): void => {
  const card = document.querySelector(
    '.react-flow__node[data-id="entry"] [data-canvas-node="agent"]',
  );
  if (card === null) throw new Error("entry card not found");
  act(() => {
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  const prompt = document.querySelector<HTMLTextAreaElement>("#node-prompt");
  if (prompt === null) throw new Error("prompt textarea not found");
  setTextAreaValue(prompt, value);
};

const coachHint = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-canvas-hint]");

const dismissCoachHint = (): void => {
  const card = coachHint();
  if (card === null) throw new Error("no coach hint to dismiss");
  const button = card.querySelector<HTMLButtonElement>("button[aria-label^='Dismiss hint:']");
  if (button === null) throw new Error("dismiss button not found");
  act(() => {
    button.click();
  });
};

const addAgentFromPalette = (): void => {
  const item = document.querySelector<HTMLElement>("[aria-label='Add Agent step']");
  if (item === null) throw new Error("palette agent item not found");
  act(() => {
    item.click();
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

describe("GraphCanvasEditor onboarding coach hints (#77)", () => {
  it("shows the drag hint on a fresh canvas, dismisses it, and persists the dismissal", async () => {
    renderEditor();
    await act(async () => {});

    // Fresh canvas (entry node only): the drag coach card, alongside the
    // static top-center empty-state card (different copy, same message).
    const hint = coachHint();
    expect(hint?.dataset.canvasHint).toBe("drag");
    expect(hint?.textContent).toContain("Drag an Agent step from the palette");
    expect(text()).toContain("Start building your graph");
    expect(window.localStorage.getItem(CANVAS_HINTS_STORAGE_KEY)).toBeNull();

    dismissCoachHint();
    await act(async () => {});

    expect(coachHint()).toBeNull();
    expect(window.localStorage.getItem(CANVAS_HINTS_STORAGE_KEY)).toBe('["drag"]');
  });

  it("hides dismissed hints on a fresh render (localStorage round-trip)", async () => {
    window.localStorage.setItem(CANVAS_HINTS_STORAGE_KEY, '["drag"]');
    renderEditor();
    await act(async () => {});

    // One entry node: only the drag hint could apply, and it was dismissed.
    expect(coachHint()).toBeNull();
  });

  it("auto-hides the drag hint when a second node lands, then coaches connect", async () => {
    renderEditor();
    await act(async () => {});

    addAgentFromPalette();
    await act(async () => {});

    const hint = coachHint();
    expect(hint?.dataset.canvasHint).toBe("connect");
    expect(hint?.textContent).toContain("Drag from a node's handle to connect the flow");
    // The connect hint dismisses and persists alongside any prior ids.
    dismissCoachHint();
    await act(async () => {});
    expect(coachHint()?.dataset.canvasHint).toBe("configure");
    expect(window.localStorage.getItem(CANVAS_HINTS_STORAGE_KEY)).toBe('["connect"]');

    // Configuring any prompt clears the last hint — graduation.
    const prompt = document.querySelector<HTMLTextAreaElement>("#node-prompt");
    if (prompt === null) throw new Error("prompt textarea not found");
    setTextAreaValue(prompt, "Custom instructions: {{task}}");
    await act(async () => {});
    expect(coachHint()).toBeNull();
  });
});

describe("GraphCanvasEditor revision history (#77)", () => {
  it("the rev chip opens the drawer listing revisions with the current one badged", async () => {
    renderEditor();
    await act(async () => {});

    const chip = document.querySelector<HTMLButtonElement>("[data-revision-chip]");
    expect(chip?.textContent?.trim()).toBe("rev 2");
    act(() => {
      chip?.click();
    });
    await act(async () => {});

    // The drawer fetched the list from the daemon.
    expect(getSubmittedPaths()).toContain("/api/workflows/w1/revisions");
    const drawer = document.querySelector('[role="dialog"][aria-label="Revision history"]');
    expect(drawer).not.toBeNull();
    const row1 = drawer?.querySelector('[data-revision-row="1"]');
    const row2 = drawer?.querySelector('[data-revision-row="2"]');
    expect(row1).not.toBeNull();
    expect(row2).not.toBeNull();
    // Newest first, "current" only on the editor's revision (2).
    expect(
      drawer?.querySelectorAll("[data-revision-row]")[0]?.getAttribute("data-revision-row"),
    ).toBe("2");
    expect(row2?.textContent).toContain("current");
    expect(row1?.textContent).not.toContain("current");

    // Close via the drawer's Close button.
    const close = [...(drawer?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Close",
    );
    act(() => {
      close?.click();
    });
    await act(async () => {});
    expect(document.querySelector('[role="dialog"][aria-label="Revision history"]')).toBeNull();
  });

  it("View loads a read-only snapshot; Back returns to the editor with dirty state intact", async () => {
    renderEditor();
    await act(async () => {});

    // Dirty the canvas BEFORE leaving for the snapshot view.
    editEntryPrompt(" Edited: {{task}}");
    expect(document.querySelector("[data-save-status='unsaved']")).not.toBeNull();

    // Open the drawer and view revision 1 (a 2-node, 1-edge snapshot).
    act(() => {
      document.querySelector<HTMLButtonElement>("[data-revision-chip]")?.click();
    });
    await act(async () => {});
    const view = document.querySelector<HTMLButtonElement>(
      '[data-revision-row="1"] button[aria-label="View revision 1"]',
    );
    if (view === null) throw new Error("view button not found");
    act(() => {
      view.click();
    });
    await act(async () => {});

    // The snapshot endpoint was hit and the drawer closed.
    expect(getSubmittedPaths()).toContain("/api/workflows/w1/revisions/1");
    expect(document.querySelector('[role="dialog"][aria-label="Revision history"]')).toBeNull();

    // Read-only render: the revision bar + the snapshot's two nodes.
    const readOnly = document.querySelector("[data-readonly-revision='1']");
    expect(readOnly).not.toBeNull();
    expect(text()).toContain("Viewing revision 1 — read-only");
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(2);
    expect(text()).toContain("Reviewer");

    // No editing affordances: the palette (and its add items) are gone and
    // the editing canvas pane is unmounted.
    expect(document.querySelector("[data-palette-section='steps']")).toBeNull();
    expect(document.querySelector("[aria-label='Add Agent step']")).toBeNull();
    expect(document.querySelector("[data-canvas-canvas]")).toBeNull();
    expect(document.querySelector("#node-prompt")).toBeNull();

    // Back to editor: the editing canvas returns with the dirty edit intact.
    const back = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Back to editor",
    );
    if (back === undefined) throw new Error("back button not found");
    act(() => {
      back.click();
    });
    await act(async () => {});

    expect(document.querySelector("[data-readonly-revision]")).toBeNull();
    expect(document.querySelector("[data-canvas-canvas]")).not.toBeNull();
    expect(document.querySelector("[aria-label='Add Agent step']")).not.toBeNull();
    expect(document.querySelector("[data-save-status='unsaved']")).not.toBeNull();

    // The edited prompt survived the round-trip through the snapshot view.
    editEntryPrompt(" Edited: {{task}}"); // reopens the inspector
    const prompt = document.querySelector<HTMLTextAreaElement>("#node-prompt");
    expect(prompt?.value).toBe(" Edited: {{task}}");
  });
});
