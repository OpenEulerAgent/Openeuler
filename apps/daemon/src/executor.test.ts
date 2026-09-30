import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import type { FakeDriverOptions } from "@openeuler/drivers";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createExecutor } from "./executor.js";
import type { Executor, ExecutorOptions } from "./executor.js";
import { createLogger } from "./logger.js";

const script: AgentEvent[] = [
  { type: "session", seq: 1, sessionId: "s_1" },
  { type: "message-delta", seq: 2, delta: "working" },
  { type: "done", seq: 3, output: "all done" },
];

interface Harness {
  dir: string;
  db: Db;
  worktrees: WorktreeManager;
  executor: Executor;
  driver: ReturnType<typeof createFakeDriver>;
  repoPath: string;
  projectId: string;
  /** Creates a queued run + step run (optionally on another project). */
  enqueue(task?: string, projectId?: string): { runId: string; stepRunId: string };
  /** Registers another project row pointing at the same repo. */
  addProject(name?: string): string;
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const makeRepo = (dir: string): string => {
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  git(repoPath, "add", "-A");
  git(repoPath, "-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init");
  return repoPath;
};

const created: Harness[] = [];

const setup = (
  fakeOpts: FakeDriverOptions = {},
  executorOpts: Partial<ExecutorOptions> = {},
): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-executor-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = makeRepo(dir);
  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: repoPath,
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  const worktrees = new WorktreeManager({ storeRoot: join(dir, "store") });
  const drivers = createDriverRegistry();
  const driver = createFakeDriver(fakeOpts);
  drivers.registerDriver(driver);
  const executor = createExecutor({
    db,
    worktrees,
    drivers,
    logger: createLogger("silent"),
    ...executorOpts,
  });

  const harness: Harness = {
    dir,
    db,
    worktrees,
    executor,
    driver,
    repoPath,
    projectId: project.id,
    enqueue(task = "make it green", projectId = project.id) {
      const runId = crypto.randomUUID();
      const stepRunId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.runs.create({
        id: runId,
        projectId,
        status: "queued",
        branch: `agentloop/${runId}`,
        iteration: 0,
        task,
        createdAt: now,
        updatedAt: now,
      });
      db.stepRuns.create({
        id: stepRunId,
        runId,
        stepId: "adhoc",
        iteration: 1,
        status: "queued",
        output: "",
      });
      return { runId, stepRunId };
    },
    addProject(name = "extra") {
      const extra = db.projects.create({
        id: crypto.randomUUID(),
        path: repoPath,
        name,
        defaultBranch: "main",
        createdAt: new Date().toISOString(),
      });
      return extra.id;
    },
  };
  created.push(harness);
  return harness;
};

afterEach(() => {
  while (created.length > 0) {
    const harness = created.pop() as Harness;
    harness.db.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

const waitForStatus = async (h: Harness, runId: string, status: RunStatus): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (h.db.runs.get(runId)?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${status}: currently ${h.db.runs.get(runId)?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const waitForIdle = async (h: Harness): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (h.executor.activeRunIds().length > 0) {
    if (Date.now() > deadline) throw new Error("executor never went idle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("createExecutor", () => {
  it("drives a run to success: worktree, events, session, diff, output", async () => {
    const h = setup({
      events: script,
      delayMs: 10,
      output: "all done",
      onStart: (opts) => {
        writeFileSync(join(opts.cwd, "feature.txt"), "new feature\n");
      },
    });
    const { runId, stepRunId } = h.enqueue();
    h.executor.startRun(runId, { mode: "auto" });

    await waitForStatus(h, runId, "success");
    await waitForIdle(h);

    const run = h.db.runs.get(runId);
    expect(run).toMatchObject({ status: "success", output: "all done" });

    const worktreePath = join(h.dir, "store", runId);
    expect(existsSync(worktreePath)).toBe(true);
    expect(h.driver.calls).toEqual([
      {
        cwd: worktreePath,
        prompt: "make it green",
        mode: "auto",
      },
    ]);

    const step = h.db.stepRuns.listByRun(runId)[0];
    expect(step).toMatchObject({
      id: stepRunId,
      status: "success",
      sessionId: "s_1",
      output: "all done",
    });
    expect(step?.diff).toContain("feature.txt");

    const events = h.db.events.getSince(runId);
    expect(events.map((event) => event.type)).toEqual([
      "run.status",
      "step.started",
      "started",
      "session",
      "message-delta",
      "done",
      "step.completed",
      "run.status",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("marks the run failed when the driver exits non-zero, storing the message", async () => {
    const h = setup({ events: script, exitCode: 7, output: "partial work" });
    const { runId } = h.enqueue();
    h.executor.startRun(runId);

    await waitForStatus(h, runId, "failed");
    await waitForIdle(h);

    expect(h.db.runs.get(runId)).toMatchObject({
      status: "failed",
      error: "agent exited with code 7",
      output: "partial work",
    });
    expect(h.db.stepRuns.listByRun(runId)[0]).toMatchObject({ status: "failed" });
  });

  it("fails the run when worktree creation fails (not a git repo)", async () => {
    const h = setup({ events: script });
    const plainDir = join(h.dir, "plain");
    mkdirSync(plainDir, { recursive: true });
    const plain = h.db.projects.create({
      id: crypto.randomUUID(),
      path: plainDir,
      name: "plain",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    h.db.runs.create({
      id: runId,
      projectId: plain.id,
      status: "queued",
      branch: `agentloop/${runId}`,
      iteration: 0,
      task: "x",
      createdAt: now,
      updatedAt: now,
    });
    h.executor.startRun(runId);

    await waitForStatus(h, runId, "failed");
    expect(h.db.runs.get(runId)?.error).toContain("not a git repository");
  });

  it("is a no-op for unknown run ids and never throws", async () => {
    const h = setup({ events: script });
    expect(() => h.executor.startRun(crypto.randomUUID())).not.toThrow();
    await h.executor.shutdown();
  });

  it("aborts a running run, keeps the worktree, and settles cleanly", async () => {
    const h = setup({
      events: [
        { type: "message-delta", seq: 1, delta: "a" },
        { type: "message-delta", seq: 2, delta: "b" },
        { type: "message-delta", seq: 3, delta: "c" },
        { type: "message-delta", seq: 4, delta: "d" },
      ],
      delayMs: 40,
    });
    const { runId } = h.enqueue();
    h.executor.startRun(runId);

    await waitForStatus(h, runId, "running");
    await expect(h.executor.abortRun(runId)).resolves.toEqual({ outcome: "aborted" });

    await waitForStatus(h, runId, "aborted");
    await waitForIdle(h);

    expect(existsSync(join(h.dir, "store", runId))).toBe(true);
    expect(h.db.stepRuns.listByRun(runId)[0]).toMatchObject({ status: "aborted" });
    // The scripted driver run was cut short: not all 5 events made it to the log.
    const driverEvents = h.db.events
      .getSince(runId)
      .filter((event) => event.type === "message-delta" || event.type === "started");
    expect(driverEvents.length).toBeLessThan(5);
    expect(h.db.events.lastRunStatus(runId)).toMatchObject({
      type: "run.status",
      status: "aborted",
    });
  });

  it("aborts a queued run that was never started", async () => {
    const h = setup({ events: script });
    const { runId } = h.enqueue();
    await expect(h.executor.abortRun(runId)).resolves.toEqual({ outcome: "aborted" });
    expect(h.db.runs.get(runId)?.status).toBe("aborted");
    expect(h.db.stepRuns.listByRun(runId)[0]).toMatchObject({ status: "aborted" });
  });

  it("reports not_found / not_abortable for aborts", async () => {
    const h = setup({ events: script });
    await expect(h.executor.abortRun(crypto.randomUUID())).resolves.toEqual({
      outcome: "not_found",
    });
    const { runId } = h.enqueue();
    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await expect(h.executor.abortRun(runId)).resolves.toEqual({
      outcome: "not_abortable",
      status: "success",
    });
  });

  it("shutdown aborts active runs and waits for them to settle", async () => {
    const h = setup({
      events: [
        { type: "message-delta", seq: 1, delta: "a" },
        { type: "message-delta", seq: 2, delta: "b" },
        { type: "message-delta", seq: 3, delta: "c" },
      ],
      delayMs: 60,
    });
    const { runId } = h.enqueue();
    h.executor.startRun(runId);
    await waitForStatus(h, runId, "running");

    await h.executor.shutdown();

    expect(h.db.runs.get(runId)?.status).toBe("aborted");
    expect(h.executor.activeRunIds()).toEqual([]);
  });

  it("ignores duplicate startRun calls for the same run", async () => {
    const h = setup({ events: script, delayMs: 10 });
    const { runId } = h.enqueue();
    h.executor.startRun(runId);
    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    expect(h.driver.calls).toHaveLength(1);
  });
});

const TERMINAL = new Set<RunStatus>(["success", "failed", "aborted", "interrupted"]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const statusOf = (h: Harness, runId: string): RunStatus | undefined => h.db.runs.get(runId)?.status;

const countWithStatus = (h: Harness, runIds: string[], status: RunStatus): number =>
  runIds.filter((runId) => statusOf(h, runId) === status).length;

/** Samples statuses until every run is terminal; returns the sample log. */
async function runToCompletion(
  h: Harness,
  runIds: string[],
  timeoutMs = 10_000,
): Promise<RunStatus[][]> {
  const samples: RunStatus[][] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = runIds.map((runId) => statusOf(h, runId) ?? "aborted");
    samples.push(current);
    if (current.every((status) => TERMINAL.has(status))) return samples;
    if (Date.now() > deadline) {
      throw new Error(`runs never completed; last statuses ${JSON.stringify(current)}`);
    }
    await sleep(5);
  }
}

/** Resolves once pred holds; throws on timeout. */
async function waitUntil(pred: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`condition never met: ${what}`);
    await sleep(5);
  }
}

describe("createExecutor concurrency scheduling", () => {
  it("caps concurrent execution at maxConcurrentRuns (5 runs, cap 2), all complete, isolated worktrees", async () => {
    const deltas: AgentEvent[] = Array.from({ length: 6 }, (_, i) => ({
      type: "message-delta",
      seq: i + 1,
      delta: "chunk ",
    }));
    const h = setup(
      {
        events: deltas,
        delayMs: 25,
        onStart: (opts) => {
          writeFileSync(join(opts.cwd, "who.txt"), `${opts.prompt}\n`);
        },
      },
      { maxConcurrentRuns: 2 },
    );
    expect(h.executor.maxConcurrentRuns).toBe(2);
    const projects = [
      h.projectId,
      h.addProject("p2"),
      h.addProject("p3"),
      h.addProject("p4"),
      h.addProject("p5"),
    ];
    const tasks = projects.map((projectId, index) => h.enqueue(`task-${index}`, projectId));
    tasks.forEach(({ runId }) => h.executor.startRun(runId));

    const samples = await runToCompletion(
      h,
      tasks.map(({ runId }) => runId),
    );

    const maxInFlight = Math.max(
      ...samples.map((sample) => sample.filter((s) => s === "running").length),
    );
    const maxQueued = Math.max(
      ...samples.map((sample) => sample.filter((s) => s === "queued").length),
    );
    expect(maxInFlight).toBe(2);
    expect(maxQueued).toBeGreaterThanOrEqual(3);
    expect(samples.at(-1)).toEqual(["success", "success", "success", "success", "success"]);
    expect(h.driver.calls).toHaveLength(5);

    // Worktree isolation: every run executed in its own worktree (per runId)
    // and only saw its own task's file — no shared mutable state between runs.
    for (const [index, { runId }] of tasks.entries()) {
      const worktreePath = join(h.dir, "store", runId);
      expect(existsSync(worktreePath)).toBe(true);
      expect(readFileSync(join(worktreePath, "who.txt"), "utf8")).toBe(`task-${index}\n`);
    }
  });

  it("serializes runs on the same project: the second stays queued until the first is terminal", async () => {
    const deltas: AgentEvent[] = Array.from({ length: 5 }, (_, i) => ({
      type: "message-delta",
      seq: i + 1,
      delta: "tick ",
    }));
    // Cap 2 on purpose: the project gate (not the semaphore) must serialize.
    const h = setup({ events: deltas, delayMs: 40 }, { maxConcurrentRuns: 2 });
    const first = h.enqueue("first");
    const second = h.enqueue("second");
    h.executor.startRun(first.runId);
    h.executor.startRun(second.runId);

    await waitUntil(
      () => statusOf(h, first.runId) === "running" && statusOf(h, second.runId) === "queued",
      "first running while second queued",
    );

    const samples = await runToCompletion(h, [first.runId, second.runId]);
    expect(samples.at(-1)).toEqual(["success", "success"]);
    expect(Math.max(...samples.map((s) => s.filter((x) => x === "running").length))).toBe(1);
    // The second run only ever ran after the first was terminal.
    for (const [firstStatus, secondStatus] of samples) {
      if (secondStatus === "running") expect(TERMINAL.has(firstStatus ?? "aborted")).toBe(true);
    }
    expect(h.driver.calls.map((call) => call.prompt)).toEqual(["first", "second"]);
  });

  it("runs different projects in parallel up to the cap", async () => {
    const deltas: AgentEvent[] = Array.from({ length: 6 }, (_, i) => ({
      type: "message-delta",
      seq: i + 1,
      delta: "tick ",
    }));
    const h = setup({ events: deltas, delayMs: 40 }, { maxConcurrentRuns: 2 });
    const a = h.enqueue("a", h.projectId);
    const b = h.enqueue("b", h.addProject());
    h.executor.startRun(a.runId);
    h.executor.startRun(b.runId);

    await waitUntil(
      () => statusOf(h, a.runId) === "running" && statusOf(h, b.runId) === "running",
      "both projects running simultaneously",
    );

    await runToCompletion(h, [a.runId, b.runId]);
    expect(statusOf(h, a.runId)).toBe("success");
    expect(statusOf(h, b.runId)).toBe("success");
  });

  it("aborting a running run frees the global slot for the next queued run", async () => {
    const deltas: AgentEvent[] = Array.from({ length: 12 }, (_, i) => ({
      type: "message-delta",
      seq: i + 1,
      delta: "tick ",
    }));
    const h = setup({ events: deltas, delayMs: 60 }, { maxConcurrentRuns: 1 });
    const long = h.enqueue("long", h.projectId);
    const next = h.enqueue("next", h.addProject());
    h.executor.startRun(long.runId);
    h.executor.startRun(next.runId);

    await waitUntil(
      () =>
        statusOf(h, long.runId) === "running" &&
        statusOf(h, next.runId) === "queued" &&
        h.driver.calls.some((call) => call.prompt === "long"),
      "long running (driver started) while next queued",
    );
    expect(countWithStatus(h, [long.runId, next.runId], "running")).toBe(1);

    await expect(h.executor.abortRun(long.runId)).resolves.toEqual({ outcome: "aborted" });
    await waitForStatus(h, long.runId, "aborted");

    // The freed slot admits the queued run; it drives to success.
    await waitForStatus(h, next.runId, "running");
    await waitForStatus(h, next.runId, "success");
    await waitForIdle(h);
    expect(h.driver.calls.map((call) => call.prompt)).toEqual(["long", "next"]);
  });

  it("aborts a scheduler-queued run without starting it and keeps the queue moving", async () => {
    const deltas: AgentEvent[] = Array.from({ length: 12 }, (_, i) => ({
      type: "message-delta",
      seq: i + 1,
      delta: "tick ",
    }));
    const h = setup({ events: deltas, delayMs: 60 }, { maxConcurrentRuns: 1 });
    const long = h.enqueue("long", h.projectId);
    const otherProject = h.addProject();
    const keep = h.enqueue("keep", otherProject);
    const drop = h.enqueue("drop", otherProject);
    h.executor.startRun(long.runId);
    h.executor.startRun(keep.runId);
    h.executor.startRun(drop.runId);

    await waitUntil(
      () =>
        statusOf(h, long.runId) === "running" &&
        statusOf(h, keep.runId) === "queued" &&
        statusOf(h, drop.runId) === "queued" &&
        h.driver.calls.some((call) => call.prompt === "long"),
      "one running (driver started), two queued",
    );

    await expect(h.executor.abortRun(drop.runId)).resolves.toEqual({ outcome: "aborted" });
    expect(statusOf(h, drop.runId)).toBe("aborted");
    expect(h.db.stepRuns.listByRun(drop.runId)[0]).toMatchObject({ status: "aborted" });

    // The aborted run never starts; the surviving queued run still gets its turn.
    await expect(h.executor.abortRun(long.runId)).resolves.toEqual({ outcome: "aborted" });
    await waitForStatus(h, keep.runId, "success");
    await waitForIdle(h);
    expect(h.driver.calls.map((call) => call.prompt)).toEqual(["long", "keep"]);
  });

  it("shutdown settles scheduler-queued runs as aborted without starting them", async () => {
    const deltas: AgentEvent[] = Array.from({ length: 12 }, (_, i) => ({
      type: "message-delta",
      seq: i + 1,
      delta: "tick ",
    }));
    const h = setup({ events: deltas, delayMs: 60 }, { maxConcurrentRuns: 1 });
    const long = h.enqueue("long", h.projectId);
    const queued = h.enqueue("queued", h.addProject());
    h.executor.startRun(long.runId);
    h.executor.startRun(queued.runId);
    await waitForStatus(h, long.runId, "running");
    await waitUntil(
      () =>
        statusOf(h, queued.runId) === "queued" &&
        h.driver.calls.some((call) => call.prompt === "long"),
      "second run queued, first driver started",
    );

    await h.executor.shutdown();

    expect(statusOf(h, long.runId)).toBe("aborted");
    expect(statusOf(h, queued.runId)).toBe("aborted");
    expect(h.executor.activeRunIds()).toEqual([]);
    expect(h.driver.calls.map((call) => call.prompt)).toEqual(["long"]);
  });
});
