// @vitest-environment jsdom
//
// Revision conflict guard (#76): the editor pins its known revision as
// expectedRevision on save; a daemon 409 REVISION_CONFLICT opens the
// non-blocking dialog (not a toast). Reload rebases doc/savedDoc/history on
// the server graph and leaves the chip clean; Save anyway re-PUTs WITHOUT
// expectedRevision and lands on revision N+1. A focus probe additionally
// surfaces a dismissible "saved elsewhere" banner.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
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

const graphWithPrompt = (prompt: string): WorkflowGraph => ({
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
        promptTemplate: prompt,
        continueSession: false,
      },
    },
  ],
  edges: [],
});

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
  graph: graphWithPrompt("{{task}}"),
};

/** The revision the daemon considers current while the editor sits on 1. */
const SERVER_REVISION = 3;
const serverGraph = graphWithPrompt("server: {{task}}");

/** PUT bodies captured for /api/workflows/w1/graph. */
const graphPuts: Array<{ graph: WorkflowGraph; expectedRevision?: number }> = [];

/**
 * Graph route: any PUT pinning a revision gets the 409 (the daemon is three
 * revisions ahead); a PUT without the pin saves as revision N+1.
 */
const graphRoute = (): RouteHandler => (init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as {
    graph: WorkflowGraph;
    expectedRevision?: number;
  };
  graphPuts.push(body);
  if (body.expectedRevision !== undefined) {
    throw new ApiError(
      "REVISION_CONFLICT",
      `workflow w1 is at revision ${SERVER_REVISION}, not the expected ${body.expectedRevision}`,
      409,
      { currentRevision: SERVER_REVISION },
    );
  }
  return {
    workflow: { ...workflow, graph: body.graph },
    revision: { id: "r-next", number: SERVER_REVISION + 1 },
  };
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const renderEditor = (): void => {
  apiMock.state.routes = {
    "/api/projects/p1/presets": () => ({ presets: [] }),
    "/api/workflows/w1/graph": graphRoute(),
    "/api/workflows/w1": () => ({
      workflow: {
        ...workflow,
        latestRevision: { id: "r3", number: SERVER_REVISION },
        graph: serverGraph,
      },
    }),
  };
  apiMock.state.calls = [];
  graphPuts.length = 0;
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

/** Dialogs and toasts portal to document.body — read the whole page. */
const text = (): string => document.body.textContent ?? "";

const headerButton = (label: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (button === undefined) throw new Error(`button ${label} not found`);
  return button;
};

const saveButton = (): HTMLButtonElement => headerButton("Save");

const chip = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>("[data-save-status]");
  if (el === null) throw new Error("save status chip not found");
  return el;
};

const clickSave = (): void => {
  act(() => {
    saveButton().click();
  });
};

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

/** Closes any open drawer so the canvas is bare again. */
const closeDrawer = (): void => {
  const close = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Close",
  );
  if (close !== undefined) {
    act(() => {
      close.click();
    });
  }
};

/** Opens the entry node's drawer and returns its prompt textarea value. */
const entryPromptValue = (): string => {
  const card = document.querySelector(
    '.react-flow__node[data-id="entry"] [data-canvas-node="agent"]',
  );
  if (card === null) throw new Error("entry card not found");
  act(() => {
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  const prompt = document.querySelector<HTMLTextAreaElement>("#node-prompt");
  if (prompt === null) throw new Error("prompt textarea not found");
  return prompt.value;
};

const fireVisibilityChange = (): void => {
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
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

describe("GraphCanvasEditor revision conflict (#76)", () => {
  it("a stale save opens the conflict dialog naming both revisions", async () => {
    renderEditor();

    editEntryPrompt("local: {{task}}");
    clickSave();
    await act(async () => {});

    // The PUT pinned the loaded revision; the daemon refused it.
    expect(graphPuts).toHaveLength(1);
    expect(graphPuts[0]?.expectedRevision).toBe(1);
    expect(text()).toContain("Workflow updated elsewhere");
    expect(text()).toContain(`revision ${SERVER_REVISION} is current`);
    expect(text()).toContain("you saved revision 1");
    expect(chip().dataset.saveStatus).toBe("error");

    // The dialog is the explanation — no generic failure toast on top.
    expect(text()).not.toContain("Failed to save");
  });

  it("Reload discards local edits and rebases on the server revision", async () => {
    renderEditor();

    editEntryPrompt("local: {{task}}");
    clickSave();
    await act(async () => {});
    expect(text()).toContain("Workflow updated elsewhere");

    act(() => {
      headerButton("Reload").click();
    });
    await act(async () => {});

    // No second PUT: the conflict was resolved by reloading, not saving.
    expect(graphPuts).toHaveLength(1);
    expect(text()).not.toContain("Workflow updated elsewhere");
    expect(text()).toContain(`Reloaded revision ${SERVER_REVISION}`);

    // The doc is the server's graph again: chip clean, badge on 3, the
    // local prompt edit gone.
    expect(chip().dataset.saveStatus).toBe("clean");
    expect(chip().textContent).toBe("No changes");
    expect(text()).toContain(`revision ${SERVER_REVISION}`);
    closeDrawer();
    expect(entryPromptValue()).toBe("server: {{task}}");
    expect(saveButton().disabled).toBe(true);
  });

  it("Save anyway re-PUTs without expectedRevision and lands on N+1", async () => {
    renderEditor();

    editEntryPrompt("local: {{task}}");
    clickSave();
    await act(async () => {});
    expect(text()).toContain("Workflow updated elsewhere");

    act(() => {
      headerButton("Save anyway").click();
    });
    await act(async () => {});

    // Second PUT forced the save: no revision pin in the body.
    expect(graphPuts).toHaveLength(2);
    expect(graphPuts[1]).not.toHaveProperty("expectedRevision");
    expect(graphPuts[1]?.expectedRevision).toBeUndefined();

    // Normal saved flow: success toast, chip + badge on revision N+1,
    // dialog closed, clean-gate re-armed.
    expect(text()).not.toContain("Workflow updated elsewhere");
    expect(text()).toContain(`Saved revision ${SERVER_REVISION + 1}`);
    expect(chip().dataset.saveStatus).toBe("saved");
    expect(chip().textContent).toBe(`Saved · revision ${SERVER_REVISION + 1}`);
    expect(text()).toContain(`revision ${SERVER_REVISION + 1}`);
    expect(saveButton().disabled).toBe(true);
  });

  it("regaining focus with unsaved edits shows a dismissible saved-elsewhere banner", async () => {
    renderEditor();

    // A clean editor stays quiet — no probe, no banner.
    fireVisibilityChange();
    await act(async () => {});
    expect(document.querySelector("[data-revision-banner]")).toBeNull();
    expect(apiMock.state.calls.filter((call) => call.path === "/api/workflows/w1")).toHaveLength(0);

    // Dirty + focus: the probe fetches the workflow and the banner appears.
    editEntryPrompt("local: {{task}}");
    fireVisibilityChange();
    await act(async () => {});
    const banner = document.querySelector<HTMLElement>("[data-revision-banner]");
    expect(banner?.getAttribute("data-revision-banner")).toBe(String(SERVER_REVISION));
    expect(banner?.textContent).toContain(`Revision ${SERVER_REVISION} was saved elsewhere`);

    // Dismissal hides it until a newer revision appears.
    act(() => {
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss revision warning"]')
        ?.click();
    });
    await act(async () => {});
    expect(document.querySelector("[data-revision-banner]")).toBeNull();

    // Saving through the conflict (Save anyway) mints N+1 — the banner
    // condition is gone for good, not just dismissed.
    clickSave();
    await act(async () => {});
    act(() => {
      headerButton("Save anyway").click();
    });
    await act(async () => {});
    fireVisibilityChange();
    await act(async () => {});
    expect(document.querySelector("[data-revision-banner]")).toBeNull();
  });
});
