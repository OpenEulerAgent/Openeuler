import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run, Step, Workflow } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import { createLogger } from "../logger.js";

interface ApiHarness {
  dir: string;
  db: Db;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
  makeSteps(...drivers: string[]): Step[];
}

interface ErrorResponseBody {
  error: { code: string; message: string };
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const created: { db: Db; dir: string }[] = [];

const setup = (): ApiHarness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-workflows-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  git(repoPath, "add", "-A");
  git(repoPath, "-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init");

  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: repoPath,
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });

  const drivers = createDriverRegistry();
  drivers.registerDriver(
    createFakeDriver({
      id: "first",
      events: [{ type: "session", seq: 1, sessionId: "s-first" }],
      output: "FIRST-OUT",
    }),
  );
  drivers.registerDriver(
    createFakeDriver({
      id: "second",
      events: [{ type: "session", seq: 1, sessionId: "s-second" }],
      output: "SECOND-OUT",
    }),
  );
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot: join(dir, "store") }),
    drivers,
    logger: createLogger("silent"),
  });
  const { app } = createApp({ db, logger: createLogger("silent"), executor });

  created.push({ db, dir });
  return {
    dir,
    db,
    request: (path, init) => Promise.resolve(app.request(path, init)),
    projectId: project.id,
    makeSteps(...driverIds) {
      return driverIds.map((driver, index) => ({
        id: `s${index + 1}`,
        name: `step-${index + 1}`,
        driver,
        mode: "auto" as const,
        promptTemplate: index === 0 ? "{{task}}" : "prev: {{prevOutput}}",
        continueSession: index > 0,
      }));
    },
  };
};

afterEach(() => {
  while (created.length > 0) {
    const item = created.pop() as { db: Db; dir: string };
    item.db.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

const postWorkflow = (h: ApiHarness, body: Record<string, unknown>): Promise<Response> =>
  h.request("/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createWorkflow = async (h: ApiHarness, body: Record<string, unknown>): Promise<Workflow> => {
  const res = await postWorkflow(h, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { workflow: Workflow }).workflow;
};

const awaitRunStatus = async (h: ApiHarness, runId: string, want: Run["status"]): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = h.db.runs.get(runId);
    if (run?.status === want) return;
    if (Date.now() > deadline) throw new Error(`run never reached ${want}; at ${run?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("POST /api/workflows", () => {
  it("creates a workflow (201) and round-trips it via GET", async () => {
    const h = setup();
    const steps = h.makeSteps("first", "second");
    const res = await postWorkflow(h, { projectId: h.projectId, name: "ship-it", steps });
    expect(res.status).toBe(201);
    const { workflow } = (await res.json()) as { workflow: Workflow };
    expect(workflow).toMatchObject({
      id: expect.any(String),
      projectId: h.projectId,
      name: "ship-it",
    });
    expect(workflow.steps).toEqual(steps);

    const got = await h.request(`/api/workflows/${workflow.id}`);
    expect(got.status).toBe(200);
    expect(((await got.json()) as { workflow: Workflow }).workflow).toEqual(workflow);

    const list = await h.request(`/api/workflows?projectId=${h.projectId}`);
    expect(
      ((await await list.json()) as { workflows: Workflow[] }).workflows.map((w) => w.id),
    ).toEqual([workflow.id]);
  });

  it("422s on invalid step config from zod", async () => {
    const h = setup();
    const cases: Array<Record<string, unknown>> = [
      {},
      { projectId: h.projectId },
      { projectId: h.projectId, name: "", steps: h.makeSteps("first") },
      { projectId: h.projectId, name: "x", steps: [] },
      {
        projectId: h.projectId,
        name: "x",
        steps: [
          {
            id: "s1",
            name: "bad mode",
            driver: "first",
            mode: "yolo",
            promptTemplate: "{{task}}",
            continueSession: false,
          },
        ],
      },
      {
        projectId: h.projectId,
        name: "x",
        steps: [
          {
            id: "s1",
            name: "no template",
            driver: "first",
            mode: "auto",
            promptTemplate: "",
            continueSession: false,
          },
        ],
      },
      {
        projectId: h.projectId,
        name: "x",
        steps: [
          {
            id: "s1",
            name: "extra key",
            driver: "first",
            mode: "auto",
            promptTemplate: "{{task}}",
            continueSession: false,
            surprise: 1,
          },
        ],
      },
      {
        projectId: h.projectId,
        name: "x",
        steps: h.makeSteps("first"),
        loopBack: { toStepIndex: -1 },
      },
    ];
    for (const body of cases) {
      const res = await postWorkflow(h, body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorResponseBody).error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("404s for an unknown project", async () => {
    const h = setup();
    const res = await postWorkflow(h, {
      projectId: crypto.randomUUID(),
      name: "x",
      steps: h.makeSteps("first"),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("GET /api/workflows", () => {
  it("lists workflows filtered by projectId; 404s unknown ids", async () => {
    const h = setup();
    const other = h.db.projects.create({
      id: crypto.randomUUID(),
      path: join(h.dir, "repo"),
      name: "repo-2",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    const mine = (
      (await (
        await postWorkflow(h, { projectId: h.projectId, name: "mine", steps: h.makeSteps("first") })
      ).json()) as { workflow: Workflow }
    ).workflow;
    await postWorkflow(h, { projectId: other.id, name: "theirs", steps: h.makeSteps("second") });

    const scoped = (await (await h.request(`/api/workflows?projectId=${h.projectId}`)).json()) as {
      workflows: Workflow[];
    };
    expect(scoped.workflows.map((w) => w.id)).toEqual([mine.id]);

    const all = (await (await h.request("/api/workflows")).json()) as { workflows: Workflow[] };
    expect(all.workflows).toHaveLength(2);

    const missing = await h.request(`/api/workflows/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorResponseBody).error.code).toBe("WORKFLOW_NOT_FOUND");
  });
});

describe("PATCH /api/workflows/:id", () => {
  it("patches name, steps and loopBack (null clears)", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "v1",
      steps: h.makeSteps("first"),
    });

    const renamed = await h.request(`/api/workflows/${workflow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "v2" }),
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { workflow: Workflow }).workflow.name).toBe("v2");

    const withLoop = await h.request(`/api/workflows/${workflow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        steps: h.makeSteps("first", "second"),
        loopBack: { toStepIndex: 0, when: { type: "always" }, maxIterations: 2 },
      }),
    });
    expect(withLoop.status).toBe(200);
    const patched = ((await withLoop.json()) as { workflow: Workflow }).workflow;
    expect(patched.steps).toHaveLength(2);
    expect(patched.loopBack).toEqual({
      toStepIndex: 0,
      when: { type: "always" },
      maxIterations: 2,
    });

    const cleared = await h.request(`/api/workflows/${workflow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loopBack: null }),
    });
    expect(((await cleared.json()) as { workflow: Workflow }).workflow.loopBack).toBeUndefined();
  });

  it("422s on invalid patches and 404s unknown ids", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "x",
      steps: h.makeSteps("first"),
    });

    const bad = await h.request(`/api/workflows/${workflow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps: [{ id: "s1", name: "no driver" }] }),
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as ErrorResponseBody).error.code).toBe("VALIDATION_ERROR");

    const missing = await h.request(`/api/workflows/${crypto.randomUUID()}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "y" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("DELETE /api/workflows/:id", () => {
  it("deletes an unused workflow (204) and 404s afterwards", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "x",
      steps: h.makeSteps("first"),
    });

    const res = await h.request(`/api/workflows/${workflow.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await h.request(`/api/workflows/${workflow.id}`)).status).toBe(404);
    expect((await h.request(`/api/workflows/${workflow.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("409s while runs reference the workflow", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "x",
      steps: h.makeSteps("first"),
    });
    const run = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "go" }),
    });
    expect(run.status).toBe(202);

    const res = await h.request(`/api/workflows/${workflow.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("WORKFLOW_IN_USE");
  });
});

describe("POST /api/workflows/:id/runs", () => {
  it("202s a queued workflow run that succeeds with ordered engine + driver events", async () => {
    const h = setup();
    const steps = h.makeSteps("first", "second");
    const workflow = await createWorkflow(h, { projectId: h.projectId, name: "two-step", steps });

    const res = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "do the thing" }),
    });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as { run: Run };
    expect(run).toMatchObject({
      id: expect.any(String),
      projectId: h.projectId,
      workflowId: workflow.id,
      status: "queued",
      branch: `agentloop/${run.id}`,
      iteration: 0,
      task: "do the thing",
    });

    await awaitRunStatus(h, run.id, "success");
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "SECOND-OUT" });

    // Ordered log: run.status wraps step.started / driver events / step.completed.
    const events = h.db.events.getSince(run.id);
    expect(
      events.map((event) => `${event.type}${"status" in event ? `:${event.status}` : ""}`),
    ).toEqual([
      "run.status:running",
      "step.started",
      "started",
      "session",
      "step.completed:success",
      "step.started",
      "started",
      "session",
      "step.completed:success",
      "run.status:success",
    ]);

    // GET /api/runs/:id returns step runs grouped by iteration, in workflow order.
    const detail = (await (await h.request(`/api/runs/${run.id}`)).json()) as {
      run: Run;
      steps: Array<{ stepId: string; status: string; sessionId?: string }>;
      iterations: Array<{ iteration: number; steps: Array<{ stepId: string; status: string }> }>;
    };
    expect(detail.steps.map((step) => step.stepId)).toEqual(["s1", "s2"]);
    expect(detail.steps.map((step) => step.sessionId)).toEqual(["s-first", "s-second"]);
    expect(detail.iterations.map((group) => group.iteration)).toEqual([1]);
    expect(detail.iterations[0]?.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["s1", "success"],
      ["s2", "success"],
    ]);
  });

  it("422s on an empty task and 404s for an unknown workflow", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "x",
      steps: h.makeSteps("first"),
    });

    const bad = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "" }),
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as ErrorResponseBody).error.code).toBe("VALIDATION_ERROR");

    const missing = await h.request(`/api/workflows/${crypto.randomUUID()}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "go" }),
    });
    expect(missing.status).toBe(404);
  });
});
