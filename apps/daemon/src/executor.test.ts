import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { Executor } from "./executor.js";
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
  /** Creates a queued run + step run and returns their ids. */
  enqueue(task?: string): { runId: string; stepRunId: string };
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

const setup = (fakeOpts: FakeDriverOptions = {}): Harness => {
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
  const executor = createExecutor({ db, worktrees, drivers, logger: createLogger("silent") });

  const harness: Harness = {
    dir,
    db,
    worktrees,
    executor,
    driver,
    repoPath,
    projectId: project.id,
    enqueue(task = "make it green") {
      const runId = crypto.randomUUID();
      const stepRunId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.runs.create({
        id: runId,
        projectId: project.id,
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
      "started",
      "session",
      "message-delta",
      "done",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
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
    expect(h.db.events.count(runId)).toBeLessThan(5);
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
