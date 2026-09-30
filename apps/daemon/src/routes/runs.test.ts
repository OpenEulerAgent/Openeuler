import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, Run, RunStatus, StepRun } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import type { FakeDriverOptions } from "@openeuler/drivers";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import { createLogger } from "../logger.js";

interface ApiHarness {
  dir: string;
  db: Db;
  storeRoot: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
}

interface RunBody {
  run: Run;
}

interface RunDetailBody {
  run: Run;
  steps: StepRun[];
  summary: { eventCount: number };
}

interface ErrorResponseBody {
  error: { code: string; message: string };
}

const script: AgentEvent[] = [
  { type: "session", seq: 1, sessionId: "s_1" },
  { type: "message-delta", seq: 2, delta: "Implementing feature... " },
  { type: "tool-call", seq: 3, tool: "write", input: { path: "feature.txt" } },
  { type: "tool-output", seq: 4, output: "wrote feature.txt" },
  { type: "done", seq: 5, output: "Feature implemented" },
];

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const created: { db: Db; dir: string }[] = [];

const setup = (fakeOpts: FakeDriverOptions = {}): ApiHarness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-runs-"));
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

  const storeRoot = join(dir, "store");
  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver(fakeOpts));
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot }),
    drivers,
    logger: createLogger("silent"),
  });
  const { app } = createApp({ db, logger: createLogger("silent"), executor });

  created.push({ db, dir });
  return {
    dir,
    db,
    storeRoot,
    request: (path, init) => Promise.resolve(app.request(path, init)),
    projectId: project.id,
  };
};

afterEach(() => {
  while (created.length > 0) {
    const item = created.pop() as { db: Db; dir: string };
    item.db.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

const postRun = (h: ApiHarness, body: Record<string, unknown>): Promise<Response> =>
  h.request("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const getRun = async (h: ApiHarness, runId: string): Promise<RunDetailBody> => {
  const res = await h.request(`/api/runs/${runId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as RunDetailBody;
};

const pollRun = async (
  h: ApiHarness,
  runId: string,
  want: RunStatus,
  timeoutMs = 5_000,
): Promise<{ observed: RunStatus[]; final: RunDetailBody }> => {
  const observed: RunStatus[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await getRun(h, runId);
    observed.push(body.run.status);
    if (body.run.status === want) return { observed, final: body };
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${want}; last status ${body.run.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("POST /api/runs (ad-hoc single-step run)", () => {
  it("202 queued → running → success with ordered events, session and diff", async () => {
    const h = setup({
      events: script,
      delayMs: 25,
      output: "Feature implemented",
      onStart: (opts) => {
        writeFileSync(join(opts.cwd, "feature.txt"), "const feature = true;\n");
      },
    });

    const res = await postRun(h, {
      projectId: h.projectId,
      prompt: "Add the feature",
      model: "glm-4.6",
    });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as RunBody;
    expect(run).toMatchObject({
      id: expect.any(String),
      projectId: h.projectId,
      status: "queued",
      branch: `agentloop/${run.id}`,
      iteration: 0,
      task: "Add the feature",
    });
    expect("workflowId" in run).toBe(false);

    const { observed, final } = await pollRun(h, run.id, "success");
    expect(observed).toContain("running");

    // StepRun finalized: session bound, output + diff captured.
    const step = final.steps;
    expect(step).toHaveLength(1);
    expect(step[0]).toMatchObject({
      stepId: "adhoc",
      iteration: 1,
      status: "success",
      sessionId: "s_1",
      output: "Feature implemented",
    });
    expect(step[0]?.diff).toContain("feature.txt");
    expect(final.run).toMatchObject({ status: "success", output: "Feature implemented" });
    expect(final.summary.eventCount).toBe(script.length + 5);
    // Engine events (run.status ×2, step.started, step.completed) persist
    // around the driver events, in seq order.
    const events = h.db.events.getSince(run.id);
    expect(events.map((event) => event.type)).toEqual([
      "run.status",
      "step.started",
      "started",
      ...script.map((event) => event.type),
      "step.completed",
      "run.status",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Worktree exists on disk with the agent's file change.
    const worktreePath = join(h.storeRoot, run.id);
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, "feature.txt"))).toBe(true);
  });

  it("rejects invalid bodies with 422", async () => {
    const h = setup({ events: script });
    const cases: Array<Record<string, unknown>> = [
      {},
      { projectId: h.projectId },
      { prompt: "do it" },
      { projectId: "", prompt: "x" },
      { projectId: h.projectId, prompt: "x", mode: "yolo" },
      { projectId: h.projectId, prompt: "x", extra: true },
    ];
    for (const body of cases) {
      const res = await postRun(h, body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorResponseBody).error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects malformed JSON with 422", async () => {
    const h = setup({ events: script });
    const res = await h.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "nope{",
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("INVALID_JSON");
  });

  it("404s for an unknown project", async () => {
    const h = setup({ events: script });
    const res = await postRun(h, { projectId: crypto.randomUUID(), prompt: "x" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("GET /api/runs", () => {
  it("lists runs with projectId and status filters", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "ok" }] });
    const firstRes = await postRun(h, { projectId: h.projectId, prompt: "one" });
    const first = ((await firstRes.json()) as RunBody).run;
    await pollRun(h, first.id, "success");

    const otherProject = h.db.projects.create({
      id: crypto.randomUUID(),
      path: join(h.dir, "repo"),
      name: "repo",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    const second = await postRun(h, { projectId: otherProject.id, prompt: "two" });
    const secondRun = ((await second.json()) as RunBody).run;
    await pollRun(h, secondRun.id, "success");

    const all = (await (await h.request("/api/runs")).json()) as { runs: Run[] };
    expect(all.runs).toHaveLength(2);

    const scoped = (await (await h.request(`/api/runs?projectId=${h.projectId}`)).json()) as {
      runs: Run[];
    };
    expect(scoped.runs.map((run) => run.id)).toEqual([first.id]);

    const filtered = (await (
      await h.request(`/api/runs?projectId=${otherProject.id}&status=success`)
    ).json()) as { runs: Run[] };
    expect(filtered.runs.map((run) => run.id)).toEqual([secondRun.id]);

    const none = (await (
      await h.request(`/api/runs?projectId=${h.projectId}&status=queued`)
    ).json()) as { runs: Run[] };
    expect(none.runs).toEqual([]);
  });

  it("rejects an invalid status filter with 422", async () => {
    const h = setup({ events: script });
    const res = await h.request("/api/runs?status=exploded");
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("INVALID_STATUS");
  });

  it("returns 404 for unknown run ids", async () => {
    const h = setup({ events: script });
    const unknown = crypto.randomUUID();
    const got = await h.request(`/api/runs/${unknown}`);
    expect(got.status).toBe(404);
    expect(((await got.json()) as ErrorResponseBody).error.code).toBe("RUN_NOT_FOUND");
  });
});

describe("POST /api/runs/:id/abort", () => {
  it("aborts a running run; worktree stays inspectable; second abort 409s", async () => {
    const h = setup({
      events: [
        { type: "message-delta", seq: 1, delta: "thinking " },
        { type: "message-delta", seq: 2, delta: "still " },
        { type: "message-delta", seq: 3, delta: "working " },
        { type: "message-delta", seq: 4, delta: "nearly " },
        { type: "message-delta", seq: 5, delta: "done?" },
      ],
      delayMs: 50,
    });
    const created = await postRun(h, { projectId: h.projectId, prompt: "long task" });
    const { run } = (await created.json()) as RunBody;

    // Wait until the step is actually running mid-stream (run.status +
    // step.started + at least one driver event) so the abort cuts the driver.
    const started = Date.now();
    while (
      h.db.runs.get(run.id)?.status !== "running" ||
      h.db.stepRuns.listByRun(run.id)[0]?.status !== "running" ||
      h.db.events.count(run.id) < 3
    ) {
      if (Date.now() - started > 5_000) throw new Error("run never started streaming");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const abortRes = await h.request(`/api/runs/${run.id}/abort`, { method: "POST" });
    expect(abortRes.status).toBe(200);
    const abortedRun = ((await abortRes.json()) as RunBody).run;
    expect(abortedRun.status).toBe("aborted");

    await pollRun(h, run.id, "aborted");
    // The scripted driver run was cut short: not all 5 deltas made it to the log.
    const driverDeltas = h.db.events
      .getSince(run.id)
      .filter((event) => event.type === "message-delta");
    expect(driverDeltas.length).toBeLessThan(5);

    // No orphan: the executor settles, the step run finalizes, and the
    // worktree is still on disk for inspection.
    const deadline = Date.now() + 5_000;
    while (h.db.stepRuns.listByRun(run.id)[0]?.status !== "aborted") {
      if (Date.now() > deadline) throw new Error("step run never settled after abort");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const settled = await getRun(h, run.id);
    expect(settled.steps[0]).toMatchObject({ status: "aborted" });
    expect(existsSync(join(h.storeRoot, run.id))).toBe(true);

    const again = await h.request(`/api/runs/${run.id}/abort`, { method: "POST" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorResponseBody).error.code).toBe("RUN_TERMINAL");
  });

  it("returns 404 for unknown run ids", async () => {
    const h = setup({ events: script });
    const res = await h.request(`/api/runs/${crypto.randomUUID()}/abort`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("RUN_NOT_FOUND");
  });

  it("409s when the run already succeeded", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "ok" }] });
    const created = await postRun(h, { projectId: h.projectId, prompt: "quick" });
    const { run } = (await created.json()) as RunBody;
    await pollRun(h, run.id, "success");
    const res = await h.request(`/api/runs/${run.id}/abort`, { method: "POST" });
    expect(res.status).toBe(409);
  });
});

describe("driver failure isolation", () => {
  it("marks the run failed with the message and the daemon keeps serving", async () => {
    const h = setup({ events: script, exitCode: 3, output: "partial output" });
    const created = await postRun(h, { projectId: h.projectId, prompt: "will fail" });
    const { run } = (await created.json()) as RunBody;

    const { final } = await pollRun(h, run.id, "failed");
    expect(final.run.error).toBe("agent exited with code 3");
    expect(final.run.output).toBe("partial output");
    expect(final.steps[0]).toMatchObject({ status: "failed", output: "partial output" });

    // Daemon healthy: a subsequent run on a fresh executor reaches success.
    const healthy = setup({ events: [{ type: "done", seq: 1 }], output: "fine" });
    const next = await postRun(healthy, { projectId: healthy.projectId, prompt: "again" });
    expect(next.status).toBe(202);
    const nextRun = ((await next.json()) as RunBody).run;
    const done = await pollRun(healthy, nextRun.id, "success");
    expect(done.final.run.output).toBe("fine");
  });

  it("fails the run when the project repo vanished, then serves fine", async () => {
    const h = setup({ events: script });
    const vanished = h.db.projects.create({
      id: crypto.randomUUID(),
      path: join(h.dir, "vanished"),
      name: "vanished",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    mkdirSync(join(h.dir, "vanished"), { recursive: true });
    const created = await postRun(h, { projectId: vanished.id, prompt: "x" });
    const { run } = (await created.json()) as RunBody;
    const { final } = await pollRun(h, run.id, "failed");
    expect(final.run.error).toBeTruthy();
    // The failure happened before any step started: no StepRun rows exist.
    expect(final.steps).toEqual([]);

    const health = await h.request("/health");
    expect(health.status).toBe(200);
  });
});
