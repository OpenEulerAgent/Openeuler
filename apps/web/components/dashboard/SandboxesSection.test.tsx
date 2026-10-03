// @vitest-environment jsdom
//
// Sandboxes dashboard section (#112): grid render (image chip, status
// badge, run link, usage bars, count), empty + docker-unavailable states,
// stop/destroy arm-confirm flows with optimistic updates and failure
// toasts, and polling lifecycle + cleanup on unmount.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { SandboxesSection } from "@/components/dashboard/SandboxesSection";
import {
  destroySandboxInstance,
  fetchSandboxInstances,
  fetchSandboxStatus,
  stopSandboxInstance,
  type SandboxInstance,
  type SandboxInstancesPayload,
} from "@/lib/sandbox-api";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

// The section is a pure client of the sandbox-api module — mock the whole
// surface (instances fetch + stop/destroy + the docker status the pill and
// banner consume) so no network is touched.
vi.mock("@/lib/sandbox-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sandbox-api")>();
  return {
    ...actual,
    fetchSandboxInstances: vi.fn(),
    fetchSandboxStatus: vi.fn(),
    stopSandboxInstance: vi.fn(),
    destroySandboxInstance: vi.fn(),
  };
});

// next/link would need the real app router; a plain anchor renders the same
// (passing the rest props through so data-testids survive).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children),
}));

const instance = (overrides: Partial<SandboxInstance> = {}): SandboxInstance => ({
  id: "sb-1",
  runId: "run-1",
  image: "openeuler/worker:latest",
  status: "running",
  startedAt: Date.now() - 60_000,
  usage: { cpuPercent: 12.5, memMb: 210, memLimitMb: 2048 },
  run: { id: "run-1", status: "running", project: { id: "p1", name: "demo" } },
  ...overrides,
});

const instancesFetch = vi.mocked(fetchSandboxInstances);
const stopFetch = vi.mocked(stopSandboxInstance);
const destroyFetch = vi.mocked(destroySandboxInstance);
const statusFetch = vi.mocked(fetchSandboxStatus);

/** Docker available by default; individual tests override. */
const dockerAvailable = (available: boolean): void => {
  statusFetch.mockImplementation(async () => ({
    available,
    ...(available ? { version: "27.3.1" } : {}),
    mode: available ? "docker" : "unavailable",
    checkedAt: 1,
  }));
};

const resolveInstances = (instances: SandboxInstance[]): void => {
  const payload: SandboxInstancesPayload = { instances, checkedAt: 1 };
  instancesFetch.mockImplementation(async () => payload);
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const renderSection = (): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(ToastProvider, null, createElement(SandboxesSection)));
  });
};

const settle = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const click = (element: Element | null): void => {
  act(() => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

beforeEach(() => {
  vi.useRealTimers();
  dockerAvailable(true);
  instancesFetch.mockReset();
  stopFetch.mockReset().mockImplementation(async () => undefined);
  destroyFetch.mockReset().mockImplementation(async () => undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("SandboxesSection render (#112)", () => {
  it("renders one card per instance with image, status, run link and usage bars", async () => {
    resolveInstances([
      instance(),
      instance({ id: "sb-2", runId: null, run: undefined, status: "exited", usage: undefined }),
    ]);

    renderSection();
    await settle();

    const section = document.querySelector('[data-testid="sandboxes-section"]');
    expect(section?.getAttribute("id")).toBe("sandboxes");

    const cards = document.querySelectorAll('[data-testid="sandbox-card"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('[data-testid="sandbox-image"]')?.textContent).toBe(
      "openeuler/worker:latest",
    );
    expect(cards[0]?.querySelector('[data-testid="sandbox-status"]')?.textContent).toContain(
      "Running",
    );

    const link = cards[0]?.querySelector('[data-testid="sandbox-run-link"]');
    expect(link?.getAttribute("href")).toBe("/runs/run-1");
    expect(link?.textContent).toContain("demo");

    const cpu = cards[0]?.querySelector('[data-testid="sandbox-cpu-bar"]');
    expect(cpu?.textContent).toContain("12.5%");
    const mem = cards[0]?.querySelector('[data-testid="sandbox-mem-bar"]');
    expect(mem?.textContent).toContain("210 MiB");
    expect(mem?.textContent).toContain("2.0 GiB");

    expect(document.querySelector('[data-testid="sandboxes-count"]')?.textContent).toContain(
      "1 running · 2 total",
    );
  });

  it("renders the empty state explaining sandbox mode when no instances exist", async () => {
    resolveInstances([]);
    renderSection();
    await settle();

    const empty = document.querySelector('[data-testid="sandboxes-empty"]');
    expect(empty?.textContent).toContain("No sandboxes");
    expect(empty?.textContent).toContain("sandbox or auto");
    expect(document.querySelector('[data-testid="sandbox-grid"]')).toBeNull();
  });

  it("shows the docker-unavailable banner while docker is down", async () => {
    dockerAvailable(false);
    resolveInstances([]);
    renderSection();
    await settle();

    const banner = document.querySelector('[data-testid="sandboxes-docker-banner"]');
    expect(banner?.textContent).toContain("Docker unavailable");
  });
});

describe("SandboxesSection actions (#112)", () => {
  it("stop requires confirmation, then optimistically flips the status", async () => {
    resolveInstances([instance()]);
    renderSection();
    await settle();

    const stopButton = document.querySelector('[data-testid="sandbox-stop"]');
    expect(stopButton?.textContent).toBe("Stop");
    click(stopButton);
    // Nothing fired before the explicit confirm.
    expect(stopFetch).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="sandbox-stop-confirm"]')?.textContent).toBe(
      "Confirm stop",
    );

    click(document.querySelector('[data-testid="sandbox-stop-confirm"]'));
    await settle();
    expect(stopFetch).toHaveBeenCalledWith("sb-1");
    expect(document.querySelector('[data-testid="sandbox-status"]')?.textContent).toContain(
      "Exited",
    );
  });

  it("destroy requires confirmation, then optimistically removes the card", async () => {
    resolveInstances([instance({ id: "sb-x" })]);
    renderSection();
    await settle();

    click(document.querySelector('[data-testid="sandbox-destroy"]'));
    expect(destroyFetch).not.toHaveBeenCalled();
    click(document.querySelector('[data-testid="sandbox-destroy-confirm"]'));
    await settle();
    expect(destroyFetch).toHaveBeenCalledWith("sb-x");
    expect(document.querySelector('[data-testid="sandbox-card"]')).toBeNull();
  });

  it("restores the card and toasts when destroy fails", async () => {
    destroyFetch.mockImplementation(async () => {
      throw new (await import("@/lib/api")).ApiError("SANDBOX_ERROR", "rm failed", 500);
    });
    resolveInstances([instance({ id: "sb-fail" })]);
    renderSection();
    await settle();

    click(document.querySelector('[data-testid="sandbox-destroy"]'));
    click(document.querySelector('[data-testid="sandbox-destroy-confirm"]'));
    await settle(6);

    expect(document.querySelector('[data-testid="sandbox-card"]')).not.toBeNull();
    const toasts = [...document.querySelectorAll('[role="alert"]')].map(
      (node) => node.textContent ?? "",
    );
    expect(toasts.some((text) => text.includes("Destroy failed"))).toBe(true);
  });
});

describe("SandboxesSection polling (#112)", () => {
  it("polls while mounted and stops cleanly on unmount", async () => {
    vi.useFakeTimers();
    resolveInstances([]);

    renderSection();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(instancesFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(instancesFetch).toHaveBeenCalledTimes(2);

    act(() => root?.unmount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(instancesFetch).toHaveBeenCalledTimes(2); // no further polls
  });
});
