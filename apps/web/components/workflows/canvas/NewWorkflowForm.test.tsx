// @vitest-environment jsdom
//
// NewWorkflowForm driver wiring (#74): the entry agent's starter driver
// comes from GET /api/drivers — first registered id by default, selectable
// via the driver dropdown — submit stays in its loading state until the
// drivers resolve, and an unreachable endpoint falls back to `opencode`
// with a warning toast.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { NewWorkflowForm } from "./NewWorkflowForm";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
}));

type RouteHandler = (init?: RequestInit) => unknown | Promise<unknown>;

interface ApiMockState {
  calls: Array<{ path: string; init: RequestInit | undefined }>;
  drivers: RouteHandler;
  create: RouteHandler;
}

// Hoisted so the vi.mock factory can close over it without init-order issues.
const apiMock = vi.hoisted(() => {
  const state: ApiMockState = {
    calls: [],
    drivers: () => ({ drivers: ["fake", "opencode"] }),
    create: () => ({
      workflow: { id: "w-1" },
      revision: { id: "rev-1", number: 1 },
    }),
  };
  const apiFetch = async (path: string, init?: RequestInit): Promise<unknown> => {
    state.calls.push({ path, init });
    if (path === "/api/drivers") return state.drivers(init);
    if (path === "/api/workflows") return state.create(init);
    throw new Error(`no mock route for ${path}`);
  };
  return { state, apiFetch };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, apiFetch: apiMock.apiFetch };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (element: ReactElement): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const setInputValue = (input: HTMLInputElement, value: string): void => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const setSelectValue = (select: HTMLSelectElement, value: string): void => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const createCall = (): { path: string; init: RequestInit | undefined } | undefined =>
  apiMock.state.calls.find(
    (call) => call.path === "/api/workflows" && call.init?.method === "POST",
  );

const createdGraphDriver = (): string => {
  const call = createCall();
  expect(call).toBeDefined();
  const body = JSON.parse(String(call?.init?.body)) as {
    graph: { nodes: Array<{ config: { driver: string } }> };
  };
  return body.graph.nodes[0]!.config.driver;
};

const submitButton = (): HTMLButtonElement | null =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    /Create and open canvas|Creating…|Loading drivers…/.test(button.textContent ?? ""),
  ) ?? null;

const mount = (): void =>
  render(<ToastProvider>{<NewWorkflowForm projectId="p-1" />}</ToastProvider>);

beforeEach(() => {
  apiMock.state.calls.length = 0;
  apiMock.state.drivers = () => ({ drivers: ["fake", "opencode"] });
  push.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("NewWorkflowForm (#74: registered driver default + picker)", () => {
  it("creates the starter node with the first registered driver and redirects to the canvas", async () => {
    mount();
    await settle();

    const select = document.getElementById("new-workflow-driver") as HTMLSelectElement;
    expect(select.value).toBe("fake");
    expect([...select.options].map((option) => option.value)).toEqual(["fake", "opencode"]);

    setInputValue(document.getElementById("new-workflow-name") as HTMLInputElement, "demo flow");
    act(() => submitButton()?.click());
    await settle();

    expect(createdGraphDriver()).toBe("fake");
    expect(push).toHaveBeenCalledWith("/projects/p-1/workflows/w-1/edit");
  });

  it("uses the driver picked in the dropdown", async () => {
    mount();
    await settle();

    setSelectValue(document.getElementById("new-workflow-driver") as HTMLSelectElement, "opencode");
    setInputValue(document.getElementById("new-workflow-name") as HTMLInputElement, "demo flow");
    act(() => submitButton()?.click());
    await settle();

    expect(createdGraphDriver()).toBe("opencode");
  });

  it("keeps the submit button loading until the drivers resolve", async () => {
    let resolveDrivers: (body: unknown) => void = () => {};
    apiMock.state.drivers = () =>
      new Promise((resolve) => {
        resolveDrivers = resolve;
      });

    mount();
    setInputValue(document.getElementById("new-workflow-name") as HTMLInputElement, "demo flow");
    await settle();

    const button = submitButton();
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.textContent).toContain("Loading drivers…");
    expect((document.getElementById("new-workflow-driver") as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect(createCall()).toBeUndefined();

    await act(async () => {
      resolveDrivers({ drivers: ["fake", "opencode"] });
    });
    await settle();

    const settledButton = submitButton();
    expect(settledButton?.disabled).toBe(false);
    expect(settledButton?.getAttribute("aria-busy")).toBeNull();
    expect((document.getElementById("new-workflow-driver") as HTMLSelectElement).disabled).toBe(
      false,
    );
  });

  it("falls back to opencode with a warning toast when /api/drivers fails", async () => {
    apiMock.state.drivers = () => Promise.reject(new Error("daemon down"));
    mount();
    await settle();

    expect((document.getElementById("new-workflow-driver") as HTMLSelectElement).value).toBe(
      "opencode",
    );
    expect(document.body.textContent).toContain("Driver list unavailable");

    setInputValue(document.getElementById("new-workflow-name") as HTMLInputElement, "demo flow");
    act(() => submitButton()?.click());
    await settle();

    expect(createdGraphDriver()).toBe("opencode");
  });
});
