// @vitest-environment jsdom
//
// RunCompareView (#114) client flow: mocked daemon serves both run details
// and both cumulative diffs; the page renders side-by-side stat cards with
// event sparkbars, the aligned node-execution table (A-only nodes, loop
// iterations), and the cumulative diff panels with files-only-in-A/B chips.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunCompareView } from "./RunCompareView";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

// --- daemon mock ------------------------------------------------------------

const runA = {
  id: "run-a",
  projectId: "p1",
  workflowId: "wf-1",
  workflowRevisionId: "rev-2",
  status: "failed",
  branch: "agentloop/run-a",
  iteration: 0,
  ports: [3000],
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:02:30Z",
  workflowRevision: { id: "rev-2", number: 2 },
  project: { id: "p1", name: "demo" },
  workflow: { id: "wf-1", name: "Feature pipeline" },
};

const runB = {
  id: "run-b",
  projectId: "p1",
  workflowId: "wf-1",
  workflowRevisionId: "rev-5",
  status: "success",
  branch: "agentloop/run-b",
  iteration: 0,
  createdAt: "2026-10-01T11:00:00Z",
  updatedAt: "2026-10-01T11:04:10Z",
  workflowRevision: { id: "rev-5", number: 5 },
  project: { id: "p1", name: "demo" },
  workflow: { id: "wf-1", name: "Feature pipeline" },
};

const step = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  runId: "run-a",
  iteration: 1,
  status: "success",
  output: "ok",
  ...overrides,
});

const detailA = {
  run: runA,
  steps: [
    step({
      id: "sa-1",
      runId: "run-a",
      stepId: "impl",
      name: "Implementer",
      iteration: 1,
      output: "impl pass 1",
      durationMs: 90_000,
    }),
    step({
      id: "sa-2",
      runId: "run-a",
      stepId: "impl",
      name: "Implementer",
      iteration: 2,
      output: "impl pass 2\nmore detail\neven more",
      durationMs: 150_000,
    }),
    step({
      id: "sa-3",
      runId: "run-a",
      stepId: "fixer",
      name: "Fixer",
      iteration: 2,
      status: "failed",
      output: "boom",
      durationMs: 3_000,
    }),
  ],
  summary: { eventCount: 10 },
  sandbox: { id: "sb-1", image: "openeuler/node:20", status: "running" },
};

const detailB = {
  run: runB,
  steps: [
    step({
      id: "sb-1",
      runId: "run-b",
      stepId: "impl",
      name: "Implementer",
      iteration: 1,
      output: "impl pass 1 (b)",
    }),
    step({
      id: "sb-2",
      runId: "run-b",
      stepId: "impl",
      name: "Implementer",
      iteration: 2,
      output: "impl pass 2 (b)",
      durationMs: 40_000,
    }),
    step({
      id: "sb-3",
      runId: "run-b",
      stepId: "tester",
      name: "Tester",
      iteration: 2,
      output: "tests green",
      durationMs: 8_000,
    }),
  ],
  summary: { eventCount: 5 },
};

const filePatch = (path: string, next: string): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${next}\n`;

const diffA = {
  scope: "cumulative",
  stat: "2 files changed",
  patch: filePatch("shared.ts", "a-version") + filePatch("only-a.ts", "added"),
  truncated: false,
  totalLines: 12,
  maxLines: 20_000,
};

const diffB = {
  scope: "cumulative",
  stat: "2 files changed",
  patch: filePatch("shared.ts", "b-version") + filePatch("only-b.md", "added"),
  truncated: false,
  totalLines: 12,
  maxLines: 20_000,
};

const fetchRoutes: Record<string, unknown> = {
  "/api/runs/run-a": detailA,
  "/api/runs/run-b": detailB,
  "/api/runs/run-a/diff": diffA,
  "/api/runs/run-b/diff": diffB,
};

const fetchCalls: string[] = [];

beforeEach(() => {
  fetchCalls.length = 0;
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const href = String(url);
    fetchCalls.push(href);
    const path = href.replace("http://localhost:8787", "").split("?")[0] as string;
    const body = fetchRoutes[path];
    if (body === undefined)
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

// --- harness ----------------------------------------------------------------

let root: Root | null = null;
let container: HTMLElement | null = null;

const render = (node: () => ReactNode): void => {
  if (container === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(node());
  });
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe("RunCompareView (client flow)", () => {
  it("renders both runs' stat cards with sparkbars, alignment and diff chips", async () => {
    render(() => createElement(RunCompareView, { aId: "run-a", bId: "run-b" }));
    await settle();

    expect(fetchCalls).toContain("http://localhost:8787/api/runs/run-a");
    expect(fetchCalls).toContain("http://localhost:8787/api/runs/run-b");
    expect(fetchCalls.some((href) => href.includes("/api/runs/run-a/diff?scope=cumulative"))).toBe(
      true,
    );
    expect(fetchCalls.some((href) => href.includes("/api/runs/run-b/diff?scope=cumulative"))).toBe(
      true,
    );

    // Stat cards: A failed/sandboxed/rev 2, B success/local/rev 5.
    const cardA = document.querySelector('[data-testid="compare-card-a"]') as HTMLElement;
    const cardB = document.querySelector('[data-testid="compare-card-b"]') as HTMLElement;
    expect(cardA.textContent).toContain("Failed");
    expect(cardA.textContent).toContain("Sandboxed · openeuler/node:20");
    expect(cardA.textContent).toContain("r2");
    expect(cardA.textContent).toContain("3000");
    expect(cardA.textContent).toContain("2m 30s");
    expect(cardB.textContent).toContain("Success");
    expect(cardB.textContent).toContain("Local");
    expect(cardB.textContent).toContain("r5");
    expect(cardB.textContent).toContain("4m 10s");

    // Event sparkbars: A (10) full-width, B (5) half of the shared max.
    const sparkA = document.querySelector('[data-testid="compare-spark-a"]') as HTMLElement;
    const sparkB = document.querySelector('[data-testid="compare-spark-b"]') as HTMLElement;
    expect(sparkA.style.width).toBe("100%");
    expect(sparkB.style.width).toBe("50%");
    expect(cardA.textContent).toContain("10");
    expect(cardB.textContent).toContain("5");

    // Aligned rows: impl#1 + impl#2 shared, fixer#2 only in A, tester#2 only in B.
    const rowKeys = [...document.querySelectorAll("[data-compare-row]")].map((row) =>
      row.getAttribute("data-compare-row"),
    );
    expect(rowKeys).toEqual(["impl#1", "impl#2", "fixer#2", "tester#2"]);
    const fixerRow = document.querySelector('[data-compare-row="fixer#2"]') as HTMLElement;
    expect(fixerRow.querySelector('[data-compare-cell="a"]')?.textContent).toContain("Failed");
    expect(fixerRow.querySelector('[data-compare-cell="b"]')?.textContent?.trim()).toBe("—");
    const testerRow = document.querySelector('[data-compare-row="tester#2"]') as HTMLElement;
    expect(testerRow.querySelector('[data-compare-cell="a"]')?.textContent?.trim()).toBe("—");

    // Output clipped to 2 lines in the shared impl#2 row (A side).
    const impl2 = document.querySelector('[data-compare-row="impl#2"]') as HTMLElement;
    const outputs = impl2.querySelectorAll('[data-compare-cell="a"] [data-step-output]');
    expect(outputs[0]?.textContent).toContain("impl pass 2");
    expect(outputs[0]?.textContent).toContain("more detail");
    expect(outputs[0]?.textContent).not.toContain("even more");

    // Duration columns: A's impl#2 2m 30s; B's impl#1 has no duration → —.
    expect(impl2.querySelector('[data-compare-cell="a"]')?.textContent).toContain("2m 30s");
    const impl1 = document.querySelector('[data-compare-row="impl#1"]') as HTMLElement;
    expect(impl1.querySelector('[data-compare-cell="b"]')?.textContent).toContain("—");

    // Diff chips: only-in-A / only-in-B / both.
    const chips = document.querySelector("[data-compare-file-chips]") as HTMLElement;
    expect(chips.querySelector('[data-file-only="a"]')?.textContent).toBe("only-a.ts");
    expect(chips.querySelector('[data-file-only="b"]')?.textContent).toBe("only-b.md");
    expect(chips.textContent).toContain("Changed in both: 1 file");

    // Both panels carry their own patch text.
    const panelA = document.querySelector('[data-testid="compare-diff-a"]') as HTMLElement;
    const panelB = document.querySelector('[data-testid="compare-diff-b"]') as HTMLElement;
    expect(panelA.textContent).toContain("only-a.ts");
    expect(panelA.textContent).toContain("+a-version");
    expect(panelB.textContent).toContain("only-b.md");
    expect(panelB.textContent).toContain("+b-version");
  });

  it("survives a gone worktree: diff panel explains, page stays whole", async () => {
    fetchRoutes["/api/runs/run-a/diff"] = undefined;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      const path = href.replace("http://localhost:8787", "").split("?")[0] as string;
      if (path === "/api/runs/run-a/diff") {
        return new Response(
          JSON.stringify({
            error: { code: "WORKTREE_GONE", message: "the worktree no longer exists" },
          }),
          { status: 410 },
        );
      }
      const body = fetchRoutes[path];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    render(() => createElement(RunCompareView, { aId: "run-a", bId: "run-b" }));
    await settle();

    const panelA = document.querySelector('[data-testid="compare-diff-a"]') as HTMLElement;
    expect(panelA.querySelector("[data-diff-missing]")?.textContent).toContain(
      "the worktree no longer exists",
    );
    // File chips stay hidden (they need BOTH patches)…
    expect(document.querySelector("[data-compare-file-chips]")).toBeNull();
    // …but B's panel and the aligned table still render.
    expect(document.querySelector('[data-testid="compare-diff-b"]')?.textContent).toContain(
      "only-b.md",
    );
    expect(document.querySelectorAll("[data-compare-row]").length).toBe(4);
  });

  it("shows a not-found card when one side's run id is unknown", async () => {
    render(() => createElement(RunCompareView, { aId: "run-a", bId: "nope" }));
    await settle();

    expect(document.body.textContent).toContain("Run B not found");
    expect(document.querySelector("[data-run-compare]")).toBeNull();
  });
});
