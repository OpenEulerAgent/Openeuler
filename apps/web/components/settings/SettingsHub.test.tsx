// @vitest-environment jsdom
//
// Settings hub wiring (#95): sections render from a mocked
// GET /api/system/settings payload; each danger-zone action gates on its
// confirm dialog (type-to-confirm + days input for the purge), POSTs
// /api/system/maintenance, reports counts as toasts, and refetches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { SettingsHub } from "./SettingsHub";
import type { SystemSettings } from "@/lib/settings";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const payload: SystemSettings = {
  version: "0.2.0",
  dbPath: "/data/openeuler.db",
  dbBytes: 4096,
  worktreeRoot: "/home/dev/.openeuler/worktrees",
  worktreeBytes: 1_048_576,
  drivers: [{ id: "fake" }, { id: "opencode" }],
  defaultDriver: "fake",
  maxConcurrentRuns: 4,
  authEnabled: false,
  uptimeSeconds: 3661,
};

const fetchMock = vi.fn();

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Call {
  url: string;
  init?: RequestInit;
}

const calls: Call[] = [];
const maintenanceBodies: Array<Record<string, unknown>> = [];
let maintenanceResponse: () => Response = () => jsonResponse({});

const stubFetch = (): void => {
  fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    calls.push({ url: path, init });
    if (path.endsWith("/api/system/maintenance")) {
      maintenanceBodies.push(
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      );
      return maintenanceResponse();
    }
    return jsonResponse(payload);
  });
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(createElement(ToastProvider, null, createElement(SettingsHub))));
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const text = (): string => document.body.textContent ?? "";

const buttons = (): HTMLButtonElement[] =>
  [...document.querySelectorAll("button")] as HTMLButtonElement[];

const button = (label: string): HTMLButtonElement | undefined =>
  buttons().find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );

const setInputValue = (id: string, value: string): void => {
  const input = document.getElementById(id) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const dialogVisible = (): boolean => document.querySelector('[role="dialog"]') !== null;

const settingsCalls = (): Call[] =>
  calls.filter((call) => call.url.includes("/api/system/settings"));

beforeEach(() => {
  fetchMock.mockReset();
  calls.length = 0;
  maintenanceBodies.length = 0;
  maintenanceResponse = () => jsonResponse({});
  stubFetch();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("SettingsHub sections (#95)", () => {
  it("renders System, Drivers, Concurrency, Storage and Danger zone from the payload", async () => {
    render();
    await settle();

    // System: version, uptime, db path + size.
    expect(text()).toContain("0.2.0");
    expect(text()).toContain("1h 01m");
    expect(text()).toContain("/data/openeuler.db");
    expect(text()).toContain("4.0 KB");
    expect(text()).toContain("/home/dev/.openeuler/worktrees");
    // Drivers: ids + the default marker.
    expect(text()).toContain("fake (default)");
    expect(text()).toContain("opencode");
    // Concurrency.
    expect(text()).toContain("4 concurrent runs");
    expect(text()).toContain("MAX_CONCURRENT_RUNS");
    // Storage.
    expect(text()).toContain("1.0 MB");
    // Danger zone actions.
    expect(button("Prune worktrees")).toBeDefined();
    expect(button("Purge old events")).toBeDefined();
    expect(button("Vacuum database")).toBeDefined();
  });

  it("shows an error card with retry when the settings request fails", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    render();
    await settle();

    expect(text()).toContain("Could not load daemon settings");

    fetchMock.mockImplementation(async () => jsonResponse(payload));
    const retry = button("Retry");
    expect(retry).toBeDefined();
    act(() => retry?.click());
    await settle();
    expect(text()).toContain("0.2.0");
  });

  it("copies a path to the clipboard and confirms with a toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render();
    await settle();

    const copy = button("Copy");
    expect(copy).toBeDefined();
    act(() => copy?.click());
    await settle();
    // The first Copy button belongs to the Database fact row.
    expect(writeText).toHaveBeenCalledWith("/data/openeuler.db");
    expect(text()).toContain("Copied to clipboard");
  });
});

describe("danger zone: prune worktrees (#95)", () => {
  it("confirms, POSTs the action, toasts counts and refetches settings", async () => {
    maintenanceResponse = () =>
      jsonResponse({ action: "prune-worktrees", removed: 3, remaining: 0 });
    render();
    await settle();
    calls.length = 0;

    act(() => button("Prune worktrees")?.click());
    expect(dialogVisible()).toBe(true);
    expect(button("Confirm prune")).toBeDefined();

    act(() => button("Confirm prune")?.click());
    await settle();

    expect(maintenanceBodies).toEqual([{ action: "prune-worktrees" }]);
    expect(text()).toContain("Worktrees pruned");
    expect(text()).toContain("3 orphaned directories removed");
    expect(settingsCalls().some((call) => call.url.includes("refresh=1"))).toBe(true);
    expect(dialogVisible()).toBe(false);
  });

  it("cancel closes the dialog without POSTing", async () => {
    render();
    await settle();
    calls.length = 0;

    act(() => button("Prune worktrees")?.click());
    act(() => button("Cancel")?.click());
    await settle();

    expect(dialogVisible()).toBe(false);
    expect(maintenanceBodies).toEqual([]);
    expect(calls.length).toBe(0);
  });
});

describe("danger zone: purge old events (#95)", () => {
  it("requires the typed word, sends the days param, toasts and refetches", async () => {
    maintenanceResponse = () => jsonResponse({ action: "purge-events", deleted: 9, dbBytes: 2048 });
    render();
    await settle();
    calls.length = 0;

    act(() => button("Purge old events")?.click());
    expect(dialogVisible()).toBe(true);

    // Type-to-confirm gate: confirm stays disabled until "purge" is typed.
    expect((document.getElementById("purge-days") as HTMLInputElement).value).toBe("30");
    setInputValue("purge-confirm", "nope");
    expect(button("Confirm purge")?.disabled).toBe(true);

    setInputValue("purge-days", "7");
    setInputValue("purge-confirm", "purge");
    expect(button("Confirm purge")?.disabled).toBe(false);

    act(() => button("Confirm purge")?.click());
    await settle();

    expect(maintenanceBodies).toEqual([{ action: "purge-events", days: 7 }]);
    expect(text()).toContain("Event log purged");
    expect(text()).toContain("9 events deleted");
    expect(settingsCalls().some((call) => call.url.includes("refresh=1"))).toBe(true);
  });

  it("keeps confirm disabled for an invalid days value", async () => {
    render();
    await settle();

    act(() => button("Purge old events")?.click());
    setInputValue("purge-days", "-2");
    setInputValue("purge-confirm", "purge");
    expect(button("Confirm purge")?.disabled).toBe(true);
  });
});

describe("danger zone: vacuum (#95)", () => {
  it("confirms without type-to-confirm, toasts the new size and refetches", async () => {
    maintenanceResponse = () => jsonResponse({ action: "vacuum", dbBytes: 4096 });
    render();
    await settle();
    calls.length = 0;

    act(() => button("Vacuum database")?.click());
    expect(dialogVisible()).toBe(true);
    // Plain confirm: no typed word required.
    expect(button("Confirm vacuum")?.disabled).toBe(false);

    act(() => button("Confirm vacuum")?.click());
    await settle();

    expect(maintenanceBodies).toEqual([{ action: "vacuum" }]);
    expect(text()).toContain("Database vacuumed");
    expect(text()).toContain("Database is now 4.0 KB");
    expect(settingsCalls().some((call) => call.url.includes("refresh=1"))).toBe(true);
  });

  it("surfaces a failed action as a danger toast", async () => {
    maintenanceResponse = () =>
      jsonResponse({ error: { code: "MAINTENANCE_FAILED", message: "disk on fire" } }, 500);
    render();
    await settle();

    act(() => button("Vacuum database")?.click());
    act(() => button("Confirm vacuum")?.click());
    await settle();

    expect(text()).toContain("Maintenance failed");
    expect(text()).toContain("disk on fire");
  });
});
