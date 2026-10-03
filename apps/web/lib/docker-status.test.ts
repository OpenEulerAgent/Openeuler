import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchDockerStatus,
  startDockerStatusPolling,
  type DockerStatusState,
} from "./docker-status.js";

/** Polling twin of health.test.ts (#106): immediate + interval + stop discard. */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchDockerStatus", () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("maps the daemon payload to a ready state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ available: true, version: "27.3.1", mode: "docker", checkedAt: 1 }),
      ),
    );
    await expect(fetchDockerStatus()).resolves.toEqual({
      status: "ready",
      available: true,
      version: "27.3.1",
    });
  });

  it("collapses any transport failure to unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
    );
    await expect(fetchDockerStatus()).resolves.toEqual({ status: "unknown" });
  });
});

describe("startDockerStatusPolling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls immediately and on each interval tick, defaulting to 60s", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValue({ status: "ready", available: true } satisfies DockerStatusState);
    const states: DockerStatusState[] = [];

    const stop = startDockerStatusPolling((state) => states.push(state), fetcher, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(states).toHaveLength(2);

    // 59s more: still within the interval — no extra poll.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(states).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after a failed round (fetcher rejects → unknown)", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<() => Promise<DockerStatusState>>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({ status: "ready", available: false });
    const states: DockerStatusState[] = [];

    const stop = startDockerStatusPolling((state) => states.push(state), fetcher, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(states).toEqual([{ status: "unknown" }, { status: "ready", available: false }]);
    stop();
  });

  it("discards results that resolve after stop", async () => {
    vi.useFakeTimers();
    let resolvePoll: ((state: DockerStatusState) => void) | undefined;
    const fetcher = () =>
      new Promise<DockerStatusState>((resolve) => {
        resolvePoll = resolve;
      });
    const states: DockerStatusState[] = [];

    const stop = startDockerStatusPolling((state) => states.push(state), fetcher, 5000);
    stop();
    resolvePoll?.({ status: "ready", available: true });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(states).toHaveLength(0);
  });
});
