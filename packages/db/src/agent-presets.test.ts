import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentPreset } from "@openeuler/core";
import { createDatabase } from "./index.js";
import type { Db } from "./index.js";

const iso = (): string => new Date().toISOString();

const makeProject = (db: Db): string => {
  const id = crypto.randomUUID();
  db.projects.create({
    id,
    path: "/srv/repos/demo",
    name: "demo",
    defaultBranch: "main",
    createdAt: iso(),
  });
  return id;
};

const makePreset = (projectId: string, over: Partial<AgentPreset> = {}): AgentPreset => ({
  id: crypto.randomUUID(),
  projectId,
  name: "Reviewer",
  description: "Reviews changes.",
  icon: "🔍",
  config: {
    driver: "opencode",
    mode: "ask",
    promptTemplate: "Review: {{task}}",
    continueSession: false,
  },
  createdAt: iso(),
  updatedAt: iso(),
  ...over,
});

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openeuler-db-presets-"));
  db = createDatabase({ path: join(dir, "test.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("agentPresets repo", () => {
  it("round-trips a preset (icon and builtin absent by default)", () => {
    const projectId = makeProject(db);
    const preset = makePreset(projectId, { icon: undefined });
    expect(db.agentPresets.create(preset)).toEqual(preset);
    expect(db.agentPresets.get(preset.id)).toEqual(preset);
    expect("builtin" in (db.agentPresets.get(preset.id) as AgentPreset)).toBe(false);
  });

  it("lists scoped to the project, builtins first then by name", () => {
    const projectId = makeProject(db);
    const other = makeProject(db);
    const zeta = db.agentPresets.create(makePreset(projectId, { name: "zeta" }));
    const builtin = db.agentPresets.create(makePreset(projectId, { name: "aaa", builtin: true }));
    db.agentPresets.create(makePreset(other, { name: "elsewhere" }));

    expect(db.agentPresets.list(projectId).map((p) => p.id)).toEqual([builtin.id, zeta.id]);
  });

  it("patches mutable fields, keeps builtin/createdAt, bumps updatedAt", () => {
    const projectId = makeProject(db);
    const preset = db.agentPresets.create(makePreset(projectId, { builtin: true }));
    const updated = db.agentPresets.update(preset.id, {
      name: "Senior Reviewer",
      icon: null,
      config: { ...preset.config, promptTemplate: "Rewritten" },
    });
    expect(updated).toMatchObject({
      id: preset.id,
      name: "Senior Reviewer",
      builtin: true,
      createdAt: preset.createdAt,
    });
    expect("icon" in (updated as AgentPreset)).toBe(false);
    expect(updated?.config.promptTemplate).toBe("Rewritten");
    expect(new Date(updated?.updatedAt ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(preset.updatedAt).getTime(),
    );
    expect(db.agentPresets.get(preset.id)).toEqual(updated);
  });

  it("update returns undefined for unknown ids", () => {
    expect(db.agentPresets.update(crypto.randomUUID(), { name: "x" })).toBeUndefined();
  });

  it("deletes single presets and whole projects' rosters", () => {
    const projectId = makeProject(db);
    const a = db.agentPresets.create(makePreset(projectId, { name: "a" }));
    const b = db.agentPresets.create(makePreset(projectId, { name: "b" }));
    expect(db.agentPresets.delete(a.id)).toBe(true);
    expect(db.agentPresets.delete(a.id)).toBe(false);
    expect(db.agentPresets.deleteAllForProject(projectId)).toBe(1);
    expect(db.agentPresets.list(projectId)).toEqual([]);
    expect(b).toBeDefined();
  });

  it("validates rows through the core schema (bad config throws)", () => {
    const projectId = makeProject(db);
    const preset = makePreset(projectId);
    const bad: Record<string, unknown> = { ...preset.config, mode: "sometimes" };
    expect(() =>
      db.agentPresets.create({ ...preset, config: bad } as never),
    ).toThrow();
  });
});
