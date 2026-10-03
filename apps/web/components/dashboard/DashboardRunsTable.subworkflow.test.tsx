// @vitest-environment jsdom
//
// DashboardRunsTable sub-workflow lineage (#117): child runs show a
// "child of <run>" link to the parent; parents show an "N child runs" link
// into their detail page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { DashboardRunsTable } from "@/components/dashboard/DashboardRunsTable";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

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

type Listener = (event: { data?: unknown }) => void;

class MockEventSource {
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(url: string) {
    void url;
  }
  addEventListener(type: string, listener: Listener): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
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

const runs = [
  {
    id: "parent-run",
    projectId: "p1",
    status: "success",
    branch: "run/parent-run",
    iteration: 1,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:30Z",
    project: { id: "p1", name: "alpha" },
    childRunIds: ["child-run-1", "child-run-2"],
  },
  {
    id: "child-run-1",
    projectId: "p1",
    status: "success",
    branch: "run/child-run-1",
    iteration: 1,
    createdAt: "2026-10-01T10:01:00Z",
    updatedAt: "2026-10-01T10:01:30Z",
    project: { id: "p1", name: "alpha" },
    parentRunId: "parent-run",
  },
  {
    id: "plain-run",
    projectId: "p1",
    status: "failed",
    branch: "run/plain-run",
    iteration: 1,
    createdAt: "2026-10-01T10:02:00Z",
    updatedAt: "2026-10-01T10:02:30Z",
    project: { id: "p1", name: "alpha" },
  },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  pushed.length = 0;
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
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DashboardRunsTable sub-workflow lineage (#117)", () => {
  it("child rows link up to the parent; parent rows link to their detail with the child count", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const r = createRoot(container);
    root = r;
    act(() => {
      r.render(createElement(ToastProvider, null, createElement(DashboardRunsTable, null)));
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {});
    }

    // The next/link mock only forwards href, so locate by href + copy.
    const childOf = [...container.querySelectorAll('a[href="/runs/parent-run"]')].find((el) =>
      el.textContent?.includes("child of"),
    ) as HTMLAnchorElement | undefined;
    expect(childOf).toBeDefined();
    expect(childOf?.textContent).toContain("child of");
    expect(childOf?.textContent).toContain("parent-r");

    const count = [...container.querySelectorAll('a[href="/runs/parent-run"]')].find((el) =>
      el.textContent?.includes("child runs"),
    ) as HTMLAnchorElement | undefined;
    expect(count).toBeDefined();
    expect(count?.textContent).toContain("2 child runs");

    // An ordinary run carries neither lineage marker (its workflow cell has
    // a single link).
    const plainLinks = [...container.querySelectorAll('a[href="/runs/plain-run"]')].filter((el) =>
      el.textContent?.includes("child"),
    );
    expect(plainLinks).toHaveLength(0);
  });
});
