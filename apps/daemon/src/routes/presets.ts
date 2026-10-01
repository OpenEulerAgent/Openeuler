import { randomUUID } from "node:crypto";
import type { AgentPreset, StepConfig } from "@openeuler/core";
import { StepConfigSchema } from "@openeuler/core";
import type { AgentPresetPatch, Db } from "@openeuler/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { HttpError } from "../errors.js";

/**
 * Agent presets CRUD (#49) — the "your team" library, project-scoped:
 * `GET/POST /api/projects/:id/presets` and
 * `GET/PATCH/DELETE /api/projects/:id/presets/:presetId`.
 *
 * Builtin presets are seeded when a project is registered (see
 * {@link seedBuiltinPresets}); they are ordinary rows — deletable, editable —
 * never sacred. Nodes copy a preset's config at creation time, so preset
 * edits and deletes never mutate existing nodes.
 */

const CreatePresetBodySchema = z.strictObject({
  name: z.string().min(1, "preset name must be a non-empty string"),
  description: z.string().optional(),
  icon: z.string().min(1, "icon must be a non-empty string").optional(),
  config: StepConfigSchema,
});

/** Patch body: any subset of the mutable fields; `icon: null` clears it. */
const PatchPresetBodySchema = z.strictObject({
  name: z.string().min(1, "preset name must be a non-empty string").optional(),
  description: z.string().optional(),
  icon: z.string().min(1, "icon must be a non-empty string").nullable().optional(),
  config: StepConfigSchema.optional(),
});

const presetConfig = (promptTemplate: string, mode: StepConfig["mode"] = "auto"): StepConfig => ({
  driver: "opencode",
  mode,
  promptTemplate,
  continueSession: false,
});

/**
 * Builtin presets seeded on project creation: the three roster roles named
 * in #49. Prompts stick to template variables that are valid on any graph
 * position (`{{task}}`, `{{prevOutput}}`) and mention the wiring pattern
 * (`{{output:<nodeId>}}`) in prose only — a literal reference would be
 * graph-validation noise until the user wires real upstream nodes.
 */
export const BUILTIN_AGENT_PRESETS: ReadonlyArray<{
  name: string;
  description: string;
  icon: string;
  config: StepConfig;
}> = [
  {
    name: "Implementer",
    description:
      "Implements the task directly: reads the repo, writes the code change, and reports what it did.",
    icon: "🛠️",
    config: presetConfig(
      [
        "You are the implementer. Implement the following task in this repository.",
        "",
        "Task:",
        "{{task}}",
        "",
        "Context from earlier steps (if any):",
        "{{prevOutput}}",
        "",
        "Write a minimal, clean change. Follow the existing code style, keep the diff small, and summarize the edits you made at the end.",
      ].join("\n"),
    ),
  },
  {
    name: "Reviewer",
    description:
      "Reviews the previous step's output as a senior reviewer and reports blocking issues before approving.",
    icon: "🔍",
    config: presetConfig(
      [
        "You are a strict senior reviewer. Review the change made for this task and decide whether it can ship.",
        "",
        "Task:",
        "{{task}}",
        "",
        "Change to review:",
        "{{prevOutput}}",
        "",
        "Check correctness, tests, edge cases, and style. List every blocking issue with a concrete suggestion; end with a line 'VERDICT: APPROVED' only when nothing blocks, otherwise 'VERDICT: CHANGES_REQUESTED'.",
      ].join("\n"),
      "ask",
    ),
  },
  {
    name: "Test Writer",
    description:
      "Writes or extends the test suite covering the task and the previous step's change.",
    icon: "🧪",
    config: presetConfig(
      [
        "You are the test engineer. Write or extend tests that cover the work below.",
        "",
        "Task:",
        "{{task}}",
        "",
        "Change to cover:",
        "{{prevOutput}}",
        "",
        "Follow the repository's existing test framework and conventions. Cover the happy path and the important edge cases; make the suite green without weakening assertions.",
      ].join("\n"),
    ),
  },
];

/** Seeds the builtin presets for a freshly registered project. */
export function seedBuiltinPresets(db: Db, projectId: string): AgentPreset[] {
  const now = new Date().toISOString();
  return BUILTIN_AGENT_PRESETS.map((preset) =>
    db.agentPresets.create({
      id: randomUUID(),
      projectId,
      name: preset.name,
      description: preset.description,
      icon: preset.icon,
      config: preset.config,
      builtin: true,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

function requireDb(c: Context<AppEnv>): Db {
  const db = c.get("db");
  if (!db) throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
  return db;
}

async function parseJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(422, "INVALID_JSON", "request body must be valid JSON");
  }
}

function requireProject(db: Db, projectId: string): void {
  if (!db.projects.get(projectId)) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", `no project with id ${projectId}`);
  }
}

function requirePreset(db: Db, projectId: string, presetId: string): AgentPreset {
  const preset = db.agentPresets.get(presetId);
  if (!preset || preset.projectId !== projectId) {
    throw new HttpError(404, "PRESET_NOT_FOUND", `no preset with id ${presetId}`);
  }
  return preset;
}

export function createPresetsRouter(): Hono<AppEnv> {
  const presets = new Hono<AppEnv>();

  presets.get("/:id/presets", (c) => {
    const db = requireDb(c);
    const projectId = c.req.param("id");
    requireProject(db, projectId);
    return c.json({ presets: db.agentPresets.list(projectId) });
  });

  presets.post("/:id/presets", async (c) => {
    const db = requireDb(c);
    const projectId = c.req.param("id");
    requireProject(db, projectId);
    const body = CreatePresetBodySchema.parse(await parseJsonBody(c));
    const now = new Date().toISOString();
    const preset = db.agentPresets.create({
      id: randomUUID(),
      projectId,
      name: body.name,
      description: body.description ?? "",
      ...(body.icon === undefined ? {} : { icon: body.icon }),
      config: body.config,
      createdAt: now,
      updatedAt: now,
    });
    c.get("logger").info({ presetId: preset.id, projectId }, "preset created");
    return c.json({ preset }, 201);
  });

  presets.get("/:id/presets/:presetId", (c) => {
    const db = requireDb(c);
    const projectId = c.req.param("id");
    requireProject(db, projectId);
    return c.json({ preset: requirePreset(db, projectId, c.req.param("presetId")) });
  });

  presets.patch("/:id/presets/:presetId", async (c) => {
    const db = requireDb(c);
    const projectId = c.req.param("id");
    requireProject(db, projectId);
    const presetId = c.req.param("presetId");
    requirePreset(db, projectId, presetId);
    const body = PatchPresetBodySchema.parse(await parseJsonBody(c));
    const patch: AgentPresetPatch = {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.icon === undefined ? {} : { icon: body.icon }),
      ...(body.config === undefined ? {} : { config: body.config }),
    };
    const preset = db.agentPresets.update(presetId, patch);
    if (!preset) throw new HttpError(404, "PRESET_NOT_FOUND", `no preset with id ${presetId}`);
    c.get("logger").info({ presetId, projectId }, "preset updated");
    return c.json({ preset });
  });

  presets.delete("/:id/presets/:presetId", (c) => {
    const db = requireDb(c);
    const projectId = c.req.param("id");
    requireProject(db, projectId);
    const presetId = c.req.param("presetId");
    requirePreset(db, projectId, presetId);
    // Builtins are deletable like any other: nodes carry config copies, so
    // nothing dangles (a stale node presetId just stops matching a lookup).
    if (!db.agentPresets.delete(presetId)) {
      throw new HttpError(404, "PRESET_NOT_FOUND", `no preset with id ${presetId}`);
    }
    c.get("logger").info({ presetId, projectId }, "preset deleted");
    return c.body(null, 204);
  });

  return presets;
}
