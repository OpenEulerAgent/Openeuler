// @vitest-environment jsdom
//
// Lazy run-detail loader (#113): fetch ONCE per run (in-flight dedupe),
// cache until the lanes view unmounts, clear failures so a retry refetches,
// and the row hook settles through loading → ready/error.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunDetailCache, useRunDetail, type RunDetailPayload } from "./detail-loader";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const detail = (runId: string): RunDetailPayload => ({
  run: {
    id: runId,
    projectId: "p1",
    status: "success",
    branch: "run/x",
    iteration: 1,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:01:00Z",
  },
  steps: [],
  summary: { eventCount: 3 },
});

describe("RunDetailCache", () => {
  it("fetches each run exactly once — cached hits share the settled entry", async () => {
    const fetches: string[] = [];
    const cache = new RunDetailCache(async (runId) => {
      fetches.push(runId);
      return detail(runId);
    });

    const first = await cache.load("r1");
    const second = await cache.load("r1");
    expect(fetches).toEqual(["r1"]);
    expect(second).toBe(first);
    expect(cache.peek("r1")).toEqual(first);
    expect(cache.size).toBe(1);
  });

  it("dedupes concurrent loads onto one in-flight promise", async () => {
    let calls = 0;
    let resolveFetch: ((value: RunDetailPayload) => void) | null = null;
    const cache = new RunDetailCache(
      () =>
        new Promise((resolve) => {
          calls += 1;
          resolveFetch = resolve;
        }),
    );

    const a = cache.load("r1");
    const b = cache.load("r1");
    await act(async () => {
      (resolveFetch as unknown as (value: RunDetailPayload) => void)(detail("r1"));
    });
    expect(await a).toEqual(detail("r1"));
    expect(await b).toEqual(detail("r1"));
    expect(calls).toBe(1);
  });

  it("clears the gate on failure so a later load retries", async () => {
    let calls = 0;
    const cache = new RunDetailCache(async (runId) => {
      calls += 1;
      if (calls === 1) throw new Error("daemon down");
      return detail(runId);
    });

    await expect(cache.load("r1")).rejects.toThrow("daemon down");
    await expect(cache.load("r1")).resolves.toEqual(detail("r1"));
    expect(calls).toBe(2);
    expect(cache.peek("r1")).toEqual(detail("r1"));
  });

  it("dispose drops every cached row (unmount cleanup): the next load refetches", async () => {
    const fetches: string[] = [];
    const cache = new RunDetailCache(async (runId) => {
      fetches.push(runId);
      return detail(runId);
    });

    await cache.load("r1");
    expect(fetches).toEqual(["r1"]);
    cache.dispose();
    expect(cache.size).toBe(0);
    expect(cache.peek("r1")).toBeUndefined();

    await cache.load("r1");
    expect(fetches).toEqual(["r1", "r1"]);
  });
});

describe("useRunDetail (row hook)", () => {
  const roots: Root[] = [];
  const containers: HTMLElement[] = [];

  const mount = (element: React.ReactElement): HTMLElement => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(element);
    });
    roots.push(root);
    containers.push(container);
    return container;
  };

  /**
   * Deferred fetcher: nothing settles until the test releases it INSIDE an
   * `await act(...)` — promise settles must never escape act (React warns).
   */
  const deferredCache = (): {
    cache: RunDetailCache;
    release: (mode: "resolve" | "reject") => void;
  } => {
    let releaseFn: ((mode: "resolve" | "reject") => void) | null = null;
    const cache = new RunDetailCache(
      () =>
        new Promise<RunDetailPayload>((resolve, reject) => {
          releaseFn = (mode) =>
            mode === "reject" ? reject(new Error("boom")) : resolve(detail("r1"));
        }),
    );
    return {
      cache,
      release: (mode) => (releaseFn as unknown as (m: "resolve" | "reject") => void)(mode),
    };
  };

  const renderProbe = (runId: string, cache: RunDetailCache): HTMLElement => {
    function Probe() {
      const state = useRunDetail(runId, cache);
      return createElement(
        "span",
        { "data-testid": "probe" },
        state.phase + (state.phase === "ready" ? `:${state.detail.run.id}` : ""),
      );
    }
    return mount(createElement(Probe));
  };

  const probeText = (container: HTMLElement): string | null =>
    container.querySelector("[data-testid=probe]")?.textContent ?? null;

  beforeEach(() => {
    roots.length = 0;
    containers.length = 0;
  });

  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      act(() => {
        root?.unmount();
      });
    }
    while (containers.length > 0) containers.pop()?.remove();
  });

  it("settles loading → ready through the shared cache (re-mount serves cached)", async () => {
    const { cache, release } = deferredCache();

    const container = renderProbe("r1", cache);
    expect(probeText(container)).toBe("loading");

    await act(async () => {
      release("resolve");
    });
    expect(probeText(container)).toBe("ready:r1");

    // The same run re-mounted (e.g. after a Live⇄History flip) goes through
    // the settled cache entry — loading → ready without another fetch.
    const again = renderProbe("r1", cache);
    expect(probeText(again)).toBe("loading");
    await act(async () => {});
    expect(probeText(again)).toBe("ready:r1");
    expect(cache.size).toBe(1);
  });

  it("surfaces failures as error and retries on the next mount", async () => {
    const { cache, release } = deferredCache();

    const first = renderProbe("r1", cache);
    await act(async () => {
      release("reject");
    });
    expect(probeText(first)).toBe("error");

    const second = renderProbe("r1", cache);
    await act(async () => {
      release("resolve");
    });
    expect(probeText(second)).toBe("ready:r1");
  });

  it("ignores late settles after unmount (no state update on a dead row)", async () => {
    const { cache, release } = deferredCache();

    const container = renderProbe("r1", cache);
    expect(probeText(container)).toBe("loading");

    // Unmount the row with the fetch still in flight…
    const root = roots.pop();
    containers.pop()?.remove();
    act(() => {
      root?.unmount();
    });

    // …then let the daemon answer: the cancelled row must stay silent.
    await act(async () => {
      release("resolve");
    });
    expect(container.isConnected).toBe(false);
    // The settled entry stays cached for any future mount of the same run.
    const revived = renderProbe("r1", cache);
    await act(async () => {});
    expect(probeText(revived)).toBe("ready:r1");
  });
});
