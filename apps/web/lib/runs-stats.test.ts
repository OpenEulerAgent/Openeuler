import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRunStats, startRunStatsPolling, type RunStatsState } from "./runs-stats.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchRunStats", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("returns the queued/running counts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ queued: 3, running: 2 }));

    await expect(fetchRunStats()).resolves.toEqual({
      status: "ready",
      stats: { queued: 3, running: 2 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/runs/stats"),
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
  });

  it("collapses daemon errors into an error state", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "X", message: "no db" } }), { status: 503 }),
    );

    const state = await fetchRunStats();
    expect(state.status).toBe("error");
    if (state.status === "error") expect(state.message).toBe("no db");
  });

  it("collapses network failures into an error state", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const state = await fetchRunStats();
    expect(state.status).toBe("error");
  });
});

describe("startRunStatsPolling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls immediately and on each interval tick, stopping on cancel", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<() => Promise<RunStatsState>>()
      .mockResolvedValue({ status: "ready", stats: { queued: 0, running: 1 } });
    const states: RunStatsState[] = [];

    const stop = startRunStatsPolling((state) => states.push(state), fetcher, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(states).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(states).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after a failed round", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<() => Promise<RunStatsState>>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({ status: "ready", stats: { queued: 1, running: 0 } });
    const states: RunStatsState[] = [];

    const stop = startRunStatsPolling((state) => states.push(state), fetcher, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(states).toEqual([
      { status: "error", message: "Unknown error" },
      { status: "ready", stats: { queued: 1, running: 0 } },
    ]);
    stop();
  });
});
