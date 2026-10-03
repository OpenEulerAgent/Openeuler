// @vitest-environment jsdom
//
// Full client-flow integration for the run detail page 2.0 (#52): mocked
// daemon (fetch) + mocked SSE replay drive the REAL RunDetailView — graph
// tab renders node cards from the replayed fold, tabs switch via the URL,
// and the node drawer's diff deep link lands on the Diff tab scoped to that
// step run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Run, StepRun } from "@openeuler/core";
import { ThemeProvider } from "@/components/ThemeProvider";
import { RunDetailView } from "./RunDetailView";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

beforeEach(() => {
  (globalThis as Record<string, unknown>).ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = class DOMMatrixReadOnly {
    m22 = 1;
  };
});

// --- daemon mock -----------------------------------------------------------

const graph = {
  entryNodeId: "a",
  nodes: [
    {
      id: "a",
      type: "agent",
      name: "Worker A",
      position: { x: 0, y: 0 },
      config: { driver: "fake", mode: "auto", promptTemplate: "{{task}}", continueSession: false },
    },
    { id: "exit", type: "exit", name: "Exit", position: { x: 320, y: 0 } },
  ],
  edges: [{ id: "e-a-exit", source: "a", target: "exit", condition: { type: "always" } }],
};

const run: Run = {
  id: "run-1",
  projectId: "p-1",
  workflowId: "wf-1",
  workflowRevisionId: "rev-1",
  status: "success",
  branch: "openeuler/run-1",
  iteration: 0,
  task: "do the thing",
  output: "a-1",
  breadcrumb: [
    { kind: "node", nodeId: "a", iteration: 1 },
    { kind: "edge", edgeId: "e-a-exit", iteration: 1 },
  ],
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-01-01T10:00:05.000Z",
};

const steps: StepRun[] = [
  {
    id: "sr-1",
    runId: run.id,
    stepId: "a",
    iteration: 1,
    sessionId: "sess-1",
    status: "success",
    output: "a-1",
    diff: "@@ -1 +1 @@",
  },
];

/** SSE frames the daemon would replay for the finished run. */
const replayFrames = [
  { event: "run.status", data: { type: "run.status", seq: 0, status: "running" } },
  {
    event: "node.queued",
    data: { type: "node.queued", seq: 1, nodeId: "a", nodeName: "Worker A", iteration: 1 },
  },
  {
    event: "node.started",
    data: { type: "node.started", seq: 2, nodeId: "a", nodeName: "Worker A", iteration: 1 },
  },
  {
    event: "node.completed",
    data: {
      type: "node.completed",
      seq: 3,
      nodeId: "a",
      nodeName: "Worker A",
      iteration: 1,
      status: "success",
      output: "a-1",
      durationMs: 900,
    },
  },
  {
    event: "edge.taken",
    data: {
      type: "edge.taken",
      seq: 4,
      edgeId: "e-a-exit",
      source: "a",
      target: "exit",
      matchedCondition: "always",
      iteration: 1,
    },
  },
  { event: "run.status", data: { type: "run.status", seq: 5, status: "success" } },
];

type Listener = (event: { data?: unknown }) => void;

class MockEventSource {
  static last: MockEventSource | null = null;
  readonly url: string;
  readyState = 1;
  private readonly listeners = new Map<string, Listener[]>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.last = this;
  }

  addEventListener(type: string, listener: Listener): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  close(): void {
    this.closed = true;
  }

  /** Delivers the full replay + terminal frame (async, like the daemon). */
  async flushReplay(): Promise<void> {
    for (const frame of replayFrames) {
      await Promise.resolve();
      for (const listener of this.listeners.get(frame.event) ?? []) {
        listener({ data: JSON.stringify(frame.data) });
      }
    }
    this.readyState = 2;
  }
}

(globalThis as { EventSource?: unknown }).EventSource = MockEventSource;

const runDetailResponse = {
  run: { ...run, workflowRevision: { id: "rev-1", number: 1 } },
  steps,
  iterations: {},
  summary: { eventCount: replayFrames.length },
};

const fetchRoutes: Record<string, unknown> = {
  "/api/runs/run-1": runDetailResponse,
  "/api/projects/p-1": {
    project: { id: "p-1", name: "demo", path: "/tmp/demo", defaultBranch: "main" },
  },
  "/api/workflows/wf-1/revisions/1": { revision: { id: "rev-1", number: 1, graph } },
  "/api/runs/run-1/diff": {
    scope: "cumulative",
    stat: "1 file",
    patch: "diff --git a/f b/f\n",
    truncated: false,
    totalLines: 1,
    maxLines: 5000,
  },
};

const fetchCalls: string[] = [];

const route = (url: string): unknown => {
  const path = url.replace("http://localhost:8787", "").split("?")[0] as string;
  return fetchRoutes[path];
};

// --- router mock (URL is the tab state) ------------------------------------
// `replace` records the href; notify() re-renders the tree with the new
// search so the view sees its own URL writes (what Next does for real).

const nav = vi.hoisted(() => ({ href: "/", notify: null as (() => void) | null, search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (href: string) => {
      nav.href = href;
      nav.search = href.includes("?") ? (href.slice(href.indexOf("?") + 1) as string) : "";
      nav.notify?.();
    },
    push: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/runs/run-1",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => createElement("div", { "data-testid": "diff-view" }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

// --- harness ----------------------------------------------------------------

let root: Root | null = null;
let container: HTMLElement | null = null;

/** Mounts the page fresh (same position/type → internal state preserved). */
const render = (node: () => ReactNode): void => {
  if (container === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(node());
  });
};

beforeEach(() => {
  fetchCalls.length = 0;
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const href = String(url);
    fetchCalls.push(href);
    const body = route(href);
    if (body === undefined) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  MockEventSource.last = null;
  nav.search = "";
  nav.notify = null;
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe("RunDetailView 2.0 (client flow)", () => {
  it("defaults to the Graph tab and renders the replayed execution state", async () => {
    nav.notify = () =>
      render(() =>
        createElement(ThemeProvider, null, createElement(RunDetailView, { runId: "run-1" })),
      );
    nav.notify();
    await settle();
    await act(async () => {
      await MockEventSource.last?.flushReplay();
    });
    await settle();

    // Graph tab active: canvas + node card carrying the folded state.
    expect(document.querySelector("[data-run-graph-tab]")).not.toBeNull();
    const card = document.querySelector('[data-run-node="agent"]');
    expect(card?.getAttribute("data-run-node-status")).toBe("success");
    expect(fetchCalls.some((href) => href.endsWith("/api/workflows/wf-1/revisions/1"))).toBe(true);

    // All four tabs offered.
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(["Graph", "Events", "Diff", "Timeline"]);
  });

  it("drawer diff deep link switches to the Diff tab scoped to the step run", async () => {
    nav.notify = () =>
      render(() =>
        createElement(ThemeProvider, null, createElement(RunDetailView, { runId: "run-1" })),
      );
    nav.notify();
    await settle();
    await act(async () => {
      await MockEventSource.last?.flushReplay();
    });
    await settle();

    // Open the node drawer through the canvas card click (React Flow node
    // click handler receives the node; simulate via the card's click event).
    const card = document.querySelector('[data-run-node="agent"]') as HTMLElement;
    act(() => {
      card.click();
    });
    const drawer = document.querySelector('[aria-label^="Node executions"]');
    expect(drawer).not.toBeNull();
    expect(document.body.textContent).toContain("sess-1");

    const diffButton = [...(drawer?.querySelectorAll("button") ?? [])].find((button) =>
      button.textContent?.includes("View diff"),
    ) as HTMLElement;
    act(() => {
      diffButton.click();
    });
    await settle();

    // URL rewritten to the diff deep link; DiffsTab fetched the scoped diff.
    expect(nav.href).toBe("/runs/run-1?tab=diff&stepRunId=sr-1");
    expect(fetchCalls.some((href) => href.includes("scope=step&stepRunId=sr-1"))).toBe(true);
  });

  it("keeps the Events tab reachable for ad-hoc runs (no graph)", async () => {
    fetchRoutes["/api/runs/run-1"] = {
      run: { ...run, workflowId: undefined, workflowRevisionId: undefined },
      steps: [],
      iterations: {},
      summary: { eventCount: 0 },
    };
    nav.notify = () =>
      render(() =>
        createElement(ThemeProvider, null, createElement(RunDetailView, { runId: "run-1" })),
      );
    nav.notify();
    await settle();

    const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(["Events", "Diff", "Timeline"]);
    expect(document.querySelector("[data-run-graph-tab]")).toBeNull();
    delete fetchRoutes["/api/runs/run-1"];
    fetchRoutes["/api/runs/run-1"] = runDetailResponse;
  });

  it("hides the Preview tab without ports; ?tab=preview falls back to Graph", async () => {
    nav.search = "?tab=preview";
    nav.notify = () =>
      render(() =>
        createElement(ThemeProvider, null, createElement(RunDetailView, { runId: "run-1" })),
      );
    nav.notify();
    await settle();

    const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(["Graph", "Events", "Diff", "Timeline"]);
    // Fallback landed on Graph (the default), and nothing preview-shaped
    // mounted or fetched.
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Graph");
    expect(document.querySelector("[data-preview-tab]")).toBeNull();
    expect(fetchCalls.some((href) => href.includes("/previews/"))).toBe(false);
    nav.search = "";
  });

  it("shows the Preview tab for ported runs: lazy iframe + chips + HEAD probe (#109)", async () => {
    fetchRoutes["/api/runs/run-1"] = {
      ...runDetailResponse,
      ports: [
        { container: 3000, host: 49153, declared: true },
        { container: 5173, declared: false, hint: "declare ports on the run to preview" },
      ],
    };
    nav.notify = () =>
      render(() =>
        createElement(ThemeProvider, null, createElement(RunDetailView, { runId: "run-1" })),
      );
    nav.notify();
    await settle();

    // Tab offered, but nothing preview-related mounted or fetched yet.
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(["Graph", "Events", "Diff", "Timeline", "Preview"]);
    expect(document.querySelector("[data-preview-tab]")).toBeNull();
    expect(fetchCalls.some((href) => href.includes("/previews/"))).toBe(false);

    // Selecting the tab mounts the panel lazily: chips + iframe + probe.
    const previewTab = [...document.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent === "Preview",
    ) as HTMLElement;
    act(() => {
      previewTab.click();
    });
    await settle();

    expect(nav.href).toBe("/runs/run-1?tab=preview");
    const frame = document.querySelector("[data-preview-frame]") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("/previews/run-1/3000/");
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-forms allow-scripts allow-same-origin allow-modals",
    );
    // First hosted port selected by default; detected chip disabled + hint.
    expect(document.querySelector('[data-preview-chip="3000"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    const detectedChip = document.querySelector('[data-preview-chip="5173"]') as HTMLButtonElement;
    expect(detectedChip.disabled).toBe(true);
    expect(detectedChip.getAttribute("title")).toBe("declare ports on the run to preview");
    // HEAD probe fired through the proxy and reported live.
    expect(fetchCalls.some((href) => href.startsWith("/previews/run-1/3000/"))).toBe(true);
    expect(document.querySelector("[data-preview-state]")?.getAttribute("data-preview-state")).toBe(
      "live",
    );

    delete fetchRoutes["/api/runs/run-1"];
    fetchRoutes["/api/runs/run-1"] = runDetailResponse;
  });

  it("renders the hosted banner for hosted runs; preview stays functional (#110)", async () => {
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    fetchRoutes["/api/runs/run-1"] = {
      ...runDetailResponse,
      ports: [{ container: 3000, host: 49153, declared: true }],
      hosting: { until, ports: [{ container: 3000, host: 49153 }], extendable: true },
    };
    nav.search = "?tab=preview";
    nav.notify = () =>
      render(() =>
        createElement(ThemeProvider, null, createElement(RunDetailView, { runId: "run-1" })),
      );
    nav.notify();
    await settle();

    // The hosted banner headlines the countdown and offers both actions.
    const banner = document.querySelector("[data-hosted-banner]") as HTMLElement;
    expect(banner.getAttribute("data-hosted-until")).toBe(until);
    expect(banner.textContent).toContain("Hosted — preview live · expires in ");
    expect(banner.textContent).toMatch(/2[89]m|30m/);
    expect(document.querySelector("[data-hosted-extend]")).not.toBeNull();
    expect(document.querySelector("[data-hosted-stop]")).not.toBeNull();

    // The preview tab is fully functional: frame up through the proxy, and
    // the terminal-run teardown note is replaced by the hosted banner.
    const frame = document.querySelector("[data-preview-frame]") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("/previews/run-1/3000/");
    expect(document.querySelector("[data-preview-terminal-note]")).toBeNull();

    // Extend refreshes the detail through the daemon endpoint.
    const extend = document.querySelector("[data-hosted-extend]") as HTMLButtonElement;
    act(() => {
      extend.click();
    });
    await settle();
    expect(fetchCalls.some((href) => href.endsWith("/api/runs/run-1/hosting/extend"))).toBe(true);

    delete fetchRoutes["/api/runs/run-1"];
    fetchRoutes["/api/runs/run-1"] = runDetailResponse;
    nav.search = "";
  });
});
