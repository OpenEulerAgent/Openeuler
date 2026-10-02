// @vitest-environment jsdom
//
// EdgePropertiesDrawer (#69): severity tone split for edge issues (red
// blockers vs amber "set a condition" hints, matching the node drawer and
// the validation panel), the "set condition…" canvas-label chip while the
// placeholder pattern is empty, and the guided auto-focus on the pattern
// input.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EdgePropertiesDrawer } from "./EdgePropertiesDrawer";
import type { CanvasDocument, CanvasEdge } from "@/lib/graph/canvas-document";
import { validateCanvasDocument, type CanvasIssue } from "@/lib/graph/validation";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

function node(id: string, options: { isEntry?: boolean } = {}) {
  return {
    id,
    type: "agent" as const,
    position: { x: 0, y: 0 },
    data: {
      kind: "agent" as const,
      name: id,
      isEntry: options.isEntry ?? false,
      config: {
        driver: "opencode",
        mode: "auto" as const,
        promptTemplate: "work: {{task}}",
        continueSession: false,
      },
    },
  };
}

function docWith(edgeData: CanvasEdge["data"]): { doc: CanvasDocument; edge: CanvasEdge } {
  const edge: CanvasEdge = { id: "e-review-fix", source: "review", target: "fix", data: edgeData };
  return {
    doc: { nodes: [node("a", { isEntry: true }), node("review"), node("fix")], edges: [edge] },
    edge,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (element: ReactElement): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
};

const renderDrawer = (edge: CanvasEdge, doc: CanvasDocument, issues: readonly CanvasIssue[]) => {
  render(
    createElement(EdgePropertiesDrawer, {
      edge,
      doc,
      issues,
      onPatch: () => {},
      onMove: () => {},
      onCommitEdit: () => {},
      onDelete: () => {},
      onClose: () => {},
    }),
  );
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("EdgePropertiesDrawer severity split + guided focus (#69)", () => {
  it("renders a missing pattern as the amber hint tone with the action copy, not the red blocker box", () => {
    const { doc, edge } = docWith({ condition: { type: "outputContains", pattern: "" } });
    renderDrawer(edge, doc, validateCanvasDocument(doc));

    const hints = document.querySelector("[data-edge-hints]");
    expect(hints).not.toBeNull();
    expect(hints?.getAttribute("role")).toBe("status");
    expect(hints?.textContent).toContain("Set a condition on this edge");
    expect(document.querySelector("[data-edge-blockers]")).toBeNull();
  });

  it("renders hard blockers in the red danger box with the save-blocked copy", () => {
    const { doc, edge } = docWith({ condition: { type: "outputMatches", regex: "([a-z" } });
    renderDrawer(edge, doc, validateCanvasDocument(doc));

    const alert = document.querySelector("[data-edge-blockers]");
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("1 blocker on this edge — saving stays blocked");
    expect(alert?.textContent).toContain("invalid regular expression");
    expect(document.querySelector("[data-edge-hints]")).toBeNull();
  });

  it("renders both tones side by side when hint and blocker issues stack on one edge", () => {
    const { doc, edge } = docWith({ condition: { type: "outputMatches", regex: "([a-z" } });
    const issues: CanvasIssue[] = [
      ...validateCanvasDocument(doc),
      { edgeId: edge.id, field: "condition.regex", message: "regex must be a non-empty string" },
    ];
    renderDrawer(edge, doc, issues);

    const alert = document.querySelector("[data-edge-blockers]");
    const hints = document.querySelector("[data-edge-hints]");
    expect(alert).not.toBeNull();
    expect(hints).not.toBeNull();
    expect(alert?.textContent).toContain("1 blocker on this edge");
    expect(hints?.textContent).toContain("Set a condition on this edge");
  });

  it("shows the 'set condition…' canvas-label chip while unconfigured, the summary once configured", () => {
    const unconfigured = docWith({ condition: { type: "outputContains", pattern: "" } });
    renderDrawer(unconfigured.edge, unconfigured.doc, validateCanvasDocument(unconfigured.doc));
    const badge = document.querySelector(
      '[title="Derived from the condition — shown on the canvas edge"]',
    );
    expect(badge?.textContent).toBe("set condition…");
  });

  it("auto-focuses the pattern input while the condition needs configuring", () => {
    const { doc, edge } = docWith({ condition: { type: "outputContains", pattern: "" } });
    renderDrawer(edge, doc, validateCanvasDocument(doc));

    const pattern = document.querySelector<HTMLInputElement>("#edge-pattern");
    expect(pattern).not.toBeNull();
    expect(document.activeElement).toBe(pattern);
  });

  it("focuses the regex input for an unconfigured regex condition", () => {
    const { doc, edge } = docWith({ condition: { type: "outputMatches", regex: "" } });
    renderDrawer(edge, doc, validateCanvasDocument(doc));

    const regex = document.querySelector<HTMLInputElement>("#edge-regex");
    expect(regex).not.toBeNull();
    expect(document.activeElement).toBe(regex);
  });

  it("does not steal focus for an already-configured condition", () => {
    const { doc, edge } = docWith({ condition: { type: "outputContains", pattern: "LGTM" } });
    renderDrawer(edge, doc, validateCanvasDocument(doc));

    // The Drawer's own initial focus (first focusable) stands.
    expect(document.activeElement).not.toBe(document.querySelector("#edge-pattern"));
  });

  it("closing still hands control back through onClose", () => {
    const onClose = vi.fn();
    const { doc, edge } = docWith({ condition: { type: "outputContains", pattern: "" } });
    render(
      createElement(EdgePropertiesDrawer, {
        edge,
        doc,
        issues: [],
        onPatch: () => {},
        onMove: () => {},
        onCommitEdit: () => {},
        onDelete: () => {},
        onClose,
      }),
    );
    const closeButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Close",
    );
    expect(closeButton).toBeDefined();
    act(() => closeButton?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
