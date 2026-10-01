import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentPreset } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";
import { BUILTIN_AGENT_PRESETS } from "./presets.js";

interface ErrorResponseBody {
  error: { code: string; message: string };
}

const validConfig = {
  driver: "opencode",
  mode: "auto" as const,
  promptTemplate: "Do {{task}}",
  continueSession: false,
};

let workDir: string;
let db: Db;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openeuler-presets-"));
  db = createDatabase({ path: join(workDir, "test.db") });
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

const makeRepo = (name: string): string => {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git("init", "-b", "main");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git("add", "-A");
  git("-c", "user.email=test@openeuler.dev", "-c", "user.name=Test", "commit", "-m", "init");
  return dir;
};

const build = () => createApp({ db, logger: createLogger("silent") }).app;

const registerProject = async (name = "demo"): Promise<string> => {
  const res = await build().request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: makeRepo(name) }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { project: { id: string } };
  return body.project.id;
};

const listPresets = async (app: ReturnType<typeof build>, projectId: string) => {
  const res = await app.request(`/api/projects/${projectId}/presets`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presets: AgentPreset[] }).presets;
};

const postPreset = (app: ReturnType<typeof build>, projectId: string, body: unknown) =>
  app.request(`/api/projects/${projectId}/presets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("builtin presets (seeded on project creation)", () => {
  it("seeds exactly the builtin roster with the builtin flag", async () => {
    const projectId = await registerProject();
    const presets = await listPresets(build(), projectId);
    expect(presets).toHaveLength(BUILTIN_AGENT_PRESETS.length);
    expect(presets.every((preset) => preset.builtin === true)).toBe(true);
    expect(presets.map((preset) => preset.name)).toEqual(
      BUILTIN_AGENT_PRESETS.map((preset) => preset.name),
    );
    for (const preset of presets) {
      expect(preset.config.promptTemplate.length).toBeGreaterThan(0);
      expect(preset.config.promptTemplate).toContain("{{task}}");
    }
  });

  it("scopes seeds per project (a second project gets its own roster)", async () => {
    const first = await registerProject("one");
    const second = await registerProject("two");
    const a = await listPresets(build(), first);
    const b = await listPresets(build(), second);
    expect(a.map((p) => p.id)).not.toEqual(b.map((p) => p.id));
    expect(a).toHaveLength(BUILTIN_AGENT_PRESETS.length);
    expect(b).toHaveLength(BUILTIN_AGENT_PRESETS.length);
  });

  it("builtin presets are deletable like any other", async () => {
    const app = build();
    const projectId = await registerProject();
    const builtin = (await listPresets(app, projectId)).find((p) => p.builtin) as AgentPreset;
    const res = await app.request(`/api/projects/${projectId}/presets/${builtin.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    const after = await listPresets(app, projectId);
    expect(after.map((p) => p.id)).not.toContain(builtin.id);
  });
});

describe("presets CRUD round-trip", () => {
  it("create → list → get → patch → delete → get 404", async () => {
    const app = build();
    const projectId = await registerProject();

    const created = await postPreset(app, projectId, {
      name: "Test Engineer",
      description: "Writes tests.",
      icon: "🧪",
      config: validConfig,
    });
    expect(created.status).toBe(201);
    const preset = ((await created.json()) as { preset: AgentPreset }).preset;
    expect(preset).toMatchObject({
      id: expect.any(String),
      projectId,
      name: "Test Engineer",
      description: "Writes tests.",
      icon: "🧪",
      config: validConfig,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect("builtin" in preset).toBe(false);

    const listed = await listPresets(app, projectId);
    expect(listed.map((p) => p.id)).toContain(preset.id);

    const got = await app.request(`/api/projects/${projectId}/presets/${preset.id}`);
    expect(got.status).toBe(200);
    expect(((await got.json()) as { preset: AgentPreset }).preset).toEqual(preset);

    const patched = await app.request(`/api/projects/${projectId}/presets/${preset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Senior Test Engineer",
        icon: null,
        config: { ...validConfig, mode: "ask", continueSession: true },
      }),
    });
    expect(patched.status).toBe(200);
    const updated = ((await patched.json()) as { preset: AgentPreset }).preset;
    expect(updated.name).toBe("Senior Test Engineer");
    expect("icon" in updated).toBe(false);
    expect(updated.config).toEqual({ ...validConfig, mode: "ask", continueSession: true });
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(preset.updatedAt).getTime(),
    );
    expect(updated.createdAt).toBe(preset.createdAt);

    const deleted = await app.request(`/api/projects/${projectId}/presets/${preset.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    const after = await app.request(`/api/projects/${projectId}/presets/${preset.id}`);
    expect(after.status).toBe(404);
    expect(((await after.json()) as ErrorResponseBody).error.code).toBe("PRESET_NOT_FOUND");
  });

  it("defaults description to the empty string", async () => {
    const app = build();
    const projectId = await registerProject();
    const created = await postPreset(app, projectId, {
      name: "Bare",
      config: validConfig,
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { preset: AgentPreset }).preset.description).toBe("");
  });

  it("keeps presets project-scoped (another project's preset is a 404)", async () => {
    const app = build();
    const first = await registerProject("one");
    const second = await registerProject("two");
    const preset = (await listPresets(app, first))[0] as AgentPreset;
    const res = await app.request(`/api/projects/${second}/presets/${preset.id}`);
    expect(res.status).toBe(404);
    const del = await app.request(`/api/projects/${second}/presets/${preset.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(404);
  });

  it("404s for unknown project and preset ids", async () => {
    const app = build();
    const projectId = await registerProject();
    const unknown = crypto.randomUUID();
    expect((await app.request(`/api/projects/${unknown}/presets`)).status).toBe(404);
    expect(
      (await app.request(`/api/projects/${projectId}/presets/${unknown}`)).status,
    ).toBe(404);
    expect((await postPreset(app, unknown, { name: "x", config: validConfig })).status).toBe(404);
  });
});

describe("presets validation (422s)", () => {
  it("rejects a missing/empty name", async () => {
    const app = build();
    const projectId = await registerProject();
    expect((await postPreset(app, projectId, { config: validConfig })).status).toBe(422);
    expect((await postPreset(app, projectId, { name: "", config: validConfig })).status).toBe(422);
  });

  it("rejects an invalid config", async () => {
    const app = build();
    const projectId = await registerProject();
    expect(
      (
        await postPreset(app, projectId, {
          name: "bad",
          config: { ...validConfig, promptTemplate: "" },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await postPreset(app, projectId, {
          name: "bad",
          config: { ...validConfig, mode: "sometimes" },
        })
      ).status,
    ).toBe(422);
    expect(
      (await postPreset(app, projectId, { name: "bad", config: "not a config" })).status,
    ).toBe(422);
  });

  it("rejects unknown keys (strict bodies)", async () => {
    const app = build();
    const projectId = await registerProject();
    expect(
      (
        await postPreset(app, projectId, {
          name: "x",
          config: validConfig,
          projectId: "smuggling",
        })
      ).status,
    ).toBe(422);
    const preset = (await listPresets(app, projectId))[0] as AgentPreset;
    const patched = await app.request(`/api/projects/${projectId}/presets/${preset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ builtin: false }),
    });
    expect(patched.status).toBe(422);
  });

  it("rejects malformed JSON with 422", async () => {
    const app = build();
    const projectId = await registerProject();
    const res = await app.request(`/api/projects/${projectId}/presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("INVALID_JSON");
  });
});

describe("preset edits never touch workflow nodes", () => {
  /** Creates a workflow whose single agent node came from `presetId`. */
  const createWorkflowFromPreset = async (
    app: ReturnType<typeof build>,
    projectId: string,
    presetId: string,
    promptTemplate: string,
  ): Promise<string> => {
    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        name: "roster-flow",
        graph: {
          entryNodeId: "n1",
          nodes: [
            {
              id: "n1",
              type: "agent",
              name: "from preset",
              position: { x: 0, y: 0 },
              presetId,
              config: { ...validConfig, promptTemplate },
            },
            { id: "exit", type: "exit", name: "Exit", position: { x: 280, y: 0 } },
          ],
          edges: [{ id: "e1", source: "n1", target: "exit", condition: { type: "always" } }],
        },
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { workflow: { id: string } };
    return created.workflow.id;
  };

  const graphNode = async (
    app: ReturnType<typeof build>,
    workflowId: string,
  ): Promise<{ presetId?: string; config: { promptTemplate: string } }> => {
    const res = await app.request(`/api/workflows/${workflowId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflow: { graph: { nodes: Array<{ id: string; presetId?: string; config?: unknown }> } };
    };
    const node = body.workflow.graph.nodes.find((candidate) => candidate.id === "n1");
    if (node === undefined || node.config === undefined) throw new Error("node n1 missing");
    return node as { presetId?: string; config: { promptTemplate: string } };
  };

  it("patching a preset leaves the node's config copy unchanged", async () => {
    const app = build();
    const projectId = await registerProject();
    const preset = (await listPresets(app, projectId))[0] as AgentPreset;
    const workflowId = await createWorkflowFromPreset(
      app,
      projectId,
      preset.id,
      "node copy: {{task}}",
    );

    const patched = await app.request(`/api/projects/${projectId}/presets/${preset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: { ...validConfig, promptTemplate: "rewritten preset prompt" },
      }),
    });
    expect(patched.status).toBe(200);

    const node = await graphNode(app, workflowId);
    expect(node.config.promptTemplate).toBe("node copy: {{task}}");
    expect(node.presetId).toBe(preset.id);
  });

  it("deleting a preset keeps the node (and its config copy) intact", async () => {
    const app = build();
    const projectId = await registerProject();
    const preset = (await listPresets(app, projectId))[0] as AgentPreset;
    const workflowId = await createWorkflowFromPreset(
      app,
      projectId,
      preset.id,
      "survivor: {{task}}",
    );

    const deleted = await app.request(`/api/projects/${projectId}/presets/${preset.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    const node = await graphNode(app, workflowId);
    expect(node.config.promptTemplate).toBe("survivor: {{task}}");
    // The stale presetId is left in place; clients treat a lookup miss as
    // detached (badge cleared) without mutating the node.
    expect(node.presetId).toBe(preset.id);
  });
});
