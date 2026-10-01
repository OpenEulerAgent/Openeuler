// @vitest-environment jsdom
//
// Deep-link honoring for the Diffs tab (#52): `initialStepRunId` (from
// `?tab=diff&stepRunId=…`) selects that step run's scope on mount and when
// the link target changes — no daemon needed, fetch is stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StepRun } from "@openeuler/core";
import { ThemeProvider } from "@/components/ThemeProvider";
import { DiffsTab } from "./DiffsTab";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

// next/dynamic must stay out of the test (no Next runtime).
vi.mock("next/dynamic", () => ({
  default: () => () => createElement("div", { "data-testid": "diff-view" }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const steps: StepRun[] = [
  {
    id: "sr-1",
    runId: "run-1",
    stepId: "a",
    iteration: 1,
    status: "success",
    output: "out-a-1",
    diff: "@@ -1 +1 @@\n-a\n+b\n",
  },
  {
    id: "sr-2",
    runId: "run-1",
    stepId: "b",
    iteration: 1,
    status: "success",
    output: "out-b-1",
    diff: "",
  },
];

const okBody = {
  scope: "step",
  stat: "1 file",
  patch: "diff --git a/f b/f\n",
  truncated: false,
  totalLines: 2,
  maxLines: 5000,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

const render = (node: ReactNode): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(ThemeProvider, null, node));
  });
};

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }));
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const fetchCalls = (): string[] =>
  (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));

describe("DiffsTab deep-link scope", () => {
  it("starts on the linked step run's scope (?tab=diff&stepRunId=)", async () => {
    render(createElement(DiffsTab, { runId: "run-1", steps, initialStepRunId: "sr-2" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchCalls()).toEqual([
      expect.stringContaining("/api/runs/run-1/diff?scope=step&stepRunId=sr-2"),
    ]);
    const select = document.getElementById("diff-scope") as HTMLSelectElement | null;
    expect(select?.value).toBe("sr-2");
  });

  it("defaults to the cumulative scope without a link", async () => {
    render(createElement(DiffsTab, { runId: "run-1", steps }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchCalls()).toEqual([
      expect.stringContaining("/api/runs/run-1/diff?scope=cumulative"),
    ]);
  });

  it("follows a changing link target without remounting", async () => {
    render(createElement(DiffsTab, { runId: "run-1", steps, initialStepRunId: "sr-1" }));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      root?.render(
        createElement(
          ThemeProvider,
          null,
          createElement(DiffsTab, { runId: "run-1", steps, initialStepRunId: "sr-2" }),
        ),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const urls = fetchCalls();
    expect(urls).toEqual([
      expect.stringContaining("stepRunId=sr-1"),
      expect.stringContaining("stepRunId=sr-2"),
    ]);
  });
});
