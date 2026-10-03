// @vitest-environment jsdom
//
// NodeRunDrawer sub-workflow child link (#117): a completed sub-workflow
// execution carries childRunId (from the fold) and the drawer renders an
// "Open child run" link pointing at the child run's detail page.

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StepRun } from "@openeuler/core";
import type { NodeFoldState } from "@/lib/run-graph/fold";
import { NodeRunDrawer } from "./NodeRunDrawer";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const node: NodeFoldState = {
  status: "success",
  executionCount: 1,
  executions: [
    {
      iteration: 1,
      status: "success",
      output: "CHILD-OUT",
      durationMs: 1200,
      childRunId: "11111111-2222-3333-4444-555555555555",
    },
  ],
};

const steps: StepRun[] = [
  {
    id: "step-1",
    runId: "parent-run",
    stepId: "sub",
    iteration: 1,
    status: "success",
    output: "CHILD-OUT",
  },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("NodeRunDrawer child run link (#117)", () => {
  it("renders an Open child run link with the child run id when the execution carried one", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(NodeRunDrawer, {
          open: true,
          onClose: () => {},
          nodeId: "sub",
          nodeName: "spawn",
          node,
          steps,
          onOpenDiff: () => {},
        }),
      );
    });

    const link = document.querySelector("[data-node-child-run-link]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/runs/11111111-2222-3333-4444-555555555555");
    expect(link?.textContent).toContain("Open child run");
    expect(link?.textContent).toContain("11111111");
  });

  it("renders no link when the execution has no childRunId (ordinary agent node)", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(NodeRunDrawer, {
          open: true,
          onClose: () => {},
          nodeId: "a",
          nodeName: "agent",
          node: { ...node, executions: [{ iteration: 1, status: "success", output: "OK" }] },
          steps: [],
          onOpenDiff: () => {},
        }),
      );
    });
    expect(document.querySelector("[data-node-child-run-link]")).toBeNull();
  });
});
