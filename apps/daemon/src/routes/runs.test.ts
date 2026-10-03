import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, Run, RunStatus, StepRun } from "@openeuler/core";
import { linearToGraph } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import type { FakeDriverOptions } from "@openeuler/drivers";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createFakeSandboxProvider } from "@openeuler/sandbox";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import type { Executor } from "../executor.js";
import { createLogger } from "../logger.js";

interface ApiHarness {
  dir: string;
  db: Db;
  storeRoot: string;
  executor: Executor;
  driver: ReturnType<typeof createFakeDriver>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
}

interface RunBody {
  run: Run & { queuePosition?: number };
}

interface RunDetailBody {
  run: Run & {
    queuePosition?: number;
    parentRunId?: string;
    childRunIds?: string[];
  };
  steps: Array<StepRun & { name?: string; durationMs?: number }>;
  /** Step runs grouped by 1-based loop pass (same enrichment as `steps`). */
  iterations: Array<{
    iteration: number;
    steps: Array<StepRun & { name?: string; durationMs?: number }>;
  }>;
  summary: { eventCount: number };
}

interface RunListBody {
  runs: Array<Run & { queuePosition?: number }>;
  nextCursor?: string;
}

interface RunStatsBody {
  queued: number;
  running: number;
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

const setup = (
  fakeOpts: FakeDriverOptions = {},
  executorOpts: { maxConcurrentRuns?: number } = {},
): ApiHarness => {
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
  const driver = createFakeDriver(fakeOpts);
  drivers.registerDriver(driver);
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot }),
    drivers,
    logger: createLogger("silent"),
    ...executorOpts,
  });
  const { app } = createApp({ db, logger: createLogger("silent"), executor });

  created.push({ db, dir });
  return {
    dir,
    db,
    storeRoot,
    executor,
    driver,
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

/** Seeds finished run rows straight into the db (deterministic list order). */
const seedRuns = (h: ApiHarness, count: number, extra: Partial<Run> = {}): Run[] =>
  Array.from({ length: count }, (_, index) =>
    h.db.runs.create({
      id: crypto.randomUUID(),
      projectId: h.projectId,
      status: "success",
      branch: `run/seed-${index}`,
      iteration: 0,
      createdAt: new Date(Date.now() - (count - index) * 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
      ...extra,
    }),
  );

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

  it("bounds the list: default limit, clamped limit, invalid limit 422", async () => {
    const h = setup({ events: script });
    const seed = seedRuns(h, 3);

    // No limit → the daemon default page.
    const def = (await (await h.request("/api/runs")).json()) as RunListBody;
    expect(def.runs).toHaveLength(3);
    expect(def.nextCursor).toBeUndefined();

    // ?limit=0 and a negative limit clamp to 1.
    const zero = (await (await h.request("/api/runs?limit=0")).json()) as RunListBody;
    expect(zero.runs).toHaveLength(1);
    const negative = (await (await h.request("/api/runs?limit=-7")).json()) as RunListBody;
    expect(negative.runs).toHaveLength(1);

    // Huge limits clamp to the max page (200) rather than erroring.
    const capped = (await (await h.request("/api/runs?limit=100000")).json()) as RunListBody;
    expect(capped.runs).toHaveLength(seed.length);

    const bad = await h.request("/api/runs?limit=many");
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as ErrorResponseBody).error.code).toBe("INVALID_LIMIT");
  });

  it("cursor-paginates newest-first with no duplicates or gaps", async () => {
    const h = setup({ events: script });
    const seed = seedRuns(h, 5);

    const collected: Run[] = [];
    const seenCursors = new Set<string>();
    let query = "/api/runs?limit=2";
    for (;;) {
      const page = (await (await h.request(query)).json()) as RunListBody;
      expect(page.runs.length).toBeLessThanOrEqual(2);
      collected.push(...page.runs);
      if (page.nextCursor === undefined) break;
      expect(seenCursors.has(page.nextCursor)).toBe(false);
      seenCursors.add(page.nextCursor);
      query = `/api/runs?limit=2&before=${encodeURIComponent(page.nextCursor)}`;
    }

    expect(collected.map((run) => run.id)).toEqual([...seed].reverse().map((run) => run.id));
    // A cursor past the oldest row is an empty page with no nextCursor.
    const oldest = collected[collected.length - 1] as Run;
    const past = (await (
      await h.request(`/api/runs?before=${encodeURIComponent(`${oldest.createdAt},${oldest.id}`)}`)
    ).json()) as RunListBody;
    expect(past).toEqual({ runs: [] });

    const malformed = await h.request("/api/runs?before=oops");
    expect(malformed.status).toBe(422);
    expect(((await malformed.json()) as ErrorResponseBody).error.code).toBe("INVALID_CURSOR");
  });

  it("decorates every row on a full page (batched names + revision)", async () => {
    const h = setup({ events: script });
    const workflow = h.db.workflows.create({
      id: crypto.randomUUID(),
      projectId: h.projectId,
      name: "named workflow",
      steps: [
        {
          id: "s1",
          name: "do",
          driver: "fake",
          promptTemplate: "{{task}}",
          mode: "auto",
          continueSession: false,
        },
      ],
    });
    const revision = h.db.workflowRevisions.create(
      workflow.id,
      linearToGraph({
        steps: [
          {
            id: "s1",
            name: "do",
            driver: "fake",
            promptTemplate: "{{task}}",
            mode: "auto",
            continueSession: false,
          },
        ],
      }),
    );
    const seed = seedRuns(h, 3, { workflowId: workflow.id, workflowRevisionId: revision.id });

    const page = (await (await h.request(`/api/runs?limit=2`)).json()) as {
      runs: Array<
        Run & {
          project?: { id: string; name: string };
          workflow?: { id: string; name: string };
          workflowRevision?: { id: string; number: number };
        }
      >;
      nextCursor?: string;
    };
    expect(page.runs).toHaveLength(2);
    const ids = new Set(seed.map((run) => run.id));
    for (const run of page.runs) {
      expect(ids.has(run.id)).toBe(true);
      expect(run.project).toMatchObject({ id: h.projectId, name: "repo" });
      expect(run.workflow).toMatchObject({ id: workflow.id, name: "named workflow" });
      expect(run.workflowRevision).toMatchObject({ id: revision.id, number: 1 });
    }
    expect(page.nextCursor).toBeDefined();
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

const insertQueuedRun = (h: ApiHarness, createdAt: string, task: string): string => {
  const runId = crypto.randomUUID();
  h.db.runs.create({
    id: runId,
    projectId: h.projectId,
    status: "queued",
    branch: `agentloop/${runId}`,
    iteration: 0,
    task,
    createdAt,
    updatedAt: createdAt,
  });
  return runId;
};

/** Seeds a run in the given status plus one ad-hoc step run (post-sweep shape). */
const seedInterruptedRun = (
  h: ApiHarness,
  step: { sessionId?: string } | null,
): { runId: string; stepRunId: string } => {
  const runId = crypto.randomUUID();
  const stepRunId = crypto.randomUUID();
  const now = new Date().toISOString();
  h.db.runs.create({
    id: runId,
    projectId: h.projectId,
    status: "interrupted",
    branch: `agentloop/${runId}`,
    iteration: 0,
    task: "recover me",
    createdAt: now,
    updatedAt: now,
  });
  if (step !== null) {
    h.db.stepRuns.create({
      id: stepRunId,
      runId,
      stepId: "adhoc",
      iteration: 1,
      ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId }),
      status: "interrupted",
      output: "part",
    });
  }
  return { runId, stepRunId };
};

describe("POST /api/runs/:id/resume", () => {
  it("resumes an interrupted run with the recorded sessionId and drives it to success", async () => {
    const h = setup({ events: script, output: "Feature implemented" });
    const { runId, stepRunId } = seedInterruptedRun(h, { sessionId: "s_1" });

    const res = await h.request(`/api/runs/${runId}/resume`, { method: "POST" });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as RunBody;
    expect(["queued", "running"]).toContain(run.status);

    const { final } = await pollRun(h, runId, "success");
    expect(final.run).toMatchObject({ status: "success", output: "Feature implemented" });
    // The fake driver received the recorded sessionId in its start opts and
    // continued that session rather than starting a fresh one.
    expect(h.driver.calls).toHaveLength(1);
    expect(h.driver.calls[0]?.sessionId).toBe("s_1");
    expect(h.driver.calls[0]?.prompt).toBe("recover me");

    // Same StepRun row reused — no duplicate — now successful.
    expect(final.steps).toHaveLength(1);
    expect(final.steps[0]).toMatchObject({
      id: stepRunId,
      status: "success",
      sessionId: "s_1",
    });
  });

  it("409s with a retry hint when a started step recorded no sessionId", async () => {
    const h = setup({ events: script });
    const { runId } = seedInterruptedRun(h, {});

    const res = await h.request(`/api/runs/${runId}/resume`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error.code).toBe("RUN_RESUME_NOT_POSSIBLE");
    expect(body.error.message).toContain("retry");
    expect(h.db.runs.get(runId)?.status).toBe("interrupted");
  });

  it("409s for runs that are not interrupted", async () => {
    const h = setup({ events: script });
    const queued = insertQueuedRun(h, new Date().toISOString(), "still waiting");
    const res = await h.request(`/api/runs/${queued}/resume`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("RUN_NOT_INTERRUPTED");

    const missing = await h.request(`/api/runs/${crypto.randomUUID()}/resume`, { method: "POST" });
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/runs/:id/retry", () => {
  it("retries an interrupted ad-hoc run as an independent run with a fresh worktree", async () => {
    const h = setup({
      events: script,
      output: "Feature implemented",
      onStart: (opts) => {
        writeFileSync(join(opts.cwd, "feature.txt"), "const feature = true;\n");
      },
    });
    const { runId } = seedInterruptedRun(h, {});

    const res = await h.request(`/api/runs/${runId}/retry`, { method: "POST" });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as RunBody;
    expect(run).toMatchObject({
      id: expect.not.stringMatching(runId),
      projectId: h.projectId,
      status: "queued",
      branch: `agentloop/${run.id}`,
      iteration: 0,
      task: "recover me",
    });

    const { final } = await pollRun(h, run.id, "success");
    expect(final.run.output).toBe("Feature implemented");
    // Fresh worktree under the NEW runId, with the agent's change.
    expect(existsSync(join(h.storeRoot, run.id, "feature.txt"))).toBe(true);
    // The original run is untouched.
    expect(h.db.runs.get(runId)?.status).toBe("interrupted");
  });

  it("copies the workflowId for workflow runs and executes it", async () => {
    const h = setup({ events: script });
    const workflow = h.db.workflows.create({
      id: crypto.randomUUID(),
      projectId: h.projectId,
      name: "flow",
      steps: [
        {
          id: "s1",
          name: "one",
          driver: "fake",
          mode: "auto",
          promptTemplate: "Task: {{task}}",
          continueSession: false,
        },
      ],
    });
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    h.db.runs.create({
      id: runId,
      projectId: h.projectId,
      workflowId: workflow.id,
      status: "failed",
      branch: `agentloop/${runId}`,
      iteration: 0,
      task: "again",
      createdAt: now,
      updatedAt: now,
    });

    const res = await h.request(`/api/runs/${runId}/retry`, { method: "POST" });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as RunBody;
    expect(run.workflowId).toBe(workflow.id);

    const { final } = await pollRun(h, run.id, "success");
    expect(final.steps[0]).toMatchObject({ stepId: "s1", status: "success" });
  });

  it("409s while the source run is still queued or running", async () => {
    const h = setup({ events: script });
    const queued = insertQueuedRun(h, new Date().toISOString(), "busy");
    const res = await h.request(`/api/runs/${queued}/retry`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("RUN_NOT_FINISHED");

    const missing = await h.request(`/api/runs/${crypto.randomUUID()}/retry`, { method: "POST" });
    expect(missing.status).toBe(404);
  });
});

const getStats = async (h: ApiHarness): Promise<RunStatsBody> => {
  const res = await h.request("/api/runs/stats");
  expect(res.status).toBe(200);
  return (await res.json()) as RunStatsBody;
};

const waitUntilStats = async (
  h: ApiHarness,
  want: RunStatsBody,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stats = await getStats(h);
    if (stats.queued === want.queued && stats.running === want.running) return;
    if (Date.now() > deadline) {
      throw new Error(`stats never reached ${JSON.stringify(want)}; last ${JSON.stringify(stats)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const listRuns = async (h: ApiHarness, query = ""): Promise<RunListBody> => {
  const res = await h.request(`/api/runs${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as RunListBody;
};

describe("queue positions", () => {
  it("exposes queuePosition for queued runs in global createdAt order; the field drops once a run starts", async () => {
    const h = setup({ events: script });
    const base = Date.now();
    const first = insertQueuedRun(h, new Date(base).toISOString(), "q0");
    const second = insertQueuedRun(h, new Date(base + 1_000).toISOString(), "q1");
    const third = insertQueuedRun(h, new Date(base + 2_000).toISOString(), "q2");

    const queued = await listRuns(h, "?status=queued");
    // Rows are newest-first, but positions follow global creation order.
    expect(queued.runs.map((run) => run.id)).toEqual([third, second, first]);
    expect(queued.runs.map((run) => run.queuePosition)).toEqual([2, 1, 0]);

    const detail = await getRun(h, second);
    expect(detail.run.queuePosition).toBe(1);

    // The first run starts: it loses the field, the others shift up.
    h.db.runs.updateStatus(first, "running");
    const after = await listRuns(h, "?status=queued");
    expect(after.runs.map((run) => run.id)).toEqual([third, second]);
    expect(after.runs.map((run) => run.queuePosition)).toEqual([1, 0]);
    const runningDetail = await getRun(h, first);
    expect("queuePosition" in runningDetail.run).toBe(false);

    // Non-queued rows in the unfiltered list never carry the field.
    const all = await listRuns(h);
    for (const run of all.runs) {
      if (run.status !== "queued") expect("queuePosition" in run).toBe(false);
    }
  });
});

describe("concurrent scheduling over the API", () => {
  it("queues above the cap, reports stats, and starts the next queued run (losing its position) after an abort", async () => {
    const deltas: AgentEvent[] = Array.from({ length: 12 }, (_, i) => ({
      type: "message-delta",
      seq: i + 1,
      delta: "tick ",
    }));
    const h = setup({ events: deltas, delayMs: 60 }, { maxConcurrentRuns: 1 });
    const otherProject = h.db.projects.create({
      id: crypto.randomUUID(),
      path: join(h.dir, "repo"),
      name: "other",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });

    const firstRes = await postRun(h, { projectId: h.projectId, prompt: "long" });
    const first = ((await firstRes.json()) as RunBody).run;
    await waitUntilStats(h, { queued: 0, running: 1 });

    const secondRes = await postRun(h, { projectId: otherProject.id, prompt: "second" });
    const thirdRes = await postRun(h, { projectId: otherProject.id, prompt: "third" });
    const second = ((await secondRes.json()) as RunBody).run;
    const third = ((await thirdRes.json()) as RunBody).run;
    await waitUntilStats(h, { queued: 2, running: 1 });

    // Both waiting runs are queued with distinct positions (global order).
    const queued = await listRuns(h, "?status=queued");
    expect(queued.runs.map((run) => run.id).sort()).toEqual([second.id, third.id].sort());
    expect([...queued.runs.map((run) => run.queuePosition)].sort()).toEqual([0, 1]);

    // Aborting the running run frees the slot: exactly one queued run starts
    // (and loses queuePosition); the other moves up to position 0.
    const abortRes = await h.request(`/api/runs/${first.id}/abort`, { method: "POST" });
    expect(abortRes.status).toBe(200);
    await pollRun(h, first.id, "aborted");
    await waitUntilStats(h, { queued: 1, running: 1 });

    const after = await listRuns(h);
    const secondRow = after.runs.find((run) => run.id === second.id);
    const thirdRow = after.runs.find((run) => run.id === third.id);
    expect(secondRow).toBeDefined();
    expect(thirdRow).toBeDefined();
    if (!secondRow || !thirdRow) throw new Error("queued runs vanished from the list");
    const runningRow = secondRow.status === "running" ? secondRow : thirdRow;
    const queuedRow = secondRow.status === "running" ? thirdRow : secondRow;
    expect("queuePosition" in runningRow).toBe(false);
    expect(queuedRow.queuePosition).toBe(0);

    // Clean up: abort the running one, then the queued one (dropped without start).
    await h.request(`/api/runs/${runningRow.id}/abort`, { method: "POST" });
    await pollRun(h, runningRow.id, "aborted");
    await h.request(`/api/runs/${queuedRow.id}/abort`, { method: "POST" });
    await pollRun(h, queuedRow.id, "aborted");
    await waitUntilStats(h, { queued: 0, running: 0 });
  }, 15_000);

  it("GET /api/runs/stats returns zeroed counts on an idle daemon", async () => {
    const h = setup({ events: script });
    expect(await getStats(h)).toEqual({ queued: 0, running: 0 });
  });
});

describe("GET /api/runs/:id sandbox info (#102)", () => {
  const sandboxDir = join(tmpdir(), `openeuler-runs-sb-${process.pid}-${Date.now()}`);

  it("carries {id, image, status} while the run executes sandboxed, absent otherwise", async () => {
    const db = createDatabase({ path: join(sandboxDir, "test.db") });
    const repoPath = join(sandboxDir, "repo");
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
    db.projects.setSandboxPolicy(project.id, {
      executionMode: "sandbox",
      image: "busybox:1.36",
    });

    const drivers = createDriverRegistry();
    const driver = createFakeDriver({
      events: [{ type: "message-delta", seq: 1, delta: "working" }],
      output: "done",
      delayMs: 120,
    });
    drivers.registerDriver(driver);
    const provider = createFakeSandboxProvider();
    const executor = createExecutor({
      db,
      worktrees: new WorktreeManager({ storeRoot: join(sandboxDir, "store") }),
      drivers,
      logger: createLogger("silent"),
      sandbox: { provider, isDockerAvailable: async () => true },
    });
    const { app } = createApp({ db, logger: createLogger("silent"), executor });

    const createRes = await app.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, prompt: "do it" }),
    });
    expect([201, 202]).toContain(createRes.status);
    const { run } = (await createRes.json()) as { run: Run };

    // Poll the detail until the sandbox appears mid-run.
    type DetailWithSandbox = RunDetailBody & {
      sandbox?: { id: string; image: string; status: string };
    };
    let detail: DetailWithSandbox | null = null;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const res = await app.request(`/api/runs/${run.id}`);
      detail = (await res.json()) as DetailWithSandbox;
      if (detail?.sandbox !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(detail?.sandbox).toMatchObject({ image: "busybox:1.36", status: "running" });
    expect(detail?.sandbox?.id).toBeTruthy();

    // Terminal: the sandbox is gone and so is the field.
    const terminalDeadline = Date.now() + 5_000;
    for (;;) {
      const row = db.runs.get(run.id);
      if (row && (row.status === "success" || row.status === "failed")) break;
      if (Date.now() > terminalDeadline) throw new Error("run never finished");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finalRes = await app.request(`/api/runs/${run.id}`);
    const finalBody = (await finalRes.json()) as typeof detail;
    expect(finalBody?.sandbox).toBeUndefined();
    expect(provider.destroyCalls).toHaveLength(1);

    db.close();
    rmSync(sandboxDir, { recursive: true, force: true });
  });
});

describe("GET /api/runs/:id step enrichment (#113)", () => {
  it("decorates steps with node name + durationMs (graph) and step name (linear)", async () => {
    const h = setup();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    h.db.runs.create({
      id: runId,
      projectId: h.projectId,
      status: "success",
      branch: `agentloop/${runId}`,
      iteration: 0,
      createdAt: now,
      updatedAt: now,
    });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId,
      stepId: "node-a",
      iteration: 1,
      status: "success",
      output: "a done",
    });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId,
      stepId: "node-b",
      iteration: 2,
      status: "failed",
      output: "",
    });
    // Graph events carry name + durationMs; the linear step.completed below
    // contributes a name only (no duration on that event type).
    h.db.events.append(runId, {
      type: "node.completed",
      nodeId: "node-a",
      nodeName: "Worker A",
      iteration: 1,
      status: "success",
      output: "a done",
      durationMs: 1_500,
    });
    h.db.events.append(runId, {
      type: "step.completed",
      stepId: "node-b",
      stepName: "Legacy step",
      iteration: 2,
      status: "failed",
    });

    const body = await getRun(h, runId);
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0]).toMatchObject({
      stepId: "node-a",
      name: "Worker A",
      durationMs: 1_500,
    });
    expect(body.steps[1]).toMatchObject({
      stepId: "node-b",
      name: "Legacy step",
    });
    expect(body.steps[1]?.durationMs).toBeUndefined();
    // The grouped view carries the same enrichment.
    expect(body.iterations[0]?.steps[0]).toMatchObject({ name: "Worker A" });
  });

  it("leaves steps untouched when the event log has no matching completions", async () => {
    const h = setup();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    h.db.runs.create({
      id: runId,
      projectId: h.projectId,
      status: "success",
      branch: `agentloop/${runId}`,
      iteration: 0,
      createdAt: now,
      updatedAt: now,
    });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId,
      stepId: "adhoc",
      iteration: 1,
      status: "success",
      output: "done",
    });

    const body = await getRun(h, runId);
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]?.name).toBeUndefined();
    expect(body.steps[0]?.durationMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sub-workflow child runs (#117): parentRunId + childRunIds on the API.
//

describe("sub-workflow runs (#117)", () => {
  const createWorkflow = async (
    h: ApiHarness,
    body: Record<string, unknown>,
  ): Promise<{ id: string }> => {
    const res = await h.request("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== 201) {
      throw new Error(`workflow create failed: ${await res.text()}`);
    }
    const created = (await res.json()) as { workflow: { id: string } };
    return created.workflow;
  };

  it("surfaces parentRunId on the child and childRunIds on the parent", async () => {
    const h = setup({ events: script, delayMs: 10 });
    const step = (id: string) => ({
      id,
      name: id,
      driver: "fake",
      mode: "auto",
      promptTemplate: `{{task}} (${id})`,
      continueSession: false,
    });
    const child = await createWorkflow(h, {
      projectId: h.projectId,
      name: "child",
      steps: [step("c1"), step("c2")],
    });
    const parent = await createWorkflow(h, {
      projectId: h.projectId,
      name: "parent",
      graph: {
        entryNodeId: "a",
        nodes: [
          {
            id: "a",
            type: "agent",
            name: "a",
            position: { x: 0, y: 0 },
            config: {
              driver: "fake",
              mode: "auto",
              promptTemplate: "A[{{task}}]",
              continueSession: false,
            },
          },
          {
            id: "sub",
            type: "subworkflow",
            name: "spawn",
            position: { x: 280, y: 0 },
            config: { workflowId: child.id, revision: "latest" },
          },
          { id: "exit", type: "exit", name: "Exit", position: { x: 560, y: 0 } },
        ],
        edges: [
          { id: "e1", source: "a", target: "sub", condition: { type: "always" } },
          { id: "e2", source: "sub", target: "exit", condition: { type: "always" } },
        ],
      },
    });

    const runRes = await h.request(`/api/workflows/${parent.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "compose the teams" }),
    });
    expect(runRes.status).toBe(202);
    const { run: parentRun } = (await runRes.json()) as RunBody;
    const { final } = await pollRun(h, parentRun.id, "success");
    expect(final.run.childRunIds).toHaveLength(1);
    const childRunId = final.run.childRunIds?.[0];
    expect(typeof childRunId).toBe("string");

    // The child shows in the runs table (same project) with parentRunId set.
    const list = await listRuns(h);
    const childRow = list.runs.find((candidate) => candidate.id === childRunId);
    expect(childRow).toMatchObject({ parentRunId: parentRun.id, status: "success" });

    // Child detail links back up; it has no children of its own.
    const childDetail = await getRun(h, childRunId as string);
    expect(childDetail.run.parentRunId).toBe(parentRun.id);
    expect("childRunIds" in childDetail.run).toBe(false);
  }, 10_000);
});
