// @vitest-environment jsdom
//
// ValidationPanel severity grouping (#68): mixed docs render blockers first,
// then hints, under one count summary ("2 blockers · 1 hint"); clicking a
// row — blocker or hint — hands the exact issue back for focusing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ValidationPanel } from "./ValidationPanel";
import type { CanvasIssue } from "@/lib/graph/validation";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (node: ReactNode): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("ValidationPanel severity grouping", () => {
  const issues: CanvasIssue[] = [
    {
      nodeId: "b",
      field: "config.promptTemplate",
      message: "promptTemplate must be a non-empty string",
    },
    {
      nodeId: "c",
      message: 'node "c" is not reachable from the entry node "a"',
    },
    {
      edgeId: "e-a-d",
      field: "condition.pattern",
      message: "pattern must be a non-empty string",
    },
    {
      nodeId: "b",
      message:
        'node "b" has 2 unconditional (always) outgoing edges; at most one is allowed (as the router fallback)',
    },
  ];

  it("groups blockers first, hints second, with a combined count summary", () => {
    const onFocusIssue = vi.fn();
    render(
      createElement(ValidationPanel, {
        issues,
        nodeNames: new Map([
          ["b", "Agent 2"],
          ["c", "Agent 3"],
        ]),
        onFocusIssue,
      }),
    );

    const text = container?.textContent ?? "";
    expect(text).toContain("2 blockers · 2 hints — fix to save");
    expect(text).toContain("promptTemplate must be a non-empty string");
    expect(text).toContain("Connect this node to the flow");
    expect(text).toContain("Set a condition on this edge");

    // Blocker rows come before hint rows in the DOM.
    const blockers = container?.querySelector("[data-validation-blockers]");
    const hints = container?.querySelector("[data-validation-hints]");
    expect(blockers).not.toBeNull();
    expect(hints).not.toBeNull();
    expect(
      (blockers as Element).compareDocumentPosition(hints as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(blockers?.querySelectorAll("li")).toHaveLength(2);
    expect(hints?.querySelectorAll("li")).toHaveLength(2);
  });

  it("passes the exact issue back on row click (blockers and hints alike)", () => {
    const onFocusIssue = vi.fn();
    render(
      createElement(ValidationPanel, {
        issues,
        nodeNames: new Map(),
        onFocusIssue,
      }),
    );

    const rows = [
      ...container!.querySelectorAll<HTMLButtonElement>(
        "[data-validation-blockers] button, [data-validation-hints] button",
      ),
    ];
    expect(rows).toHaveLength(4);
    act(() => {
      rows[0]!.click();
      rows[2]!.click();
    });
    expect(onFocusIssue).toHaveBeenCalledTimes(2);
    expect(onFocusIssue).toHaveBeenNthCalledWith(1, issues[0]);
    expect(onFocusIssue).toHaveBeenNthCalledWith(2, issues[1]);
  });

  it("renders hint-only docs in the calmer warning tone and keeps advisory warnings separate", () => {
    render(
      createElement(ValidationPanel, {
        issues: [issues[1] as CanvasIssue],
        warnings: [{ nodeId: "a", message: "router has no fallback" }],
        nodeNames: new Map(),
        onFocusIssue: () => {},
      }),
    );
    const text = container?.textContent ?? "";
    expect(text).toContain("1 hint — fix to save");
    expect(text).toContain("will not block saving");
    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.className).toContain("bg-warning-subtle");
  });

  it("renders nothing for a clean doc", () => {
    render(
      createElement(ValidationPanel, { issues: [], nodeNames: new Map(), onFocusIssue: () => {} }),
    );
    expect(container?.textContent).toBe("");
  });

  it("labels edge rows with 'source → target' names when provided, ids otherwise (#69)", () => {
    render(
      createElement(ValidationPanel, {
        issues: [issues[2] as CanvasIssue],
        nodeNames: new Map(),
        edgeLabels: new Map([["e-a-d", "review → fix"]]),
        onFocusIssue: () => {},
      }),
    );
    expect(container?.textContent).toContain("review → fix");
    expect(container?.textContent).not.toContain("e-a-d");
  });

  it("falls back to the raw edge id badge without an edgeLabels map", () => {
    render(
      createElement(ValidationPanel, {
        issues: [issues[2] as CanvasIssue],
        nodeNames: new Map(),
        onFocusIssue: () => {},
      }),
    );
    expect(container?.textContent).toContain("edge e-a-d");
  });
});
