import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";

/**
 * `PATCH /api/projects/:id/policy` (#101): whole-policy replace with zod
 * 422 clamp messages, served back via the project payload on GET, behind
 * the daemon auth gate like every /api route.
 */

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

let workDir: string;
let db: Db;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openeuler-policy-api-"));
  db = createDatabase({ path: join(workDir, "test.db") });
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

const makeRepo = (name: string): string => {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init");
  return dir;
};

const build = () => createApp({ db, logger: createLogger("silent") }).app;

const register = async (app: ReturnType<typeof build> = build()): Promise<string> => {
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: makeRepo(`repo-${crypto.randomUUID().slice(0, 8)}`) }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { project: { id: string } };
  return body.project.id;
};

const patchPolicy = (app: ReturnType<typeof build>, id: string, policy: unknown) =>
  app.request(`/api/projects/${id}/policy`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(policy),
  });

const getProject = async (app: ReturnType<typeof build>, id: string) =>
  (
    (await (await app.request(`/api/projects/${id}`)).json()) as {
      project: { sandboxPolicy?: unknown };
    }
  ).project;

describe("PATCH /api/projects/:id/policy", () => {
  it("saves a full policy and serves it back via the project payload", async () => {
    const app = build();
    const id = await register(app);
    const policy = {
      executionMode: "sandbox",
      image: "openeuler/worker:latest",
      cpus: 4,
      memoryMb: 4096,
      network: "limited",
      cachePaths: ["/root/.cache"],
      keepForDebug: true,
    };
    const res = await patchPolicy(app, id, policy);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { sandboxPolicy: unknown } };
    expect(body.project.sandboxPolicy).toEqual(policy);

    const project = await getProject(app, id);
    expect(project.sandboxPolicy).toEqual(policy);
  });

  it("defaults executionMode to local when omitted (#102 zero-regression default)", async () => {
    const app = build();
    const id = await register(app);
    const res = await patchPolicy(app, id, { cpus: 2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { sandboxPolicy: { executionMode: string } } };
    expect(body.project.sandboxPolicy.executionMode).toBe("local");
  });

  it("replaces the whole policy (dropped fields disappear)", async () => {
    const app = build();
    const id = await register(app);
    await patchPolicy(app, id, { executionMode: "sandbox", image: "busybox:1.36", cpus: 8 });
    const second = await patchPolicy(app, id, { executionMode: "local" });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { project: { sandboxPolicy: unknown } };
    expect(body.project.sandboxPolicy).toEqual({ executionMode: "local" });
  });

  it("422s with clamp messages outside the ranges", async () => {
    const app = build();
    const id = await register(app);
    for (const [policy, fragment] of [
      [{ cpus: 0 }, "cpus must be >= 1"],
      [{ cpus: 9 }, "cpus must be <= 8"],
      [{ cpus: 1.5 }, "whole number"],
      [{ memoryMb: 128 }, "memoryMb must be >= 512"],
      [{ memoryMb: 9999 }, "memoryMb must be <= 8192"],
      [{ image: "NOT-LOWER" }, "image must be a lowercase reference"],
      [{ network: "bridge" }, 'expected one of "none"|"limited"|"default"'],
      [{ cachePaths: ["relative"] }, "absolute container paths"],
      [{ cachePaths: ["/a", "/b", "/c", "/d", "/e", "/f"] }, "at most 5 cache paths"],
      [{ executionMode: "container" }, 'expected one of "local"|"sandbox"|"auto"'],
    ] as const) {
      const res = await patchPolicy(app, id, policy);
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        error: { code: string; message: string; details?: Array<{ path: string }> };
      };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain(fragment);
      expect(body.error.details?.length).toBeGreaterThan(0);
    }
  });

  it("422s on invalid JSON body", async () => {
    const app = build();
    const id = await register(app);
    const res = await app.request(`/api/projects/${id}/policy`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_JSON");
  });

  it("404s for an unknown project", async () => {
    const app = build();
    const res = await patchPolicy(app, "ghost", { executionMode: "auto" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("requires the bearer token when auth is on (like every /api route)", async () => {
    const app = createApp({ db, logger: createLogger("silent"), authToken: "s3cret" }).app;
    db.projects.create({
      id: "p-auth",
      path: "/tmp/demo",
      name: "demo",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    const denied = await app.request(`/api/projects/p-auth/policy`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ executionMode: "auto" }),
    });
    expect(denied.status).toBe(401);
    const allowed = await app.request(`/api/projects/p-auth/policy`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer s3cret" },
      body: JSON.stringify({ executionMode: "auto" }),
    });
    expect(allowed.status).toBe(200);
  });

  it("node overrides validate as part of the graph save (core schema via zod)", async () => {
    const app = build();
    const id = await register(app);
    // Create a workflow through the API, then save a graph revision whose
    // node carries sandbox overrides — valid ones store, invalid ones 422.
    const workflowRes = await app.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: id,
        name: "wf",
        steps: [
          {
            id: "a",
            name: "A",
            driver: "opencode",
            mode: "auto",
            promptTemplate: "{{task}}",
            continueSession: false,
          },
        ],
      }),
    });
    expect(workflowRes.status).toBe(201);
    const workflow = (await workflowRes.json()) as { workflow: { id: string } };

    const baseNode = {
      id: "a",
      type: "agent" as const,
      name: "A",
      position: { x: 0, y: 0 },
      config: {
        driver: "opencode",
        mode: "auto" as const,
        promptTemplate: "{{task}}",
        continueSession: false,
      },
    };
    const baseGraph = { entryNodeId: "a", nodes: [baseNode], edges: [] };
    const save = async (sandboxOverrides: unknown) =>
      app.request(`/api/workflows/${workflow.workflow.id}/graph`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          graph: {
            ...baseGraph,
            nodes: [
              {
                ...baseNode,
                config: {
                  ...baseNode.config,
                  sandboxOverrides,
                },
              },
            ],
          },
        }),
      });

    const good = await save({ image: "busybox:1.36", cpus: 4, network: "none" });
    expect(good.status).toBe(200);

    const bad = await save({ memoryMb: 1 });
    expect(bad.status).toBe(422);
    const body = (await bad.json()) as {
      error: { details?: Array<{ path: string; message: string }> };
    };
    expect(body.error.details?.[0]?.path).toContain("sandboxOverrides");
  });
});
