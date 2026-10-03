// @vitest-environment jsdom
//
// Compare-mode flow on the dashboard runs table (#114): every row gains a
// lightweight checkbox; ticking rows reveals a "Compare (n)" button that
// navigates to /runs/compare?a=&b= exactly at two selections (0/1/2/3
// states below). Everything else about the table stays untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { DashboardRunsTable } from "@/components/dashboard/DashboardRunsTable";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

// --- navigation mock: `push` records hrefs (the compare navigation). -------
// searchParams must stay referentially stable across renders — the table's
// load effect keys off it (a fresh object per render = infinite refetch).

const pushed: string[] = vi.hoisted(() => []);

const cachedParams = new URLSearchParams("");

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
    push: (href: string) => {
      pushed.push(href);
    },
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => cachedParams,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    createElement("a", { href }, children),
}));

// --- daemon mock: three finished runs + the shared stream (idle). ----------

type Listener = (event: { data?: unknown }) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    void url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  close(): void {
    this.closed = true;
  }
}

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  text: () => Promise.resolve(JSON.stringify(body)),
  json: () => Promise.resolve(body),
});

const runs = ["r1", "r2", "r3"].map((id, index) => ({
  id,
  projectId: "p1",
  status: "success",
  branch: `run/${id}`,
  iteration: 1,
  createdAt: `2026-10-01T10:0${index}:00Z`,
  updatedAt: `2026-10-01T10:0${index}:30Z`,
  project: { id: "p1", name: "alpha" },
}));

// --- harness ----------------------------------------------------------------

interface MountResult {
  container: HTMLElement;
  unmount: () => void;
}

const roots: MountResult[] = [];

const mount = (): MountResult => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(createElement(ToastProvider, null, createElement(DashboardRunsTable, null)));
  });
  const result: MountResult = {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      const index = roots.indexOf(result);
      if (index !== -1) roots.splice(index, 1);
    },
  };
  roots.push(result);
  return result;
};

const settle = async (): Promise<void> => {
  // Fake timers are active — flush microtasks only (the mocked fetch and
  // React state updates all resolve without macrotasks).
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {});
  }
};

const compareButton = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector('[data-testid="compare-runs-button"]');

const checkbox = (container: HTMLElement, runId: string): HTMLInputElement | null =>
  container.querySelector(`[data-compare-check="${runId}"]`);

beforeEach(() => {
  vi.useFakeTimers();
  pushed.length = 0;
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return jsonResponse(url.includes("/api/projects") ? { projects: [] } : { runs });
    }),
  );
});

afterEach(() => {
  while (roots.length > 0) roots.pop()?.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DashboardRunsTable compare selection (#114)", () => {
  it("renders a compare checkbox on every row; no button until a tick", async () => {
    const view = mount();
    await settle();

    for (const run of runs) {
      const box = checkbox(view.container, run.id);
      expect(box).not.toBeNull();
      expect(box?.getAttribute("aria-label")).toBe(`Compare run/${run.id}`);
      expect(box?.checked).toBe(false);
    }
    expect(compareButton(view.container)).toBeNull();
    view.unmount();
  });

  it("0 → 1 → 2 → 3 selections drive the Compare button; exactly 2 navigates", async () => {
    const view = mount();
    await settle();

    // 1 selected: button appears, disabled.
    act(() => {
      checkbox(view.container, "r1")?.click();
    });
    const one = compareButton(view.container);
    expect(one?.textContent).toBe("Compare (1)");
    expect(one?.disabled).toBe(true);

    // 2 selected: enabled; click navigates with click order (r1 = A, r2 = B).
    act(() => {
      checkbox(view.container, "r2")?.click();
    });
    const two = compareButton(view.container);
    expect(two?.textContent).toBe("Compare (2)");
    expect(two?.disabled).toBe(false);
    act(() => {
      two?.click();
    });
    expect(pushed).toEqual(["/runs/compare?a=r1&b=r2"]);

    // 3 selected: held but disabled again until one is unticked.
    act(() => {
      checkbox(view.container, "r3")?.click();
    });
    const three = compareButton(view.container);
    expect(three?.textContent).toBe("Compare (3)");
    expect(three?.disabled).toBe(true);
    act(() => {
      checkbox(view.container, "r1")?.click();
    });
    const twoAgain = compareButton(view.container);
    expect(twoAgain?.textContent).toBe("Compare (2)");
    expect(twoAgain?.disabled).toBe(false);
    pushed.length = 0;
    act(() => {
      twoAgain?.click();
    });
    // Unticking kept click order: r2 was ticked before r3.
    expect(pushed).toEqual(["/runs/compare?a=r2&b=r3"]);
    view.unmount();
  });

  it("unticking everything removes the button again", async () => {
    const view = mount();
    await settle();
    act(() => {
      checkbox(view.container, "r1")?.click();
    });
    expect(compareButton(view.container)).not.toBeNull();
    act(() => {
      checkbox(view.container, "r1")?.click();
    });
    expect(compareButton(view.container)).toBeNull();
    view.unmount();
  });
});
