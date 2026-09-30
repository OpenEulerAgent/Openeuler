import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHealth, formatUptime, startHealthPolling, type HealthState } from "./health.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchHealth", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("reports healthy with version and uptime", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, version: "0.1.0", uptime: 42 }));

    await expect(fetchHealth()).resolves.toEqual({
      status: "healthy",
      version: "0.1.0",
      uptime: 42,
    });
  });

  it("reports degraded when the daemon says it is not ok", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, version: "0.1.0", uptime: 1 }));

    await expect(fetchHealth()).resolves.toEqual({
      status: "degraded",
      message: "Daemon reported an unhealthy state",
    });
  });

  it("reports degraded with the error message when the daemon is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const state = await fetchHealth();
    expect(state.status).toBe("degraded");
    if (state.status === "degraded") {
      expect(state.message).toContain("Could not reach daemon");
    }
  });
});

describe("startHealthPolling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls immediately and on each interval tick", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue({
      status: "healthy",
      version: "0.1.0",
      uptime: 1,
    } satisfies HealthState);
    const states: HealthState[] = [];

    const stop = startHealthPolling((state) => states.push(state), fetcher, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(states).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(10000);
    expect(states).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(4);

    stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(states).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("keeps polling after a failed round", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<() => Promise<HealthState>>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({ status: "healthy", version: "0.1.0", uptime: 2 });
    const states: HealthState[] = [];

    const stop = startHealthPolling((state) => states.push(state), fetcher, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(states).toEqual([
      { status: "degraded", message: "Unknown error" },
      { status: "healthy", version: "0.1.0", uptime: 2 },
    ]);
    stop();
  });

  it("discards results that resolve after stop", async () => {
    vi.useFakeTimers();
    let resolvePoll: ((state: HealthState) => void) | undefined;
    const fetcher = () =>
      new Promise<HealthState>((resolve) => {
        resolvePoll = resolve;
      });
    const states: HealthState[] = [];

    const stop = startHealthPolling((state) => states.push(state), fetcher, 5000);
    stop();
    resolvePoll?.({ status: "healthy", version: "0.1.0", uptime: 3 });
    await vi.advanceTimersByTimeAsync(10000);

    expect(states).toHaveLength(0);
  });
});

describe("formatUptime", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(59)).toBe("59s");
    expect(formatUptime(60)).toBe("1m 00s");
    expect(formatUptime(125)).toBe("2m 05s");
    expect(formatUptime(3600)).toBe("1h 00m");
    expect(formatUptime(7385)).toBe("2h 03m");
  });

  it("clamps negative input", () => {
    expect(formatUptime(-5)).toBe("0s");
  });
});
