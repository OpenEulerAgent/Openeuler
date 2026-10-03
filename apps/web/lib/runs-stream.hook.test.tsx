// @vitest-environment jsdom
//
// Hook-level tests for the shared run-status stream (#62): latest-ref
// dispatch, one EventSource per page tree, and the dashboard table wiring
// (in-place patches + refetches that use the CURRENT filters).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Project } from "@openeuler/core";
import { ToastProvider } from "@/components/ui/toast";
import { DashboardRunsTable } from "@/components/dashboard/DashboardRunsTable";
import { useActiveRuns } from "@/lib/active-runs";
import { useRunStatusStream } from "@/lib/runs-stream";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

// ---------------------------------------------------------------------------
// Navigation mock: the table keeps its filters in the URL, so `search` is a
// mutable string the mock router writes and the harness re-renders from.

interface NavMock {
  search: string;
  notify: ((search: string) => void) | null;
}

const nav: NavMock = vi.hoisted(() => ({ search: "", notify: null }));

// Next memoizes the searchParams object per URL; the table's filter memo
// (and its fetch effect) depends on that stability.
let cachedSearch: string | null = null;
let cachedParams: URLSearchParams = new URLSearchParams("");

const searchParamsFor = (search: string): URLSearchParams => {
  if (search !== cachedSearch) {
    cachedSearch = search;
    cachedParams = new URLSearchParams(search);
  }
  return cachedParams;
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (href: string) => {
      const mark = href.indexOf("?");
      nav.search = mark === -1 ? "" : (href.slice(mark + 1) ?? "");
      nav.notify?.(nav.search);
    },
    push: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => searchParamsFor(nav.search),
}));

// next/link would need the real app router; a plain anchor renders the same.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    createElement("a", { href }, children),
}));

// ---------------------------------------------------------------------------
// Mock EventSource: counts constructions (the sharing assertion) and lets
// tests emit frames.

type MockListener = (event: { data?: unknown }) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, MockListener[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: MockListener): void {
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

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  text: () => Promise.resolve(JSON.stringify(body)),
  json: () => Promise.resolve(body),
});

const statusFrame = (runId: string, status: string): string =>
  JSON.stringify({ runId, status, projectId: "p1" });

// ---------------------------------------------------------------------------
// Rendering harness.

interface MountResult {
  container: HTMLElement;
  rerender: (element: React.ReactElement) => void;
  unmount: () => void;
}

const mount = (element: React.ReactElement): MountResult => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(element);
  });
  const result: MountResult = {
    container,
    rerender: (next) => {
      act(() => {
        root.render(next);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      const index = roots.indexOf(result);
      if (index !== -1) roots.splice(index, 1);
    },
  };
  roots.push(result);
  return result;
};

/** Wraps children in the toast provider the table's useToast needs. */
const withProviders = (children: React.ReactNode): React.ReactElement =>
  createElement(ToastProvider, null, children);

const roots: MountResult[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()?.unmount();
});

// ---------------------------------------------------------------------------

describe("useRunStatusStream (shared subscription, latest-ref dispatch)", () => {
  let eventsOn: string[];
  let opensOn: string[];

  /** Probe: records which `filters` value each callback closure saw. */
  function StreamProbe({ filters }: { filters: string }) {
    useRunStatusStream({
      onEvent: () => eventsOn.push(filters),
      onOpen: () => opensOn.push(filters),
    });
    return null;
  }

  beforeEach(() => {
    MockEventSource.instances = [];
    eventsOn = [];
    opensOn = [];
    // Seeds and the table's projects fetch must not hit the network.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return jsonResponse(url.endsWith("/api/projects") ? { projects: [] } : { runs: [] });
    });
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches events and opens through the CURRENT render's handlers", () => {
    const element = (filters: string) => withProviders(createElement(StreamProbe, { filters }));
    const view = mount(element("A"));
    // Re-render with new handlers — the subscription must NOT be frozen at
    // mount time (the old bug: mount-time handlers captured forever).
    view.rerender(element("B"));

    const source = MockEventSource.instances[0] as MockEventSource;
    act(() => {
      source.emit("run.status", { data: statusFrame("r1", "running") });
      source.emit("open");
    });

    expect(eventsOn).toEqual(["B"]);
    expect(opensOn).toEqual(["B"]);
    view.unmount();
  });

  it("mounts ONE EventSource for N consumers and closes it with the last", () => {
    const many = withProviders(
      createElement("div", null, [
        createElement(StreamProbe, { key: "a", filters: "A" }),
        createElement(StreamProbe, { key: "b", filters: "B" }),
        createElement(StreamProbe, { key: "c", filters: "C" }),
      ]),
    );
    const view = mount(many);
    expect(MockEventSource.instances).toHaveLength(1);
    expect((MockEventSource.instances[0] as MockEventSource).closed).toBe(false);

    view.unmount();
    expect((MockEventSource.instances[0] as MockEventSource).closed).toBe(true);

    // Re-subscribing after everyone left opens a fresh connection.
    mount(many);
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("fires onOpen immediately for a consumer joining an open stream (seed)", () => {
    const first = mount(withProviders(createElement(StreamProbe, { filters: "A" })));
    const source = MockEventSource.instances[0] as MockEventSource;
    act(() => {
      source.emit("open");
    });
    expect(opensOn).toEqual(["A"]);

    // Joins after the connection opened: gets its onOpen right away.
    mount(withProviders(createElement(StreamProbe, { filters: "B" })));
    expect(opensOn).toEqual(["A", "B"]);
    first.unmount();
  });

  it("shares one EventSource between useActiveRuns (TopBar + cards) and the runs table", () => {
    const ActiveProbe = (): React.ReactElement => {
      const active = useActiveRuns();
      return createElement("span", { "data-testid": "active" }, String(active.runs.length));
    };
    const view = mount(
      withProviders(
        createElement("div", null, [
          createElement(ActiveProbe, { key: "topbar" }),
          createElement(ActiveProbe, { key: "cards" }),
          createElement(DashboardRunsTable, { key: "table" }),
        ]),
      ),
    );
    expect(MockEventSource.instances).toHaveLength(1);
    view.unmount();
    expect((MockEventSource.instances[0] as MockEventSource).closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("DashboardRunsTable stream wiring (current filters, in-place patches)", () => {
  const r1 = "11111111-1111-1111-1111-111111111111";
  const r2 = "22222222-2222-2222-2222-222222222222";

  const projects: Project[] = [
    {
      id: "p1",
      path: "/tmp/alpha",
      name: "alpha",
      defaultBranch: "main",
      createdAt: "2026-10-01T00:00:00Z",
    },
    {
      id: "p2",
      path: "/tmp/beta",
      name: "beta",
      defaultBranch: "main",
      createdAt: "2026-10-01T00:00:00Z",
    },
  ];

  const runRows = (): unknown[] => [
    {
      id: r1,
      projectId: "p1",
      status: "running",
      branch: "run/one",
      iteration: 0,
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:01:00Z",
      project: { id: "p1", name: "alpha" },
    },
    {
      id: r2,
      projectId: "p2",
      status: "queued",
      branch: "run/two",
      iteration: 0,
      createdAt: "2026-10-01T09:00:00Z",
      updatedAt: "2026-10-01T09:01:00Z",
      project: { id: "p2", name: "beta" },
    },
  ];

  const fetchLog: string[] = [];

  const stubRunsFetch = (respond: (url: string) => unknown): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        fetchLog.push(url);
        if (url.endsWith("/api/projects")) return jsonResponse({ projects });
        if (url.includes("/api/runs")) return jsonResponse(respond(url));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  };

  /** Server-side-ish filtering so filter changes change the payload. */
  const filterRows = (url: string): { runs: unknown[] } => {
    const query = new URL(url).searchParams;
    const statuses = (query.get("status") ?? "").split(",").filter(Boolean);
    const projectId = query.get("projectId");
    return {
      runs: runRows().filter(
        (run) =>
          (statuses.length === 0 || statuses.includes((run as { status: string }).status)) &&
          (projectId === null || (run as { projectId: string }).projectId === projectId),
      ),
    };
  };

  /** The row <tr> containing the link to /runs/<id>, or null. */
  const rowFor = (container: HTMLElement, runId: string): HTMLElement | null => {
    for (const row of container.querySelectorAll("tr")) {
      if (row.querySelector(`a[href="/runs/${runId}"]`)) return row as HTMLElement;
    }
    return null;
  };

  const loadMoreButton = (container: HTMLElement): HTMLButtonElement | undefined =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more",
    ) as HTMLButtonElement | undefined;

  /** The #114 compare CTA; absent until a row is ticked. */
  const compareButton = (container: HTMLElement): HTMLButtonElement | null =>
    container.querySelector('[data-testid="compare-runs-button"]');

  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    fetchLog.length = 0;
    nav.search = "";
    nav.notify = null;
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("patches known rows in place and refetches unknown ids with the CURRENT filters", async () => {
    stubRunsFetch(filterRows);

    /** Re-renders the table when the mocked router replaces the URL. */
    function Harness() {
      const [search, setSearch] = useState("");
      useEffect(() => {
        nav.notify = (next) => setSearch(next);
        return () => {
          nav.notify = null;
        };
      }, []);
      void search;
      return withProviders(createElement(DashboardRunsTable, null));
    }

    const view = mount(createElement(Harness, null));
    // Flush the initial /api/projects + /api/runs fetches.
    await act(async () => {});

    const runsFetches = fetchLog.filter((url) => url.includes("/api/runs"));
    expect(runsFetches).toHaveLength(1);
    expect(runsFetches[0]).toContain("/api/runs?limit=50");
    expect(rowFor(view.container, r1)).not.toBeNull();
    expect(rowFor(view.container, r2)).not.toBeNull();
    // #114: every row leads with a compare checkbox (the 0/1/2/3 selection
    // flow itself is covered by DashboardRunsTable.compare.test.tsx).
    expect(view.container.querySelectorAll("[data-compare-check]")).toHaveLength(2);
    expect(compareButton(view.container)).toBeNull();

    // Filters A → B: pick project p1 in the filter dropdown (the URL becomes
    // ?projectId=p1 and the refetch must go out with that filter).
    await act(async () => {
      const select = view.container.querySelector("select") as HTMLSelectElement;
      select.value = "p1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {});
    const afterFilter = fetchLog.filter((url) => url.includes("/api/runs"));
    expect(afterFilter).toHaveLength(2);
    expect(afterFilter[1]).toContain("projectId=p1");
    expect(rowFor(view.container, r1)).not.toBeNull();
    expect(rowFor(view.container, r2)).toBeNull();

    // (b) Known row patched IN PLACE: same <tr> element, new status.
    const before = rowFor(view.container, r1) as HTMLElement;
    expect(before.textContent).toContain("Running");
    const source = MockEventSource.instances[0] as MockEventSource;
    act(() => {
      source.emit("run.status", { data: statusFrame(r1, "success") });
    });
    const after = rowFor(view.container, r1) as HTMLElement;
    expect(after).toBe(before);
    expect(after.textContent).toContain("Success");

    // (a) Unknown id → debounced refetch that uses the CURRENT filters (B):
    // the mount-time-closure bug would have fetched without `projectId`.
    act(() => {
      source.emit("run.status", {
        data: JSON.stringify({
          runId: "99999999-9999-9999-9999-999999999999",
          status: "queued",
          projectId: "p1",
        }),
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    const refetch = fetchLog.filter((url) => url.includes("/api/runs")).pop() as string;
    expect(refetch).toContain("projectId=p1");
    view.unmount();
  });

  it("bounds the runs fetch and appends Load-more pages behind the table", async () => {
    stubRunsFetch(filterRows);
    const view = mount(withProviders(createElement(DashboardRunsTable, null)));
    await act(async () => {});

    expect(fetchLog.filter((url) => url.includes("/api/runs"))[0]).toContain("limit=50");
    expect(loadMoreButton(view.container)).toBeUndefined();
    view.unmount();

    // Second mount against a paged daemon: first page + nextCursor, then an
    // empty tail page once Load-more follows the cursor.
    fetchLog.length = 0;
    stubRunsFetch((url) =>
      new URL(url).searchParams.get("before") === null
        ? { runs: runRows(), nextCursor: `2026-10-01T09:00:00Z,${r2}` }
        : { runs: [] },
    );
    const paged = mount(withProviders(createElement(DashboardRunsTable, null)));
    await act(async () => {});
    expect(loadMoreButton(paged.container)).toBeDefined();

    await act(async () => {
      (loadMoreButton(paged.container) as HTMLButtonElement).click();
    });
    const cursorFetch = fetchLog.filter((url) => url.includes("/api/runs")).pop() as string;
    expect(cursorFetch).toContain("before=2026-10-01T09%3A00%3A00Z");
    // The exhausted page removes the button again.
    expect(loadMoreButton(paged.container)).toBeUndefined();
    paged.unmount();
  });
});
