// @vitest-environment jsdom
//
// Sandboxes dashboard polling (#112): immediate fetch, 5s interval re-fetch,
// pause while the tab is hidden + immediate refresh on return, and full
// cleanup (no further fetches after stop). The fetcher is injected, so no
// network is touched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  countRunningSandboxes,
  startSandboxInstancesPolling,
  useActiveSandboxCount,
  type SandboxInstancesState,
} from "./sandbox-instances";
import type { SandboxInstance, SandboxInstancesPayload } from "./sandbox-api";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const payload = (instances: SandboxInstance[]): SandboxInstancesPayload => ({
  instances,
  checkedAt: 1,
});

const row = (overrides: Partial<SandboxInstance> = {}): SandboxInstance => ({
  id: "sb-1",
  runId: "run-1",
  image: "openeuler/worker:latest",
  status: "running",
  startedAt: 1,
  ...overrides,
});

describe("countRunningSandboxes (#112)", () => {
  it("counts only running instances", () => {
    expect(
      countRunningSandboxes([row(), row({ id: "sb-2", status: "exited" }), row({ id: "sb-3" })]),
    ).toBe(2);
  });
});

describe("startSandboxInstancesPolling (#112)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches immediately, then on every interval tick", async () => {
    const fetcher = vi.fn(async () => payload([row()]));
    const states: SandboxInstancesState[] = [];
    const stop = startSandboxInstancesPolling((state) => states.push(state), {
      fetcher,
      intervalMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({ phase: "ready" });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stops cleanly: no fetches after cleanup", async () => {
    const fetcher = vi.fn(async () => payload([]));
    const stop = startSandboxInstancesPolling(() => {}, { fetcher, intervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("discards results resolving after cleanup", async () => {
    let release: ((value: SandboxInstancesPayload) => void) | null = null;
    const fetcher = vi.fn(
      () =>
        new Promise<SandboxInstancesPayload>((resolve) => {
          release = resolve;
        }),
    );
    const states: SandboxInstancesState[] = [];
    const stop = startSandboxInstancesPolling((state) => states.push(state), { fetcher });
    stop();
    await act(async () => {
      release?.(payload([row()]));
      await Promise.resolve();
    });
    expect(states).toEqual([]);
  });

  it("reports fetch failures as the error phase without throwing", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("daemon down");
    });
    const states: SandboxInstancesState[] = [];
    startSandboxInstancesPolling((state) => states.push(state), { fetcher });
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toMatchObject({ phase: "error", message: "daemon down" });
  });

  it("pauses while the document is hidden and refreshes on return", async () => {
    const listeners: Array<() => void> = [];
    const fakeDoc = {
      visibilityState: "visible",
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      removeEventListener: (_type: string, listener: () => void) => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      },
    };
    const fetcher = vi.fn(async () => payload([]));
    startSandboxInstancesPolling(() => {}, { fetcher, intervalMs: 5_000, document: fakeDoc });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    fakeDoc.visibilityState = "hidden";
    for (const listener of [...listeners]) listener();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetcher).toHaveBeenCalledTimes(1); // paused: interval cleared

    fakeDoc.visibilityState = "visible";
    for (const listener of [...listeners]) listener();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2); // immediate refresh on return
  });
});

describe("useActiveSandboxCount (#112)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("settles on the running count from the instances payload", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const instances = [row(), row({ id: "sb-2", status: "exited" })];
        return new Response(JSON.stringify(payload(instances)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    let counted: number | null | undefined;
    const Probe = () => {
      counted = useActiveSandboxCount(30_000);
      return null;
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(createElement(Probe));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(counted).toBe(1);
  });
});
