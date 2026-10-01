import { describe, expect, it } from "vitest";
import type { AgentGraphNode, AgentPreset, StepConfig } from "@openeuler/core";
import { WorkflowGraphSchema } from "@openeuler/core";
import {
  createAgentNode,
  createPresetAgentNode,
  fromCanvasDocument,
  toCanvasDocument,
  type CanvasDocument,
  type CanvasNode,
} from "./canvas-document";
import { applyInspectorAction } from "./inspector";
import { asPresetSource, nodesWithStalePreset, presetForNode, toPalettePreset } from "./presets";

const presetConfig: StepConfig = {
  driver: "opencode",
  model: "sonnet",
  mode: "ask",
  promptTemplate: "Review {{task}}\n{{prevOutput}}",
  continueSession: true,
};

const makePreset = (over: Partial<AgentPreset> = {}): AgentPreset => ({
  id: "preset-1",
  projectId: "p-1",
  name: "Senior Reviewer",
  description: "Reviews everything twice.",
  icon: "🔍",
  config: presetConfig,
  builtin: true,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
  ...over,
});

function docWith(...nodes: CanvasNode[]): CanvasDocument {
  return { nodes, edges: [] };
}

const agentNodes = (doc: CanvasDocument | { nodes: unknown[] }): Array<
  CanvasNode & { data: { kind: "agent"; presetId?: string } }
> =>
  (doc.nodes as CanvasNode[]).filter(
    (node): node is CanvasNode & { data: { kind: "agent"; presetId?: string } } =>
      node.data.kind === "agent",
  );

describe("createPresetAgentNode (palette drag → node)", () => {
  it("carries the FULL preset config and the presetId, name = preset name", () => {
    const preset = makePreset();
    const node = createPresetAgentNode({ preset, position: { x: 120, y: 80 } });
    expect(node).toMatchObject({
      type: "agent",
      position: { x: 120, y: 80 },
      data: {
        kind: "agent",
        name: "Senior Reviewer",
        config: presetConfig,
        presetId: "preset-1",
        isEntry: false,
      },
    });
    // Full config, not the sparse palette default.
    expect(node.data.kind === "agent" && node.data.config).toEqual(presetConfig);
  });

  it("deep-copies the config: later preset edits cannot leak into the node", () => {
    const preset = makePreset();
    const node = createPresetAgentNode({ preset });
    const edited = makePreset({
      config: { ...presetConfig, promptTemplate: "rewritten" },
    });
    expect(node.data.kind === "agent" && node.data.config.promptTemplate).toBe(
      "Review {{task}}\n{{prevOutput}}",
    );
    expect(edited.config.promptTemplate).toBe("rewritten");
  });

  it("uniquifies the name against taken node names", () => {
    const preset = makePreset();
    const node = createPresetAgentNode({
      preset,
      takenNames: new Set(["Senior Reviewer"]),
    });
    expect(node.data.kind === "agent" && node.data.name).toBe("Senior Reviewer 2");
  });
});

describe("presetId round-trip through the graph", () => {
  it("serializes to WorkflowGraph and back (and core's schema accepts it)", () => {
    const base = createAgentNode({ id: "entry", isEntry: true });
    if (base.data.kind !== "agent") throw new Error("expected an agent node");
    const entry: CanvasNode = {
      ...base,
      data: { ...base.data, config: { ...base.data.config, promptTemplate: "{{task}}" } },
    };
    const node = createPresetAgentNode({ preset: makePreset() });
    const doc: CanvasDocument = {
      nodes: [entry, node],
      edges: [
        {
          id: "e-entry-preset",
          source: "entry",
          target: node.id,
          data: { condition: { type: "always" } },
        },
      ],
    };
    const graph = fromCanvasDocument(doc);
    const serialized = graph.nodes.find(
      (candidate): candidate is AgentGraphNode => candidate.id === node.id,
    );
    expect(serialized?.presetId).toBe("preset-1");
    const validated = WorkflowGraphSchema.parse({ ...graph, entryNodeId: "entry" });
    const agent = validated.nodes.find(
      (candidate): candidate is AgentGraphNode => candidate.id === node.id,
    );
    expect(agent?.presetId).toBe("preset-1");
    expect(
      agentNodes(toCanvasDocument(validated)).find((candidate) => candidate.id === node.id)?.data
        .presetId,
    ).toBe("preset-1");
  });

  it("stays absent for plain nodes", () => {
    const graph = fromCanvasDocument({
      nodes: [createAgentNode({ id: "a", isEntry: true })],
      edges: [],
    });
    expect(
      graph.nodes.find((candidate): candidate is AgentGraphNode => candidate.id === "a")?.presetId,
    ).toBeUndefined();
  });
});

describe("detachPreset", () => {
  it("removes presetId and keeps the config copy", () => {
    const preset = makePreset();
    const node = createPresetAgentNode({ preset });
    const next = applyInspectorAction(docWith(node), {
      type: "detachPreset",
      nodeId: node.id,
    });
    const detached = next.nodes[0];
    expect(detached?.data.kind === "agent" && detached.data.presetId).toBeUndefined();
    expect(detached?.data.kind === "agent" && detached.data.config).toEqual(presetConfig);
    expect(detached?.data.kind === "agent" && detached.data.name).toBe("Senior Reviewer");
    // Id/position untouched.
    expect(detached?.id).toBe(node.id);
    expect(detached?.position).toEqual(node.position);
  });

  it("is a no-op for plain nodes, exit nodes, and unknown ids", () => {
    const plainDoc = docWith(createAgentNode({ id: "a", isEntry: true }));
    expect(applyInspectorAction(plainDoc, { type: "detachPreset", nodeId: "a" })).toBe(plainDoc);
    const doc = docWith(createPresetAgentNode({ preset: makePreset() }));
    expect(applyInspectorAction(doc, { type: "detachPreset", nodeId: "ghost" })).toBe(doc);
  });
});

describe("applyPreset (Update from preset)", () => {
  it("copies the preset's CURRENT config + name; id and position stay", () => {
    const original = makePreset();
    const node = createPresetAgentNode({ preset: original, position: { x: 40, y: 90 } });
    const edited = makePreset({
      name: "Principal Reviewer",
      config: { ...presetConfig, mode: "auto", promptTemplate: "New prompt: {{task}}" },
    });

    const next = applyInspectorAction(docWith(node), {
      type: "applyPreset",
      nodeId: node.id,
      preset: asPresetSource(edited),
    });
    const updated = next.nodes[0];
    expect(updated).toMatchObject({
      id: node.id,
      position: { x: 40, y: 90 },
    });
    expect(updated?.data.kind === "agent" && updated.data.name).toBe("Principal Reviewer");
    expect(updated?.data.kind === "agent" && updated.data.config).toEqual(edited.config);
    expect(updated?.data.kind === "agent" && updated.data.presetId).toBe("preset-1");
  });

  it("does not mutate the node until the action is dispatched", () => {
    const preset = makePreset();
    const node = createPresetAgentNode({ preset });
    const doc = docWith(node);

    // The preset is PATCHed server-side…
    const edited = makePreset({
      config: { ...presetConfig, promptTemplate: "rewritten after node creation" },
    });

    // …nothing dispatches, so the node's config copy is untouched…
    const unchanged = doc.nodes[0];
    expect(unchanged?.data.kind === "agent" && unchanged.data.config.promptTemplate).toBe(
      presetConfig.promptTemplate,
    );

    // …and only the explicit update pulls the new config in.
    const next = applyInspectorAction(doc, {
      type: "applyPreset",
      nodeId: node.id,
      preset: asPresetSource(edited),
    });
    const updated = next.nodes[0];
    expect(updated?.data.kind === "agent" && updated.data.config.promptTemplate).toBe(
      "rewritten after node creation",
    );
    // The document itself was never mutated in place.
    expect(doc.nodes[0]).toBe(node);
  });
});

describe("presetForNode (badge lookup, stale-safe)", () => {
  it("resolves the preset for a node created from it", () => {
    const preset = makePreset();
    const node = createPresetAgentNode({ preset });
    expect(presetForNode([preset, makePreset({ id: "preset-2" })], node)?.id).toBe("preset-1");
  });

  it("returns undefined for plain nodes", () => {
    expect(presetForNode([makePreset()], createAgentNode({ id: "a" }))).toBeUndefined();
  });

  it("treats a stale presetId (deleted preset) as detached — badge cleared, node intact", () => {
    const node = createPresetAgentNode({ preset: makePreset() });
    const roster: AgentPreset[] = []; // preset deleted → roster without it
    expect(presetForNode(roster, node)).toBeUndefined();
    // The node keeps working: config copy present, presetId left in place.
    expect(node.data.kind === "agent" && node.data.config).toEqual(presetConfig);
    expect(nodesWithStalePreset(roster, docWith(node))).toHaveLength(1);
    expect(nodesWithStalePreset([makePreset()], docWith(node))).toHaveLength(0);
  });
});

describe("toPalettePreset", () => {
  it("narrows a preset to the palette slice (dropping the config weight)", () => {
    expect(toPalettePreset(makePreset())).toEqual({
      id: "preset-1",
      name: "Senior Reviewer",
      description: "Reviews everything twice.",
      icon: "🔍",
      builtin: true,
    });
    expect(toPalettePreset(makePreset({ icon: undefined, builtin: undefined }))).toEqual({
      id: "preset-1",
      name: "Senior Reviewer",
      description: "Reviews everything twice.",
    });
  });
});
