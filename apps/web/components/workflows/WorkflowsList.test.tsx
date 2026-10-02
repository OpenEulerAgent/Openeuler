// @vitest-environment jsdom
//
// WorkflowsList rendering contract (#70): graph-era workflows render their
// current shape from the daemon-computed graph summary ("N nodes · M edges ·
// rev R" + loop/router badges) — never from the stale steps mirror — while
// legacy workflows without a summary keep the step-count + linear/loop
// display.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Workflow } from "@openeuler/core";
import type { WorkflowListed } from "@/lib/workflows-api";
import { WorkflowsList } from "./WorkflowsList";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

const step = (id: string, name: string): Workflow["steps"][number] => ({
  id,
  name,
  driver: "fake",
  mode: "auto",
  promptTemplate: "{{task}}",
  continueSession: false,
});

/** Graph-era row: the steps mirror went stale (1 step) — the summary is truth. */
const graphEra: WorkflowListed = {
  id: "w-canvas",
  projectId: "p-1",
  name: "canvas-flow",
  steps: [step("n1", "implement")],
  graphSummary: { nodeCount: 3, edgeCount: 2, hasLoop: true, hasRouter: true, revision: 2 },
};

/** Legacy rows (never saved as revisions): no summary, steps-based display. */
const legacyLoop: Workflow = {
  id: "w-legacy-loop",
  projectId: "p-1",
  name: "legacy-loop",
  steps: [step("s1", "implement"), step("s2", "review")],
  loopBack: { toStepIndex: 0, when: { type: "always" }, maxIterations: 3 },
};

const legacyLinear: Workflow = {
  id: "w-legacy-linear",
  projectId: "p-1",
  name: "legacy-linear",
  steps: [step("s1", "solo")],
};

let workflows: WorkflowListed[] = [];

let root: Root | null = null;
let container: HTMLElement | null = null;

const render = (node: ReactNode): void => {
  if (container === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(node);
  });
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

beforeEach(() => {
  workflows = [graphEra, legacyLoop, legacyLinear];
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify({ workflows }), { status: 200 }),
  );
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const listItems = (): HTMLElement[] =>
  [...document.querySelectorAll("[data-testid=workflow-list] li")] as HTMLElement[];

describe("WorkflowsList (#70: current graph shape + revision)", () => {
  it("renders the summary line with loop/router badges, ignoring the stale steps mirror", async () => {
    render(createElement(WorkflowsList, { projectId: "p-1" }));
    await settle();

    const items = listItems();
    expect(items).toHaveLength(3);
    const [canvasItem, legacyLoopItem, legacyLinearItem] = items as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];

    // Graph-era row: shape + revision from the summary, never "N steps".
    expect(canvasItem.textContent).toContain("3 nodes · 2 edges · rev 2");
    expect(canvasItem.textContent).not.toContain("step");
    expect(canvasItem.textContent).toContain("loop");
    expect(canvasItem.textContent).toContain("router");
    expect(canvasItem.textContent).not.toContain("linear");

    // Legacy fallbacks keep the steps-based display.
    expect(legacyLoopItem.textContent).toContain("2 steps");
    expect(legacyLoopItem.textContent).toContain("loop → 1. implement while always (max 3)");
    expect(legacyLinearItem.textContent).toContain("1 step");
    expect(legacyLinearItem.textContent).toContain("linear");
  });

  it("renders a plain linear badge when the summary has neither loop nor router", async () => {
    workflows = [
      {
        id: "w-chain",
        projectId: "p-1",
        name: "chain",
        steps: [step("n1", "a")],
        graphSummary: { nodeCount: 3, edgeCount: 2, hasLoop: false, hasRouter: false, revision: 1 },
      },
    ];
    render(createElement(WorkflowsList, { projectId: "p-1" }));
    await settle();

    const item = listItems()[0] as HTMLElement;
    expect(item.textContent).toContain("3 nodes · 2 edges · rev 1");
    expect(item.textContent).toContain("linear");
    expect(item.textContent).not.toContain("loop");
    expect(item.textContent).not.toContain("router");
  });
});
