import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import type { FakeDriverOptions } from "@openeuler/drivers";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createExecutor } from "./executor.js";
import type { Executor, ExecutorOptions } from "./executor.js";
import { createLogger } from "./logger.js";
import { sweepInterruptedRuns } from "./recovery.js";
import { encryptSecretValue } from "./secrets-crypto.js";

interface Harness {
  dir: string;
  db: Db;
  worktrees: WorktreeManager;
  executor: Executor;
  storeRoot: string;
  projectId: string;
  /** Seeds a run row in the given status plus an optional step run. */
  seedRun(
    status: RunStatus,
    step?: { status: RunStatus; sessionId?: string },
    task?: string,
  ): string;
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const created: Harness[] = [];

const setup = (
  fakeOpts: FakeDriverOptions = {},
  executorOpts: Partial<ExecutorOptions> = {},
): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-recovery-"));
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
  const worktrees = new WorktreeManager({ storeRoot });
  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver(fakeOpts));
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
    storeRoot,
    projectId: project.id,
    seedRun(status, step, task = "seeded") {
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.runs.create({
        id: runId,
        projectId: project.id,
        status,
        branch: `agentloop/${runId}`,
        iteration: 0,
        task,
        createdAt: now,
        updatedAt: now,
      });
      if (step !== undefined) {
        db.stepRuns.create({
          id: crypto.randomUUID(),
          runId,
          stepId: "adhoc",
          iteration: 1,
          ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId }),
          status: step.status,
          output: "",
        });
      }
      return runId;
    },
  };
  created.push(harness);
  return harness;
};

const afterEachClean = (): void => {
  while (created.length > 0) {
    const harness = created.pop() as Harness;
    harness.db.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
};

afterEach(afterEachClean);

const waitForStatus = async (h: Harness, runId: string, status: RunStatus): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (h.db.runs.get(runId)?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${status}; currently ${h.db.runs.get(runId)?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("sweepInterruptedRuns (boot sweep)", () => {
  it("marks zombie running/queued runs interrupted, settles step runs, persists run.status events", async () => {
    const h = setup();
    // What a SIGKILLed daemon leaves behind: a run mid-flight (live step run
    // plus an already-successful earlier step), a scheduler-queued run, and a
    // finished run that must not be touched.
    const running = h.seedRun("running", { status: "running", sessionId: "s-1" });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: running,
      stepId: "early",
      iteration: 1,
      status: "success",
      output: "done",
    });
    const queued = h.seedRun("queued", { status: "queued" });
    const finished = h.seedRun("success", { status: "success", sessionId: "s-2" });

    const result = await sweepInterruptedRuns({
      db: h.db,
      worktrees: h.worktrees,
      executor: h.executor,
      logger: createLogger("silent"),
    });

    expect(new Set(result.interruptedRunIds)).toEqual(new Set([running, queued]));
    expect(result.orphanedWorktrees).toEqual([]);

    for (const runId of [running, queued]) {
      expect(h.db.runs.get(runId)?.status).toBe("interrupted");
      expect(h.db.events.lastRunStatus(runId)).toMatchObject({
        type: "run.status",
        status: "interrupted",
      });
    }
    // Non-terminal step runs settle to interrupted; terminal ones stay.
    const steps = h.db.stepRuns.listByRun(running);
    expect(steps).toHaveLength(2);
    expect(steps.find((step) => step.stepId === "adhoc")).toMatchObject({
      status: "interrupted",
      sessionId: "s-1",
    });
    expect(steps.find((step) => step.stepId === "early")).toMatchObject({ status: "success" });
    expect(h.db.stepRuns.listByRun(queued)[0]).toMatchObject({ status: "interrupted" });

    // Finished runs are untouched (no events, same status).
    expect(h.db.runs.get(finished)?.status).toBe("success");
    expect(h.db.events.count(finished)).toBe(0);

    // No zombie running/queued rows remain.
    expect(h.db.runs.list(undefined, "running")).toEqual([]);
    expect(h.db.runs.list(undefined, "queued")).toEqual([]);
  });

  it("is idempotent and skips runs still live in this executor", async () => {
    const h = setup({
      events: [
        { type: "session", seq: 1, sessionId: "s-1" },
        { type: "message-delta", seq: 2, delta: "working" },
      ],
      delayMs: 40,
    });
    const swept = h.seedRun("queued");
    const live = h.seedRun("queued", undefined);
    h.executor.startRun(live);
    await waitForStatus(h, live, "running");

    const sweep = {
      db: h.db,
      worktrees: h.worktrees,
      executor: h.executor,
      logger: createLogger("silent"),
    };
    await sweepInterruptedRuns(sweep);

    expect(h.db.runs.get(swept)?.status).toBe("interrupted");
    expect(h.db.runs.get(live)?.status).toBe("running");

    // Second sweep: nothing left to do.
    const again = await sweepInterruptedRuns(sweep);
    expect(again.interruptedRunIds).toEqual([]);

    await h.executor.shutdown();
    expect(h.db.runs.get(live)?.status).toBe("aborted");
  });

  it("reports orphaned worktrees without removing them (report-only)", async () => {
    const h = setup();
    // A stale directory under the store with no run metadata...
    const stale = join(h.storeRoot, "deadbeef");
    mkdirSync(stale, { recursive: true });
    // ...and a metadata-backed worktree whose run was swept mid-flight.
    const interrupted = h.seedRun("running");
    await h.worktrees.create(interrupted, {
      id: h.projectId,
      path: join(h.dir, "repo"),
      name: "repo",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    h.db.runs.updateStatus(interrupted, "interrupted");

    const result = await sweepInterruptedRuns({
      db: h.db,
      worktrees: h.worktrees,
      executor: h.executor,
      logger: createLogger("silent"),
    });

    expect(result.orphanedWorktrees).toEqual([stale]);
    // Report-only: the orphan is still on disk, and the live run's worktree
    // (now interrupted, awaiting resume) is neither reported nor removed.
    expect(existsSync(stale)).toBe(true);
    expect(result.orphanedWorktrees).not.toContain(join(h.storeRoot, interrupted));
    expect(existsSync(join(h.storeRoot, interrupted))).toBe(true);
  });

  it("redacts secret values from the sweep's activity payload (#93)", async () => {
    const secretName = "DEPLOY_KEY";
    const secretValue = "sk_live_sweep_778899";
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    const h = setup({}, { secretsKey: key });
    h.db.projectSecrets.set(h.projectId, secretName, encryptSecretValue(key, secretValue));
    // A run interrupted by the crash still carrying a raw task (e.g. a row
    // written before task redaction-at-rest existed).
    const interrupted = h.seedRun(
      "running",
      { status: "running", sessionId: "s-1" },
      `deploy with ${secretValue}`,
    );

    const result = await sweepInterruptedRuns({
      db: h.db,
      worktrees: h.worktrees,
      executor: h.executor,
      logger: createLogger("silent"),
      secretsKey: key,
    });

    expect(result.interruptedRunIds).toEqual([interrupted]);
    const entry = h.db.activity.list({ limit: 10 }).find((row) => row.runId === interrupted);
    expect(entry).toBeDefined();
    const payloadJson = JSON.stringify(entry?.payload ?? {});
    expect(payloadJson).toContain(`***${secretName}***`);
    expect(payloadJson).not.toContain(secretValue);
  });

  it("sweeps without a secrets key exactly as before (no redactor configured)", async () => {
    const h = setup();
    const interrupted = h.seedRun("queued", undefined, "plain seeded task");

    const result = await sweepInterruptedRuns({
      db: h.db,
      worktrees: h.worktrees,
      executor: h.executor,
      logger: createLogger("silent"),
    });

    expect(result.interruptedRunIds).toEqual([interrupted]);
    const entry = h.db.activity.list({ limit: 10 }).find((row) => row.runId === interrupted);
    expect(JSON.stringify(entry?.payload ?? {})).toContain("plain seeded task");
  });
});
