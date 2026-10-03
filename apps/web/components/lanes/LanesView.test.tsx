// @vitest-environment jsdom
//
// Page smoke for the workmux lanes view (#113): the REAL LanesView renders
// live lane columns from a mocked daemon (seed fetch + global stream), a
// terminal transition fades a lane out after 5s, an unknown queued run
// appears immediately and fills from the debounced seed refetch, and the
// History toggle draws the filmstrip swimlanes from lazily fetched run
// details (cached across tab flips).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanesView } from "./LanesView";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const r1 = "11111111-1111-1111-1111-111111111111";
const r2 = "22222222-2222-2222-2222-222222222222";
const r3 = "33333333-3333-3333-3333-333333333333";
const r4 = "44444444-4444-4444-4444-444444444444";

const nowIso = "2026-10-03T10:00:00Z";

const activeRows = (): unknown[] => [
  {
    id: r1,
    projectId: "p1",
    status: "running",
    branch: "run/alpha",
    iteration: 1,
    breadcrumb: [{ kind: "node", nodeId: "n1", iteration: 1 }],
    createdAt: "2026-10-03T09:59:00Z",
    updatedAt: "2026-10-03T10:00:00Z",
    project: { id: "p1", name: "alpha" },
    workflow: { id: "wf1", name: "ship-it" },
    workflowRevision: { id: "rev1", number: 4 },
  },
  {
    id: r2,
    projectId: "p2",
    status: "queued",
    branch: "run/beta",
    iteration: 0,
    queuePosition: 1,
    createdAt: "2026-10-03T09:59:30Z",
    updatedAt: "2026-10-03T09:59:30Z",
    project: { id: "p2", name: "beta" },
    task: "fix the flaky test",
  },
];

const terminalRows = (): unknown[] => [
  {
    id: r3,
    projectId: "p1",
    status: "success",
    branch: "run/alpha-old",
    iteration: 1,
    createdAt: "2026-10-03T09:00:00Z",
    updatedAt: "2026-10-03T09:03:20Z",
    project: { id: "p1", name: "alpha" },
    workflow: { id: "wf1", name: "ship-it" },
    workflowRevision: { id: "rev1", number: 3 },
  },
  {
    id: r4,
    projectId: "p2",
    status: "failed",
    branch: "run/beta-old",
    iteration: 1,
    createdAt: "2026-10-03T08:00:00Z",
    updatedAt: "2026-10-03T08:00:40Z",
    project: { id: "p2", name: "beta" },
    task: "older task",
  },
];

const detailBodies: Record<string, unknown> = {
  [r3]: {
    run: { id: r3, status: "success" },
    steps: [
      {
        id: "sr-a",
        runId: r3,
        stepId: "n1",
        iteration: 1,
        status: "success",
        output: "",
        name: "Worker A",
        durationMs: 3_000,
      },
      {
        id: "sr-b",
        runId: r3,
        stepId: "n2",
        iteration: 1,
        status: "success",
        output: "",
        name: "Worker B",
        durationMs: 1_000,
      },
    ],
    summary: { eventCount: 6 },
  },
  [r4]: {
    run: { id: r4, status: "failed" },
    steps: [
      {
        id: "sr-c",
        runId: r4,
        stepId: "adhoc",
        iteration: 1,
        status: "failed",
        output: "",
        name: "ad-hoc",
      },
    ],
    summary: { eventCount: 2 },
  },
};

type Listener = (event: { data?: unknown }) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const statusFrame = (runId: string, status: string, projectId = "p1"): string =>
  JSON.stringify({ runId, status, projectId });

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  text: () => Promise.resolve(JSON.stringify(body)),
  json: () => Promise.resolve(body),
});

/** Daemon mock: /api/runs filters the row pool by ?status=; mutable extras. */
let extraActiveRows: unknown[];
const fetchLog: string[] = [];

const stubDaemon = (): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchLog.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === "/api/runs") {
        const statuses = (parsed.searchParams.get("status") ?? "").split(",").filter(Boolean);
        const pool = [...activeRows(), ...(extraActiveRows ?? []), ...terminalRows()];
        const runs =
          statuses.length === 0
            ? pool
            : pool.filter((row) => statuses.includes((row as { status: string }).status));
        return jsonResponse({ runs });
      }
      const detailMatch = /^\/api\/runs\/([^/?]+)$/.exec(parsed.pathname);
      if (detailMatch !== null) {
        const body = detailBodies[decodeURIComponent(detailMatch[1] as string)];
        if (body === undefined) throw new Error(`unexpected detail fetch: ${url}`);
        return jsonResponse(body);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
};

let root: Root | null = null;
let container: HTMLElement | null = null;

const mount = (): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(LanesView));
  });
};

const unmount = (): void => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
};

const laneCard = (runId: string): HTMLElement | null =>
  (container as HTMLElement).querySelector(`[data-lane-run-id="${runId}"]`) ?? null;

const clickTab = (label: string): void => {
  const tab = [...(container as HTMLElement).querySelectorAll('[role="tab"]')].find(
    (element) => element.textContent === label,
  ) as HTMLButtonElement | undefined;
  expect(tab, `tab ${label}`).toBeDefined();
  act(() => {
    tab?.click();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(nowIso));
  MockEventSource.instances = [];
  fetchLog.length = 0;
  extraActiveRows = [];
  vi.stubGlobal("EventSource", MockEventSource);
  stubDaemon();
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LanesView page smoke (#113)", () => {
  it("renders live lane cards from the mocked seed (project/workflow/rev/link)", async () => {
    mount();
    await act(async () => {});

    const firstFetch = fetchLog.find((url) => url.includes("/api/runs?"));
    expect(firstFetch).toContain("status=running%2Cqueued");
    expect(firstFetch).toContain("limit=50");

    const alpha = laneCard(r1);
    expect(alpha).not.toBeNull();
    expect(alpha?.textContent).toContain("alpha");
    expect(alpha?.textContent).toContain("ship-it · r4");
    expect(alpha?.textContent).toContain("Running");
    expect(alpha?.getAttribute("href")).toBe(`/runs/${r1}`);

    const beta = laneCard(r2);
    expect(beta?.textContent).toContain("beta");
    expect(beta?.textContent).toContain("Queued · #1");
    expect(beta?.getAttribute("href")).toBe(`/runs/${r2}`);
  });

  it("patches a terminal transition in place: fades, then exits after 5s", async () => {
    mount();
    await act(async () => {});

    const source = MockEventSource.instances[0] as MockEventSource;
    act(() => {
      source.emit("run.status", { data: statusFrame(r1, "success") });
    });

    const exiting = laneCard(r1);
    expect(exiting?.dataset.exiting).toBe("true");
    expect(exiting?.textContent).toContain("Success");
    // Still on the board inside the grace window…
    await act(async () => {
      vi.advanceTimersByTime(4_900);
    });
    expect(laneCard(r1)).not.toBeNull();
    // …and gone after 5s.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(laneCard(r1)).toBeNull();
    expect(laneCard(r2)).not.toBeNull();
  });

  it("adds a placeholder for an unknown queued run and fills it via the debounced refetch", async () => {
    mount();
    await act(async () => {});
    expect(laneCard(r2)).not.toBeNull();

    // A run we have never seen queues: placeholder appears immediately…
    const source = MockEventSource.instances[0] as MockEventSource;
    act(() => {
      source.emit("run.status", {
        data: JSON.stringify({
          runId: r3,
          status: "queued",
          projectId: "p1",
          workflowRevision: { id: "rev1", number: 5 },
        }),
      });
    });
    expect(laneCard(r3)).not.toBeNull();

    // …then the debounced seed refetch fills its project/workflow columns.
    extraActiveRows = [
      {
        id: r3,
        projectId: "p1",
        status: "queued",
        branch: "run/gamma",
        iteration: 0,
        queuePosition: 2,
        createdAt: "2026-10-03T10:00:01Z",
        updatedAt: "2026-10-03T10:00:01Z",
        project: { id: "p1", name: "gamma" },
        workflow: { id: "wf2", name: "polish-pass" },
      },
    ];
    const before = fetchLog.filter((url) => url.includes("status=running")).length;
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    const refetches = fetchLog.filter((url) => url.includes("status=running"));
    expect(refetches.length).toBeGreaterThan(before);

    const filled = laneCard(r3);
    expect(filled?.textContent).toContain("gamma");
    expect(filled?.textContent).toContain("polish-pass");
    expect(filled?.textContent).toContain("Queued · #2");
  });

  it("History filmstrip renders swimlanes with duration-proportional blocks (details cached)", async () => {
    mount();
    await act(async () => {});

    clickTab("History");
    await act(async () => {});

    const listFetch = fetchLog.find((url) => url.includes("success"));
    expect(listFetch).toContain("limit=20");

    const rows = (container as HTMLElement).querySelectorAll("[data-filmstrip-run-id]");
    expect(rows).toHaveLength(2);

    const okRow = (container as HTMLElement).querySelector(`[data-filmstrip-run-id="${r3}"]`);
    expect(okRow?.textContent).toContain("alpha");
    expect(okRow?.textContent).toContain("3m 20s");

    // Blocks: 3s/1s durations → 75%/25% widths, success tone, tooltips.
    const blocks = okRow?.querySelectorAll("[data-step-run-id]") ?? [];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.getAttribute("style")).toContain("width: 75%");
    expect(blocks[0]?.getAttribute("data-tone")).toBe("success");
    expect(blocks[0]?.getAttribute("title")).toBe("Worker A · iter 1 · 3s");
    expect(blocks[1]?.getAttribute("style")).toContain("width: 25%");

    // Ruler ticks at 0 / 50 / 100 of the run span.
    const ticks = [...(okRow?.querySelectorAll("[data-ruler-tick]") ?? [])].map(
      (tick) => tick.textContent,
    );
    expect(ticks).toEqual(["0ms", "1m 40s", "3m 20s"]);

    // The failed ad-hoc run renders its unknown-duration block.
    const failedRow = (container as HTMLElement).querySelector(`[data-filmstrip-run-id="${r4}"]`);
    const failedBlocks = failedRow?.querySelectorAll("[data-step-run-id]") ?? [];
    expect(failedBlocks).toHaveLength(1);
    expect(failedBlocks[0]?.getAttribute("data-tone")).toBe("failed");
    expect(failedBlocks[0]?.getAttribute("title")).toContain("unknown duration");

    // Each run detail fetched exactly once; flipping tabs serves from cache.
    const detailFetches = () =>
      fetchLog.filter((url) => /\/api\/runs\/[^/?]+$/.test(new URL(url).pathname));
    const firstCount = detailFetches().length;
    expect(firstCount).toBe(2);

    clickTab("Live");
    await act(async () => {});
    clickTab("History");
    await act(async () => {});
    expect(detailFetches().length).toBe(2);
  });
});
