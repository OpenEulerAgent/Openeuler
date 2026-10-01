import { describe, expect, it } from "vitest";
import { AgentGraphNodeSchema, AgentPresetSchema } from "./index.js";

const validPreset = {
  id: "preset-1",
  projectId: "proj-1",
  name: "Senior Reviewer",
  description: "Reviews a change and reports blocking issues.",
  icon: "🔍",
  config: {
    driver: "opencode",
    mode: "ask",
    promptTemplate: "Review this change for {{task}}:\n{{prevOutput}}",
    continueSession: false,
  },
  builtin: true,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
};

describe("AgentPresetSchema", () => {
  it("parses a valid preset", () => {
    expect(AgentPresetSchema.parse(validPreset)).toEqual(validPreset);
  });

  it("makes icon and builtin optional", () => {
    const minimal = { ...validPreset } as Partial<typeof validPreset>;
    delete minimal.icon;
    delete minimal.builtin;
    expect(AgentPresetSchema.parse(minimal)).toEqual(minimal);
  });

  it("rejects an empty name", () => {
    expect(
      AgentPresetSchema.safeParse({ ...validPreset, name: "" }).success,
    ).toBe(false);
  });

  it("rejects an invalid config (empty promptTemplate)", () => {
    expect(
      AgentPresetSchema.safeParse({
        ...validPreset,
        config: { ...validPreset.config, promptTemplate: "" },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strictObject)", () => {
    expect(AgentPresetSchema.safeParse({ ...validPreset, extra: true }).success).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(
      AgentPresetSchema.safeParse({ ...validPreset, createdAt: "yesterday" }).success,
    ).toBe(false);
  });
});

describe("AgentGraphNodeSchema presetId (backward compatible)", () => {
  const baseNode = {
    id: "node-1",
    type: "agent" as const,
    name: "review",
    position: { x: 0, y: 0 },
    config: validPreset.config,
  };

  it("accepts a node without presetId (pre-preset graphs)", () => {
    expect(AgentGraphNodeSchema.parse(baseNode).presetId).toBeUndefined();
  });

  it("accepts and returns a presetId", () => {
    const node = AgentGraphNodeSchema.parse({ ...baseNode, presetId: "preset-1" });
    expect(node.presetId).toBe("preset-1");
  });

  it("rejects an empty presetId", () => {
    expect(AgentGraphNodeSchema.safeParse({ ...baseNode, presetId: "" }).success).toBe(false);
  });
});
