// @vitest-environment jsdom
//
// NodePropertiesDrawer sandbox overrides (#101): the collapsible defaults
// to "inherit from project" (absent overrides), patching fields flows
// through the real inspector reducer (patchConfig) and re-renders, setting
// then clearing fields keeps siblings, the last cleared field removes the
// key entirely, and invalid values surface inline via inspector field
// errors. The doc round-trip (canvas → graph → schema) is the last block.

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkflowGraphSchema, type StepConfig } from "@openeuler/core";
import { NodePropertiesDrawer } from "./NodePropertiesDrawer";
import { applyInspectorAction } from "@/lib/graph/inspector";
import {
  fromCanvasDocument,
  toCanvasDocument,
  type CanvasDocument,
  type CanvasNode,
} from "@/lib/graph/canvas-document";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

function agentNode(overrides?: StepConfig["sandboxOverrides"]): CanvasNode {
  return {
    id: "a",
    type: "agent",
    position: { x: 0, y: 0 },
    data: {
      kind: "agent",
      name: "Agent",
      isEntry: true,
      config: {
        driver: "opencode",
        mode: "auto",
        promptTemplate: "{{task}}",
        continueSession: false,
        ...(overrides === undefined ? {} : { sandboxOverrides: overrides }),
      },
    },
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let doc: CanvasDocument;

/**
 * Renders the drawer against a live doc: every onPatchAgent goes through
 * the REAL reducer (applyInspectorAction patchConfig) and re-renders, so
 * subsequent patches accumulate exactly like the canvas editor.
 */
const renderDrawer = (node: CanvasNode): void => {
  doc = { nodes: [node], edges: [] };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const renderAt = (): void => {
    const inspected = doc.nodes[0] as CanvasNode;
    act(() =>
      root?.render(
        createElement(NodePropertiesDrawer, {
          node: inspected,
          doc,
          issues: [],
          onPatchAgent: (patch) => {
            doc = applyInspectorAction(doc, { type: "patchConfig", nodeId: "a", patch });
            renderAt();
          },
          onPatchName: () => {},
          onCommitEdit: () => {},
          onDelete: () => {},
          onClose: () => {},
        }),
      ),
    );
  };
  renderAt();
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const nodeConfig = (): StepConfig => (doc.nodes[0]?.data as { config: StepConfig }).config;

const openOverrides = (): void => {
  const toggle = document.querySelector("[data-sandbox-overrides-toggle]");
  expect(toggle).not.toBeNull();
  act(() => (toggle as HTMLButtonElement).click());
};

const fireValue = (
  el: HTMLInputElement | HTMLSelectElement,
  value: string,
  eventName: string,
): void => {
  const proto =
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event(eventName, { bubbles: true }));
  });
};

const setInput = (id: string, value: string): void => {
  const el = document.getElementById(id) as HTMLInputElement | null;
  expect(el).not.toBeNull();
  fireValue(el as HTMLInputElement, value, "input");
};
const setSelect = (id: string, value: string): void => {
  const el = document.getElementById(id) as HTMLSelectElement | null;
  expect(el).not.toBeNull();
  fireValue(el as HTMLSelectElement, value, "change");
};

describe("NodePropertiesDrawer sandbox overrides (#101)", () => {
  it("is collapsed by default and shows the override count when set", () => {
    renderDrawer(agentNode({ cpus: 4, network: "none" }));
    const toggle = document.querySelector("[data-sandbox-overrides-toggle]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.textContent).toContain("2 overrides");
    expect(document.getElementById("node-sandbox-cpus")).toBeNull();
  });

  it("empty fields say 'inherit from project' and typing then clearing removes the key", () => {
    renderDrawer(agentNode());
    openOverrides();
    expect((document.getElementById("node-sandbox-network") as HTMLSelectElement)?.value).toBe("");
    expect((document.getElementById("node-sandbox-cpus") as HTMLInputElement)?.value).toBe("");

    // Set the image, then clear it: the overrides key disappears entirely.
    setInput("node-sandbox-image", "busybox:1.36");
    expect(nodeConfig().sandboxOverrides).toEqual({ image: "busybox:1.36" });
    setInput("node-sandbox-image", "");
    expect(nodeConfig().sandboxOverrides).toBeUndefined();
  });

  it("patching fields accumulates through the reducer; clearing one keeps siblings", () => {
    renderDrawer(agentNode({ cpus: 4 }));
    openOverrides();

    setInput("node-sandbox-image", "busybox:1.36");
    expect(nodeConfig().sandboxOverrides).toEqual({ cpus: 4, image: "busybox:1.36" });

    setSelect("node-sandbox-network", "limited");
    expect(nodeConfig().sandboxOverrides).toEqual({
      cpus: 4,
      image: "busybox:1.36",
      network: "limited",
    });

    setInput("node-sandbox-memory", "1024");
    expect(nodeConfig().sandboxOverrides).toEqual({
      cpus: 4,
      image: "busybox:1.36",
      network: "limited",
      memoryMb: 1024,
    });

    setInput("node-sandbox-memory", "");
    expect(nodeConfig().sandboxOverrides).toEqual({
      cpus: 4,
      image: "busybox:1.36",
      network: "limited",
    });
  });

  it("the last cleared field removes the whole overrides key (back to inherit)", () => {
    renderDrawer(agentNode({ cpus: 4 }));
    openOverrides();
    setInput("node-sandbox-cpus", "");
    expect(nodeConfig().sandboxOverrides).toBeUndefined();
  });

  it("shows the honesty note while network override is limited", () => {
    renderDrawer(agentNode({ network: "limited" }));
    openOverrides();
    expect(document.body.textContent).toContain("does not filter egress");
  });

  it("flags an out-of-clamp cpus override inline (inspector field error)", () => {
    renderDrawer(agentNode());
    openOverrides();
    setInput("node-sandbox-cpus", "100");
    expect(nodeConfig().sandboxOverrides).toEqual({ cpus: 100 });
    const error = [...document.querySelectorAll("p")].find(
      (p) => p.getAttribute("role") === "alert" && p.textContent?.includes("cpus must be"),
    );
    expect(error?.textContent).toContain("cpus must be <= 8");
  });
});

describe("canvas doc round-trip of sandbox overrides (#101)", () => {
  it("survives graph → canvas → graph and validates through WorkflowGraphSchema", () => {
    const graph = WorkflowGraphSchema.parse({
      entryNodeId: "a",
      nodes: [
        {
          id: "a",
          type: "agent",
          name: "Agent",
          position: { x: 0, y: 0 },
          config: {
            driver: "opencode",
            mode: "auto",
            promptTemplate: "{{task}}",
            continueSession: false,
            sandboxOverrides: { image: "busybox:1.36", cpus: 4, network: "none" },
          },
        },
      ],
      edges: [],
    });
    const roundTripped = fromCanvasDocument(toCanvasDocument(graph));
    expect(roundTripped.nodes[0]).toMatchObject({
      type: "agent",
      config: {
        sandboxOverrides: { image: "busybox:1.36", cpus: 4, network: "none" },
      },
    });
    expect(WorkflowGraphSchema.safeParse(roundTripped).success).toBe(true);
  });

  it("graphs without overrides (pre-#101 revision shape) still validate", () => {
    const legacy = WorkflowGraphSchema.safeParse({
      entryNodeId: "a",
      nodes: [
        {
          id: "a",
          type: "agent",
          name: "Agent",
          position: { x: 0, y: 0 },
          config: {
            driver: "opencode",
            mode: "auto",
            promptTemplate: "{{task}}",
            continueSession: false,
          },
        },
      ],
      edges: [],
    });
    expect(legacy.success).toBe(true);
  });
});
