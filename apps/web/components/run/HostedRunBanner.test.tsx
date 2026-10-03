// @vitest-environment jsdom
//
// Hosted banner (#110): countdown headline ticking down, +30m quick extend
// POSTing the extend endpoint, Stop hosting's inline confirm → POST stop,
// 409 tolerance (hosting ended on its own → refresh, no error), and
// rendering nothing when the run is not hosted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HostedRunBanner } from "./HostedRunBanner";
import type { RunHostingView } from "@/lib/hosting";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const render = async (node: () => ReactNode): Promise<void> => {
  if (container === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(node());
  });
  await settle();
};

/** Flushes pending microtasks inside act (probe promises land). */
const settle = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      // Under fake timers a real setTimeout never fires — advance 0ms,
      // which flushes due timers plus the microtask queue.
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }
};

const fetchMock = vi.fn();

const BASE = "http://localhost:8787";

const ok = (): Response => new Response("{}", { status: 200 });
const conflict = (): Response =>
  new Response(JSON.stringify({ error: { code: "RUN_NOT_HOSTED", message: "not hosted" } }), {
    status: 409,
    headers: { "content-type": "application/json" },
  });

const hosting = (until: string): RunHostingView => ({
  until,
  ports: [{ container: 3000, host: 49153 }],
  extendable: true,
});

const banner = (): HTMLElement => document.querySelector("[data-hosted-banner]") as HTMLElement;
const countdown = (): HTMLElement =>
  document.querySelector("[data-hosted-countdown]") as HTMLElement;

const findButton = (selector: string): HTMLButtonElement =>
  document.querySelector(selector) as HTMLButtonElement;

const click = (el: HTMLElement | null): void => {
  act(() => {
    el?.click();
  });
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ok());
  globalThis.fetch = fetchMock as typeof fetch;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("HostedRunBanner rendering (#110)", () => {
  it("renders the countdown headline + mapped-port count; hides without hosting", async () => {
    const until = new Date(Date.now() + 42 * 60_000).toISOString();
    await render(() =>
      createElement(HostedRunBanner, { runId: "run-1", hosting: hosting(until), onChanged: () => {} }),
    );

    expect(banner().getAttribute("data-hosted-until")).toBe(until);
    expect(countdown().textContent).toMatch(/^Hosted — preview live · expires in 4[12]m$/);
    expect(banner().textContent).toContain("1 mapped port");
    expect(findButton("[data-hosted-extend]")).not.toBeNull();
    expect(findButton("[data-hosted-stop]")).not.toBeNull();

    await render(() => createElement(HostedRunBanner, { runId: "run-1", hosting: null, onChanged: () => {} }));
    expect(banner()).toBeNull();
  });

  it("ticks the countdown down each second", async () => {
    vi.useFakeTimers();
    // 59s window: "<1m" from the start, flipping to expired at the mark.
    const until = new Date(Date.now() + 59_000).toISOString();
    await render(() =>
      createElement(HostedRunBanner, { runId: "run-1", hosting: hosting(until), onChanged: () => {} }),
    );
    expect(countdown().textContent).toContain("<1m");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(91_000);
    });
    expect(countdown().textContent).toContain("expired");
  });
});

describe("HostedRunBanner extend (#110)", () => {
  it("+30m POSTs the extend endpoint with minutes=30 and refreshes", async () => {
    const onChanged = vi.fn();
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    await render(() =>
      createElement(HostedRunBanner, {
        runId: "run-1",
        hosting: hosting(until),
        onChanged,
      }),
    );

    click(findButton("[data-hosted-extend]"));
    await settle();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/runs/run-1/hosting/extend`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ minutes: 30 });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("treats a 409 as already-ended (refresh, no error surfaced)", async () => {
    fetchMock.mockImplementation(async () => conflict());
    const onChanged = vi.fn();
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    await render(() =>
      createElement(HostedRunBanner, {
        runId: "run-1",
        hosting: hosting(until),
        onChanged,
      }),
    );

    click(findButton("[data-hosted-extend]"));
    await settle();

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(banner().textContent).not.toContain("Failed");
  });

  it("surfaces a non-409 failure inline", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: "X", message: "daemon down" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    const onChanged = vi.fn();
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    await render(() =>
      createElement(HostedRunBanner, {
        runId: "run-1",
        hosting: hosting(until),
        onChanged,
      }),
    );

    click(findButton("[data-hosted-extend]"));
    await settle();

    expect(onChanged).not.toHaveBeenCalled();
    expect(banner().textContent).toContain("daemon down");
  });
});

describe("HostedRunBanner stop (#110)", () => {
  it("arms a confirm, then POSTs the stop endpoint and refreshes", async () => {
    const onChanged = vi.fn();
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    await render(() =>
      createElement(HostedRunBanner, {
        runId: "run-1",
        hosting: hosting(until),
        onChanged,
      }),
    );

    // First click only arms the confirm.
    click(findButton("[data-hosted-stop]"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(banner().textContent).toContain("Destroy the sandbox now?");

    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm stop",
    ) as HTMLButtonElement;
    click(confirm);
    await settle();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/runs/run-1/hosting/stop`);
    expect(init.method).toBe("POST");
    expect(onChanged).toHaveBeenCalledTimes(1);
    // Confirm disarmed after completion.
    expect(banner().textContent).not.toContain("Destroy the sandbox now?");
  });

  it("Escape cancels the confirm without posting", async () => {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    await render(() =>
      createElement(HostedRunBanner, { runId: "run-1", hosting: hosting(until), onChanged: () => {} }),
    );

    click(findButton("[data-hosted-stop]"));
    act(() => {
      banner().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(banner().textContent).not.toContain("Destroy the sandbox now?");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
