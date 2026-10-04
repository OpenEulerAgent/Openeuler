import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Step } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createApp } from "../app.js";

/**
 * Workflow schedule management API (#121): PUT upsert (strict cron +
 * timezone validation), GET/DELETE, the schedule summary on workflow
 * list/detail bodies (badge backing), workflow-delete cascade, and auth
 * coverage under a bearer token.
 */

interface ErrorResponseBody {
  error: { code: string; message: string; details?: Array<{ path: string; message: string }> };
}

interface Harness {
  dir: string;
  db: Db;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  workflowId: string;
}

const created: { db: Db; dir: string }[] = [];

const setup = (options: { authToken?: string } = {}): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-sched-api-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  execFileSync("git", ["add", "-A"], { cwd: repoPath, stdio: "pipe" });
  execFileSync(
    "git",
    ["-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init"],
    { cwd: repoPath, stdio: "pipe" },
  );

  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: repoPath,
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  const steps: Step[] = [
    {
      id: "worker",
      name: "Worker",
      driver: "fake",
      mode: "auto",
      promptTemplate: "Do: {{task}}",
      continueSession: false,
    },
  ];
  const workflow = db.workflows.create({
    id: crypto.randomUUID(),
    projectId: project.id,
    name: "sched",
    steps,
  });

  const { app } = createApp({
    db,
    logger: undefined,
    secretsKey: Buffer.alloc(32, 7),
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
  });

  created.push({ db, dir });
  return {
    dir,
    db,
    request: (path, init) => Promise.resolve(app.request(path, init)),
    workflowId: workflow.id,
  };
};

beforeEach(() => {
  created.length = 0;
});

afterEach(() => {
  for (const { db, dir } of created) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const configBody = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    enabled: true,
    cron: "30 9 * * 1-5",
    taskTemplate: "morning triage",
    timezone: "America/New_York",
    ...over,
  });

const putSchedule = (h: Harness, body: string): Promise<Response> =>
  h.request(`/api/workflows/${h.workflowId}/schedule`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
  });

describe("workflow schedule API (#121)", () => {
  it("PUT creates then updates in place (one row, 200 both times)", async () => {
    const h = setup();
    const first = await putSchedule(h, configBody());
    expect(first.status).toBe(200);
    const createdBody = (await first.json()) as { schedule: { id: string; cron: string } };
    expect(createdBody.schedule.cron).toBe("30 9 * * 1-5");

    const second = await putSchedule(h, configBody({ cron: "0 12 * * *", enabled: false }));
    expect(second.status).toBe(200);
    const updated = (await second.json()) as { schedule: { id: string; cron: string } };
    expect(updated.schedule.id).toBe(createdBody.schedule.id);
    expect(updated.schedule.cron).toBe("0 12 * * *");

    const rows = h.db.sqlite.prepare("select count(*) as n from workflow_schedules").get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it("GET answers 404 SCHEDULE_NOT_FOUND before, the schedule after", async () => {
    const h = setup();
    const missing = await h.request(`/api/workflows/${h.workflowId}/schedule`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorResponseBody).error.code).toBe("SCHEDULE_NOT_FOUND");

    await putSchedule(h, configBody());
    const found = await h.request(`/api/workflows/${h.workflowId}/schedule`);
    expect(found.status).toBe(200);
    const body = (await found.json()) as { schedule: Record<string, unknown> };
    expect(body.schedule["enabled"]).toBe(true);
    expect(body.schedule["timezone"]).toBe("America/New_York");
  });

  it("PUT rejects invalid crons with 422 and a field-attributed detail", async () => {
    const h = setup();
    const res = await putSchedule(h, configBody({ cron: "61 9 * * *" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details?.[0]?.path).toContain("cron");
    expect(body.error.details?.[0]?.message).toContain("minute");
  });

  it("PUT rejects invalid timezones and empty task templates", async () => {
    const h = setup();
    const tz = await putSchedule(h, configBody({ timezone: "Mars/Olympus" }));
    expect(tz.status).toBe(422);
    expect(((await tz.json()) as ErrorResponseBody).error.details?.[0]?.path).toContain("timezone");

    const task = await putSchedule(h, configBody({ taskTemplate: "" }));
    expect(task.status).toBe(422);
    expect(((await task.json()) as ErrorResponseBody).error.details?.[0]?.path).toContain(
      "taskTemplate",
    );
  });

  it("PUT/GET/DELETE answer 404 WORKFLOW_NOT_FOUND for unknown workflows", async () => {
    const h = setup();
    for (const [method, path] of [
      ["GET", "/api/workflows/nope/schedule"],
      ["PUT", "/api/workflows/nope/schedule"],
      ["DELETE", "/api/workflows/nope/schedule"],
    ] as const) {
      const res = await h.request(path, {
        method,
        ...(method === "PUT"
          ? { headers: { "content-type": "application/json" }, body: configBody() }
          : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(((await res.json()) as ErrorResponseBody).error.code).toBe("WORKFLOW_NOT_FOUND");
    }
  });

  it("DELETE removes the schedule, second DELETE 404s", async () => {
    const h = setup();
    await putSchedule(h, configBody());
    const gone = await h.request(`/api/workflows/${h.workflowId}/schedule`, { method: "DELETE" });
    expect(gone.status).toBe(204);
    const again = await h.request(`/api/workflows/${h.workflowId}/schedule`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("workflow list and detail carry the schedule summary for badges", async () => {
    const h = setup();
    const before = (await (await h.request(`/api/workflows/${h.workflowId}`)).json()) as {
      workflow: Record<string, unknown>;
    };
    expect(before.workflow["schedule"]).toBeUndefined();

    await putSchedule(h, configBody());
    const detail = (await (await h.request(`/api/workflows/${h.workflowId}`)).json()) as {
      workflow: { schedule?: { enabled: boolean; cron: string } };
    };
    expect(detail.workflow.schedule).toEqual({
      enabled: true,
      cron: "30 9 * * 1-5",
      timezone: "America/New_York",
    });

    await putSchedule(h, configBody({ enabled: false }));
    const list = (await (
      await h.request(
        `/api/workflows?projectId=${(detail.workflow as { projectId: string }).projectId}`,
      )
    ).json()) as { workflows: Array<{ schedule?: { enabled: boolean } }> };
    expect(list.workflows[0]?.schedule?.enabled).toBe(false);
  });

  it("deleting the workflow cascades the schedule", async () => {
    const h = setup();
    await putSchedule(h, configBody());
    const res = await h.request(`/api/workflows/${h.workflowId}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(h.db.workflowSchedules.getByWorkflow(h.workflowId)).toBeUndefined();
  });

  it("requires the bearer token when auth mode is on", async () => {
    const h = setup({ authToken: "s3cret" });
    const unauthorized = await putSchedule(h, configBody());
    expect(unauthorized.status).toBe(401);
    const authorized = await h.request(`/api/workflows/${h.workflowId}/schedule`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
      body: configBody(),
    });
    expect(authorized.status).toBe(200);
  });
});
