// @vitest-environment jsdom
//
// Wizard component wiring (#53): renders the real WelcomeWizard through the
// whole flow — environment check (mocked) → open project → choose starter →
// launch — asserting the completion flag and the redirect to the run detail.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Project } from "@openeuler/core";
import { WelcomeWizard } from "@/components/onboarding/WelcomeWizard";
import { ONBOARDING_COMPLETED_KEY } from "@/lib/onboarding/wizard";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/welcome",
  useSearchParams: () => new URLSearchParams(""),
}));

const healthyCheck = {
  git: { ok: true, version: "2.43.0" },
  opencode: { ok: true, version: "1.18.34", authenticated: true },
  worktrees: { ok: true, path: "/tmp/worktrees" },
};

const project: Project = {
  id: "p_1",
  path: "/repos/demo",
  name: "demo",
  defaultBranch: "main",
  dirty: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

type RouteHandler = (init?: RequestInit) => unknown;

interface ApiMockState {
  calls: Array<{ path: string; init: RequestInit | undefined }>;
  routes: Record<string, RouteHandler>;
}

// Hoisted so the vi.mock factory can close over it without init-order issues.
const apiMock = vi.hoisted(() => {
  const state: ApiMockState = { calls: [], routes: {} };
  const apiFetch = async (path: string, init?: RequestInit): Promise<unknown> => {
    state.calls.push({ path, init });
    const handler = Object.entries(state.routes)
      .sort((a, b) => b[0].length - a[0].length)
      .find(([prefix]) => path.startsWith(prefix))?.[1];
    if (handler === undefined) throw new Error(`no mock route for ${path}`);
    return handler(init);
  };
  return { state, apiFetch };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, apiFetch: apiMock.apiFetch };
});

const body = (call: ApiMockState["calls"][number]): Record<string, unknown> =>
  JSON.parse(String(call.init?.body));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (element: ReactElement): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
};

const text = (): string => container?.textContent ?? "";

const clickByTestId = (id: string): void => {
  const el = container?.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (el === null || el === undefined) throw new Error(`missing element: ${id}`);
  act(() => {
    el.click();
  });
};

const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const setter =
    el instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  apiMock.state.calls.length = 0;
  push.mockClear();
  apiMock.state.routes = {
    "/api/system/check": () => healthyCheck,
    "/api/projects": () => ({ projects: [] }),
  };
  window.localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};

describe("WelcomeWizard", () => {
  it("walks environment → project → starter → launch and redirects to the run", async () => {
    render(<WelcomeWizard />);
    await flush();

    // Step 1: healthy check renders rows and Continue is enabled.
    expect(text()).toContain("Check your environment");
    expect(container?.querySelectorAll('[data-testid="env-check-rows"] > li').length).toBe(3);

    apiMock.state.routes = {
      ...apiMock.state.routes,
      "/api/projects": (init) =>
        init?.method === "POST" ? { project, warnings: [] } : { projects: [project] },
      "/api/workflows": () => ({
        workflow: { id: "wf_1", name: "Implement → Review → Fix" },
        revision: { id: "r", number: 1 },
      }),
      "/api/workflows/wf_1/runs": () => ({ run: { id: "run_9" } }),
    };

    clickByTestId("wizard-continue");

    // Step 2: open the project by path; no warnings → auto-advance.
    setNativeValue(
      container?.querySelector('[data-testid="wizard-project-path"]') as HTMLInputElement,
      "/repos/demo",
    );
    await flush();
    const open = [...(container?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Open",
    );
    expect(open).toBeDefined();
    act(() => open?.click());
    await flush();
    expect(text()).toContain("Choose a starter");

    // Step 3: pick the loop template.
    clickByTestId("wizard-template-implement-review-fix");
    clickByTestId("wizard-continue");
    expect(text()).toContain("Launch your first run");

    // Step 4: task → launch → redirect + completion flag.
    setNativeValue(
      container?.querySelector('[data-testid="wizard-task"]') as HTMLTextAreaElement,
      "Add a greeting module",
    );
    await flush();
    clickByTestId("wizard-launch");
    await flush();

    const create = apiMock.state.calls.find((call) => call.path === "/api/workflows");
    expect(create?.init?.method).toBe("POST");
    expect(body(create as ApiMockState["calls"][number])).toMatchObject({
      projectId: "p_1",
      name: "Implement → Review → Fix",
    });
    const runCall = apiMock.state.calls.find((call) => call.path === "/api/workflows/wf_1/runs");
    expect(body(runCall as ApiMockState["calls"][number])).toEqual({
      task: "Add a greeting module",
    });

    expect(push).toHaveBeenCalledWith("/runs/run_9");
    expect(window.localStorage.getItem(ONBOARDING_COMPLETED_KEY)).toBe("true");
  });

  it("Continue stays disabled while git is missing (opencode problems only warn)", async () => {
    apiMock.state.routes = { ...apiMock.state.routes, "/api/system/check": () => healthyCheck };
    render(<WelcomeWizard />);
    await flush();
    const cont = () =>
      container?.querySelector<HTMLButtonElement>('[data-testid="wizard-continue"]');
    expect(cont()?.disabled).toBe(false);

    apiMock.state.routes = {
      ...apiMock.state.routes,
      "/api/system/check": () => ({
        ...healthyCheck,
        git: { ok: false, hint: "install git" },
        opencode: { ok: false, hint: "install opencode" },
      }),
    };
    act(() => {
      container?.querySelector<HTMLButtonElement>('[data-testid="env-recheck"]')?.click();
    });
    await flush();
    expect(cont()?.disabled).toBe(true);
    expect(text()).toContain("git is required");
  });

  it("Skip marks completion and returns to the dashboard", async () => {
    render(<WelcomeWizard />);
    await flush();
    clickByTestId("wizard-skip");
    expect(push).toHaveBeenCalledWith("/");
    expect(window.localStorage.getItem(ONBOARDING_COMPLETED_KEY)).toBe("true");
  });
});
