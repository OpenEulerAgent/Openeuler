// @vitest-environment jsdom
//
// Canvas affordances (#75): the minimap appears only once a graph reaches
// the threshold (8 nodes) and sits top-left clear of the attribution and
// Controls; the persistent save-status chip walks the full save lifecycle
// (clean → unsaved → saving → saved → fade-to-muted, and error); the
// "Select area" toggle flips React Flow between pan and marquee
// (selectionOnDrag/panOnDrag) with Escape returning to pan; panOnScroll +
// zoomOnPinch (with plain-scroll zoom off) and Shift-only multi-select are
// wired; edges carry a 16px invisible interaction stroke and the hover
// widening CSS exists.

import { readFile } from "node:fs/promises";
import path from "node:path";
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

// Prop spy: the real <ReactFlow> renders (so DOM-level assertions like the
// minimap and edge interaction strokes stay honest) while every render's
// props are captured for prop-level assertions (panOnScroll, panOnDrag…).
const flowProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("@xyflow/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@xyflow/react")>();
  const RealReactFlow = original.ReactFlow;
  const ReactFlowSpy = (props: import("@xyflow/react").ReactFlowProps) => {
    flowProps.current = props as unknown as Record<string, unknown>;
    return createElement(RealReactFlow, props);
  };
  return { ...original, ReactFlow: ReactFlowSpy };
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

/** A valid always-condition chain of `agents` agent nodes plus one exit. */
const chainGraph = (agents: number): WorkflowGraph => {
  const agentIds = Array.from({ length: agents }, (_, index) => `n${index}`);
  const entry = agentIds[0];
  if (entry === undefined) throw new Error("chainGraph needs at least one agent");
  const chain = [...agentIds, "exit"];
  return {
    entryNodeId: entry,
    nodes: [
      ...agentIds.map((id, index) => agentNode(id, index * 320)),
      { id: "exit", type: "exit", name: "Exit", position: { x: agents * 320, y: 0 } },
    ],
    edges: chain.slice(0, -1).map((id, index): WorkflowGraph["edges"][number] => {
      const target = chain[index + 1];
      if (target === undefined) throw new Error("chain shorter than expected");
      return {
        id: `e-${id}-${target}`,
        source: id,
        target,
        condition: { type: "always" },
      };
    }),
  };
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (element: ReactElement): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
};

/** Renders the editor against `workflow`; the graph route mirrors the PUT. */
const renderEditor = (workflow: WorkflowWithGraph): void => {
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
  flowProps.current = null;
  render(
    createElement(
      ToastProvider,
      null,
      createElement(GraphCanvasEditor, { workflow, drivers: ["opencode"] }),
    ),
  );
};

const minimap = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="rf__minimap"]');

const chip = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>("[data-save-status]");
  if (el === null) throw new Error("save status chip not found");
  return el;
};

const selectAreaButton = (): HTMLButtonElement => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("header button")].find(
    (candidate) => candidate.textContent?.trim() === "Select area",
  );
  if (button === undefined) throw new Error("Select area button not found");
  return button;
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

/** Dirties the doc through a valid prompt edit on a node (the clean gate
 *  requires a real edit before any PUT can fire). */
const editPrompt = (nodeId: string, value: string): void => {
  const card = document.querySelector(
    `.react-flow__node[data-id="${nodeId}"] [data-canvas-node="agent"]`,
  );
  if (card === null) throw new Error(`node card ${nodeId} not found`);
  act(() => {
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  const prompt = document.querySelector<HTMLTextAreaElement>("#node-prompt");
  if (prompt === null) throw new Error("prompt textarea not found");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(prompt, value);
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const pressKey = (key: string): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
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
  vi.useRealTimers();
});

describe("GraphCanvasEditor minimap (#75)", () => {
  it("stays hidden below 8 nodes", () => {
    renderEditor(workflowFor(chainGraph(3))); // 4 nodes total
    expect(document.querySelectorAll(".react-flow__node").length).toBeLessThan(8);
    expect(minimap()).toBeNull();
  });

  it("renders top-left (pannable, zoomable) once the graph reaches 8 nodes", () => {
    renderEditor(workflowFor(chainGraph(7))); // 8 nodes total
    const map = minimap();
    expect(map).not.toBeNull();
    // The wrapping panel is anchored top-left: clear of the top-right
    // attribution, the bottom-right Controls, and the bottom-left
    // ValidationPanel.
    const panel = map?.closest(".react-flow__panel");
    expect(panel?.className).toContain("top");
    expect(panel?.className).toContain("left");
    expect(panel?.className).not.toContain("bottom");
    expect(panel?.className).not.toContain("right");
  });
});

describe("GraphCanvasEditor pan / marquee / multi-select props (#75)", () => {
  it("enables panOnScroll + zoomOnPinch with plain scroll zoom off, and Shift-only multi-select", () => {
    renderEditor(workflowFor(chainGraph(1)));
    expect(flowProps.current?.panOnScroll).toBe(true);
    expect(flowProps.current?.zoomOnPinch).toBe(true);
    expect(flowProps.current?.zoomOnScroll).toBe(false);
    expect(flowProps.current?.multiSelectionKeyCode).toEqual(["Shift"]);
  });

  it("defaults to pan: drag pans, no selection-on-drag", () => {
    renderEditor(workflowFor(chainGraph(1)));
    const button = selectAreaButton();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(flowProps.current?.selectionOnDrag).toBe(false);
    expect(flowProps.current?.panOnDrag).toBe(true);
  });

  it("the Select area toggle flips selectionOnDrag/panOnDrag; toggle-off and Escape return to pan", () => {
    renderEditor(workflowFor(chainGraph(1)));

    act(() => {
      selectAreaButton().click();
    });
    expect(selectAreaButton().getAttribute("aria-pressed")).toBe("true");
    expect(flowProps.current?.selectionOnDrag).toBe(true);
    expect(flowProps.current?.panOnDrag).toBe(false);

    // Toggle off returns to panning.
    act(() => {
      selectAreaButton().click();
    });
    expect(selectAreaButton().getAttribute("aria-pressed")).toBe("false");
    expect(flowProps.current?.selectionOnDrag).toBe(false);
    expect(flowProps.current?.panOnDrag).toBe(true);

    // Escape is the other way out of marquee mode.
    act(() => {
      selectAreaButton().click();
    });
    expect(selectAreaButton().getAttribute("aria-pressed")).toBe("true");
    pressKey("Escape");
    expect(selectAreaButton().getAttribute("aria-pressed")).toBe("false");
    expect(flowProps.current?.selectionOnDrag).toBe(false);
    expect(flowProps.current?.panOnDrag).toBe(true);
  });
});

describe("GraphCanvasEditor edge interaction hit-area (#75)", () => {
  it("every edge carries a 16px invisible interaction width, labels intact", () => {
    // jsdom cannot measure nodes (zero rects), so edge DOM never mounts;
    // the captured ReactFlow props carry the exact edge objects instead —
    // assert interactionWidth there. A router at n0 keeps condition chips
    // in play so the hit-area provably never displaces labels.
    const base = chainGraph(2);
    const routerGraph: WorkflowGraph = {
      ...base,
      edges: [
        ...base.edges,
        {
          id: "e-n0-exit",
          source: "n0",
          target: "exit",
          condition: { type: "outputContains", pattern: "LGTM" },
        },
      ],
    };
    renderEditor(workflowFor(routerGraph));
    const edges = (flowProps.current?.edges ?? []) as unknown as Array<{
      id: string;
      interactionWidth?: number;
      label?: unknown;
    }>;
    expect(edges.length).toBeGreaterThanOrEqual(3);
    for (const edge of edges) {
      expect(edge.interactionWidth).toBe(16);
    }
    // The router's conditional edge keeps its chip label alongside the
    // wider hit-area.
    expect(edges.some((edge) => typeof edge.label === "string")).toBe(true);
  });

  it("canvas.css widens + accents the visible stroke on hover", async () => {
    const css = await readFile(
      path.join(process.cwd(), "components/workflows/canvas/canvas.css"),
      "utf8",
    );
    expect(css).toContain(".react-flow__edge:hover .react-flow__edge-path");
    expect(css).toContain("stroke-width: 3");
    // Selected edges keep their accent.
    expect(css).toContain(".react-flow__edge.selected .react-flow__edge-path");
  });
});

describe("GraphCanvasEditor save status chip (#75)", () => {
  it("walks clean → unsaved → saving → saved, then fades to muted", async () => {
    vi.useFakeTimers();
    const settleSave: { resolve?: () => void } = {};
    renderEditor(workflowFor(chainGraph(1)));

    // Pristine doc: chip reads "No changes".
    expect(chip().dataset.saveStatus).toBe("clean");
    expect(chip().textContent).toBe("No changes");

    // A valid edit flips it to unsaved (amber).
    editPrompt("n0", "work harder: {{task}}");
    expect(chip().dataset.saveStatus).toBe("unsaved");
    expect(chip().textContent).toBe("Unsaved changes");

    // Save in flight: the graph route never settles yet — chip reads
    // "Saving…" while the PUT pends.
    apiMock.state.routes["/api/workflows/w1/graph"] = () =>
      new Promise((resolve) => {
        settleSave.resolve = () =>
          resolve({ workflow: workflowFor(chainGraph(1)), revision: { id: "r2", number: 2 } });
      });
    clickSave();
    await act(async () => {});
    expect(chip().dataset.saveStatus).toBe("saving");
    expect(chip().textContent).toBe("Saving…");

    // Landed: saved with the revision named, vivid for now.
    await act(async () => {
      settleSave.resolve?.();
    });
    expect(chip().dataset.saveStatus).toBe("saved");
    expect(chip().textContent).toBe("Saved · revision 2");
    expect(chip().dataset.muted).toBeUndefined();

    // After the fade window the label stays but the tone mutes.
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(chip().dataset.saveStatus).toBe("saved");
    expect(chip().textContent).toBe("Saved · revision 2");
    expect(chip().dataset.muted).toBe("true");

    // The next edit flips the chip straight back to unsaved.
    editPrompt("n0", "work even harder: {{task}}");
    expect(chip().dataset.saveStatus).toBe("unsaved");
  });

  it("a failed save reads error until the next attempt", async () => {
    renderEditor(workflowFor(chainGraph(1)));
    editPrompt("n0", "work harder: {{task}}");

    apiMock.state.routes["/api/workflows/w1/graph"] = () => {
      throw new Error("daemon offline");
    };
    clickSave();
    await act(async () => {});
    expect(chip().dataset.saveStatus).toBe("error");
    expect(chip().textContent).toBe("Save failed");

    // A new attempt replaces the failure with "Saving…" (never a stale
    // "Save failed" while a PUT is in flight).
    const settleRetry = { resolve: undefined as (() => void) | undefined };
    apiMock.state.routes["/api/workflows/w1/graph"] = () =>
      new Promise((resolve) => {
        settleRetry.resolve = () =>
          resolve({ workflow: workflowFor(chainGraph(1)), revision: { id: "r3", number: 3 } });
      });
    clickSave();
    await act(async () => {});
    expect(chip().dataset.saveStatus).toBe("saving");
    await act(async () => {
      settleRetry.resolve?.();
    });
    expect(chip().dataset.saveStatus).toBe("saved");
    expect(chip().textContent).toBe("Saved · revision 3");
  });
});
