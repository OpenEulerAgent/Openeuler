// @vitest-environment jsdom
//
// Save clean-gate (#71): a clean doc must never mint a redundant revision.
// The Save button disables (with a "No changes to save" title/aria-label),
// cmd+s on a clean doc issues NO PUT and shows no success toast, a valid
// edit re-enables the button, and after the save lands the button disables
// again — further cmd+s presses stay no-ops.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import type { WorkflowGraph } from "@openeuler/core";
import { GraphCanvasEditor } from "./GraphCanvasEditor";
import type { WorkflowWithGraph } from "@/lib/workflows-api";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

// React Flow v12 requires browser APIs jsdom lacks.
beforeEach(() => {
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

const text = (): string => container?.textContent ?? "";

const saveButton = (): HTMLButtonElement => {
  const save = [...document.querySelectorAll<HTMLButtonElement>("header button")].find(
    (button) => button.textContent?.trim() === "Save",
  );
  if (save === undefined) throw new Error("save button not found");
  return save;
};

const graphPutCount = (): number =>
  apiMock.state.calls.filter(
    (call) => call.path.includes("/graph") && call.init?.method === "PUT",
  ).length;

/** The editor listens on window for ⌘/Ctrl+S. */
const pressSaveShortcut = (meta: boolean): void => {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        metaKey: meta,
        ctrlKey: !meta,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
};

/** Types into a controlled textarea the way a real keystroke would. */
const setTextAreaValue = (area: HTMLTextAreaElement, value: string): void => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

/** Dirties the doc through a valid prompt edit on the entry node. */
const editEntryPrompt = (value: string): void => {
  const card = document.querySelector('.react-flow__node[data-id="entry"] [data-canvas-node="agent"]');
  if (card === null) throw new Error("entry card not found");
  act(() => {
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  const prompt = document.querySelector<HTMLTextAreaElement>("#node-prompt");
  if (prompt === null) throw new Error("prompt textarea not found");
  setTextAreaValue(prompt, value);
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

describe("GraphCanvasEditor save clean-gate (#71)", () => {
  it("a clean doc disables Save (with explanation) and cmd+s issues no PUT", async () => {
    renderEditor();

    // Pristine render: disabled-by-clean with the explanatory title/label.
    const button = saveButton();
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("No changes to save");
    expect(button.getAttribute("aria-label")).toBe("No changes to save");

    // cmd+s (both spellings) is a silent no-op: no request, no toast.
    pressSaveShortcut(true);
    pressSaveShortcut(false);
    await act(async () => {});
    expect(graphPutCount()).toBe(0);
    expect(text()).not.toContain("Saved revision");

    // Clicking the disabled button is equally inert.
    act(() => {
      saveButton().click();
    });
    await act(async () => {});
    expect(graphPutCount()).toBe(0);
    expect(text()).not.toContain("Saved revision");
  });

  it("a dirty doc enables Save; after the save lands it disables again", async () => {
    renderEditor();

    // A valid inspector edit flips dirty: enabled, actionable title.
    editEntryPrompt("work: {{task}}");
    const button = saveButton();
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("Save (⌘/Ctrl+S)");

    // cmd+s saves: exactly one PUT, success toast, revision badge.
    pressSaveShortcut(true);
    await act(async () => {});
    expect(graphPutCount()).toBe(1);
    expect(text()).toContain("Saved revision 2");

    // Dirty flipped false: disabled-by-clean again, and further cmd+s
    // presses (or clicks) mint no second revision.
    const settled = saveButton();
    expect(settled.disabled).toBe(true);
    expect(settled.title).toBe("No changes to save");
    pressSaveShortcut(true);
    act(() => {
      saveButton().click();
    });
    await act(async () => {});
    expect(graphPutCount()).toBe(1);
  });
});
