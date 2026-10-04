import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Run, Step, Workflow } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import type { Executor } from "./executor.js";
import { createExecutor } from "./executor.js";
import { createLogger } from "./logger.js";
import {
  DEFAULT_SCHEDULE_TICK_MS,
  dueSlotMs,
  runScheduleTick,
  startScheduleTicker,
  type ScheduleTickerDeps,
} from "./scheduler.js";

/**
 * Schedule ticker (#121) with a fake clock: fires on the correct minute,
 * skips (with an ops event) while the workflow has an active run,
 * coalesces missed ticks into one run, honors the schedule timezone
 * (half-hour offset + DST gap) and never fires paused schedules.
 */

interface Harness {
  dir: string;
  db: Db;
  executor: Executor;
  workflow: Workflow;
  /** Fake clock state (ms). */
  clock: { now: number };
  tick: () => ReturnType<typeof runScheduleTick>;
  /** Creates the workflow's schedule with a pinned createdAt baseline. */
  schedule: (config: {
    cron: string;
    timezone?: string;
    enabled?: boolean;
    createdAt?: string;
    taskTemplate?: string;
  }) => void;
}

const created: { db: Db; dir: string }[] = [];

const setup = (options: { createdAt?: string } = {}): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-sched-"));
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
  const makeWorkflow = (name: string): Workflow =>
    db.workflows.create({
      id: crypto.randomUUID(),
      projectId: project.id,
      name,
      steps,
    });
  const workflow = makeWorkflow("sched");

  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver({}));
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot: join(dir, "store") }),
    drivers,
    logger: createLogger("silent"),
  });

  const clock = { now: Date.parse(options.createdAt ?? "2026-01-01T00:00:00Z") };
  const deps: ScheduleTickerDeps = {
    db,
    executor,
    logger: createLogger("silent"),
    secretsKey: Buffer.alloc(32, 7),
    now: () => clock.now,
  };

  created.push({ db, dir });
  return {
    dir,
    db,
    executor,
    workflow,
    clock,
    tick: () => runScheduleTick(deps),
    schedule: (config) => {
      const row = db.workflowSchedules.upsertByWorkflow(workflow.id, {
        enabled: config.enabled ?? true,
        cron: config.cron,
        taskTemplate: config.taskTemplate ?? "scheduled task",
        timezone: config.timezone ?? "UTC",
      });
      // Pin the baseline: the upsert stamps real now(), tests want the
      // fake-clock baseline (the missed-tick cursor starts at createdAt).
      db.sqlite
        .prepare("update workflow_schedules set created_at = $createdAt where id = $id")
        .run({ createdAt: config.createdAt ?? "2026-01-01T00:00:00Z", id: row.id });
    },
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

const runsOf = (h: Harness): Run[] => h.db.runs.listByWorkflow(h.workflow.id);

/** Waits until no run of the workflow is queued/running (fake driver settles fast). */
const waitForQuiet = async (h: Harness): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (runsOf(h).some((run) => run.status === "queued" || run.status === "running")) {
    if (Date.now() > deadline) throw new Error("scheduled run never settled");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A run row stuck in `queued`/`running` (no executor involvement). */
const seedActiveRun = (h: Harness, status: "queued" | "running"): Run => {
  const run: Run = {
    id: crypto.randomUUID(),
    projectId: h.workflow.projectId,
    workflowId: h.workflow.id,
    status,
    branch: "agentloop/seed",
    iteration: 0,
    task: "seed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  h.db.runs.create(run);
  return run;
};

describe("schedule ticker (fake clock)", () => {
  it("fires exactly on the scheduled minute, not a second early", () => {
    const h = setup();
    h.schedule({ cron: "30 9 * * *", createdAt: "2026-01-01T09:00:00Z" });

    h.clock.now = Date.parse("2026-01-01T09:29:59Z");
    expect(h.tick()).toEqual({ fired: 0, skipped: 0, idle: 1 });

    h.clock.now = Date.parse("2026-01-01T09:30:00Z");
    expect(h.tick()).toEqual({ fired: 1, skipped: 0, idle: 0 });
    const runs = runsOf(h);
    expect(runs).toHaveLength(1);
    expect(h.db.workflowSchedules.getByWorkflow(h.workflow.id)?.lastFiredAt).toBe(
      "2026-01-01T09:30:00.000Z",
    );

    // The handled minute never re-fires.
    expect(h.tick()).toEqual({ fired: 0, skipped: 0, idle: 1 });
    expect(runsOf(h)).toHaveLength(1);
  });

  it("uses the task template as the run task", () => {
    const h = setup();
    h.schedule({
      cron: "30 9 * * *",
      createdAt: "2026-01-01T09:00:00Z",
      taskTemplate: "nightly regression sweep",
    });
    h.clock.now = Date.parse("2026-01-01T09:30:00Z");
    h.tick();
    expect(runsOf(h)[0]?.task).toBe("nightly regression sweep");
  });

  it("skips the slot (ops event, no run) while a previous run is active, then resumes", () => {
    const h = setup();
    h.schedule({ cron: "0 * * * *", createdAt: "2026-01-01T09:00:00Z" });
    const active = seedActiveRun(h, "running");

    h.clock.now = Date.parse("2026-01-01T10:00:00Z");
    expect(h.tick()).toEqual({ fired: 0, skipped: 1, idle: 0 });
    expect(runsOf(h)).toHaveLength(1); // only the seed

    const skipped = h.db.activity.list().find((row) => row.type === "ops.schedule-skipped");
    expect(skipped?.workflowId).toBe(h.workflow.id);
    expect(skipped?.payload?.["minute"]).toBe("2026-01-01T10:00:00.000Z");
    expect(skipped?.payload?.["activeRunId"]).toBe(active.id);
    expect(h.db.workflowSchedules.getByWorkflow(h.workflow.id)?.lastFiredAt).toBe(
      "2026-01-01T10:00:00.000Z",
    );

    // Still active at the next slot → skipped again; after it clears → fires.
    h.clock.now = Date.parse("2026-01-01T11:00:00Z");
    expect(h.tick()).toEqual({ fired: 0, skipped: 1, idle: 0 });
    h.db.runs.updateStatus(active.id, "success");
    h.clock.now = Date.parse("2026-01-01T12:00:00Z");
    expect(h.tick()).toEqual({ fired: 1, skipped: 0, idle: 0 });
    expect(runsOf(h)).toHaveLength(2);
  });

  it("treats a queued run as active too", () => {
    const h = setup();
    h.schedule({ cron: "0 * * * *", createdAt: "2026-01-01T09:00:00Z" });
    seedActiveRun(h, "queued");
    h.clock.now = Date.parse("2026-01-01T10:00:00Z");
    expect(h.tick()).toEqual({ fired: 0, skipped: 1, idle: 0 });
  });

  it("coalesces missed ticks into ONE run for the newest missed slot", () => {
    const h = setup();
    h.schedule({ cron: "0 * * * *", createdAt: "2026-01-01T09:00:00Z" });
    // Daemon "down" for three slots; the first tick afterwards sees them all.
    h.clock.now = Date.parse("2026-01-01T13:20:00Z");
    expect(h.tick()).toEqual({ fired: 1, skipped: 0, idle: 0 });
    expect(runsOf(h)).toHaveLength(1);
    expect(h.db.workflowSchedules.getByWorkflow(h.workflow.id)?.lastFiredAt).toBe(
      "2026-01-01T13:00:00.000Z",
    );
  });

  it("never backfills before the schedule's creation", () => {
    const h = setup();
    // Created AFTER today's 09:30 slot, ticked after it: first fire is tomorrow.
    h.schedule({ cron: "30 9 * * *", createdAt: "2026-01-01T09:31:00Z" });
    h.clock.now = Date.parse("2026-01-01T10:00:00Z");
    expect(h.tick()).toEqual({ fired: 0, skipped: 0, idle: 1 });
    h.clock.now = Date.parse("2026-01-02T09:30:00Z");
    expect(h.tick()).toEqual({ fired: 1, skipped: 0, idle: 0 });
  });

  it("respects the schedule timezone (half-hour offset, Asia/Kolkata)", () => {
    const h = setup();
    h.schedule({ cron: "30 9 * * *", timezone: "Asia/Kolkata", createdAt: "2026-06-01T00:00:00Z" });
    // 09:30 IST == 04:00 UTC. One minute before → idle; at → fire.
    h.clock.now = Date.parse("2026-06-01T03:59:00Z");
    expect(h.tick()).toEqual({ fired: 0, skipped: 0, idle: 1 });
    h.clock.now = Date.parse("2026-06-01T04:00:00Z");
    expect(h.tick()).toEqual({ fired: 1, skipped: 0, idle: 0 });
    expect(h.db.workflowSchedules.getByWorkflow(h.workflow.id)?.lastFiredAt).toBe(
      "2026-06-01T04:00:00.000Z",
    );
  });

  it("skips the DST-gap wall time (America/New_York spring forward)", async () => {
    const h = setup();
    h.schedule({
      cron: "30 2 * * *",
      timezone: "America/New_York",
      createdAt: "2026-03-07T00:00:00Z",
    });
    // Mar 7 02:30 EST exists → fires.
    h.clock.now = Date.parse("2026-03-07T12:00:00Z");
    expect(h.tick()).toEqual({ fired: 1, skipped: 0, idle: 0 });
    expect(h.db.workflowSchedules.getByWorkflow(h.workflow.id)?.lastFiredAt).toBe(
      "2026-03-07T07:30:00.000Z",
    );
    // The fired run executes for real (fake driver) — let it settle so the
    // next tick is not legitimately skipped as "still active".
    await waitForQuiet(h);
    // All of Mar 8 UTC-day: the only 02:30 wall slot (Mar 8) is inside the
    // gap → nothing fires until Mar 9 02:30 EDT (06:30Z).
    h.clock.now = Date.parse("2026-03-08T23:59:00Z");
    expect(h.tick()).toEqual({ fired: 0, skipped: 0, idle: 1 });
    h.clock.now = Date.parse("2026-03-09T07:00:00Z");
    expect(h.tick()).toEqual({ fired: 1, skipped: 0, idle: 0 });
    expect(h.db.workflowSchedules.getByWorkflow(h.workflow.id)?.lastFiredAt).toBe(
      "2026-03-09T06:30:00.000Z",
    );
  });

  it("never fires a paused schedule; a deleted schedule stops firing", () => {
    const h = setup();
    h.schedule({ cron: "0 * * * *", enabled: false, createdAt: "2026-01-01T09:00:00Z" });
    h.clock.now = Date.parse("2026-01-01T10:00:00Z");
    expect(h.tick()).toEqual({ fired: 0, skipped: 0, idle: 0 });

    const row = h.db.workflowSchedules.getByWorkflow(h.workflow.id);
    expect(row).toBeDefined();
    if (row) h.db.workflowSchedules.delete(row.id);
    expect(h.tick()).toEqual({ fired: 0, skipped: 0, idle: 0 });
  });

  it("resumes from now, not from a slot that elapsed while paused", async () => {
    const h = setup();
    h.schedule({ cron: "0 * * * *", createdAt: "2026-01-01T09:00:00Z" });
    h.clock.now = Date.parse("2026-01-01T10:00:00Z");
    expect(h.tick()).toEqual({ fired: 1, skipped: 0, idle: 0 });
    await waitForQuiet(h);

    const row = h.db.workflowSchedules.getByWorkflow(h.workflow.id);
    expect(row).toBeDefined();
    if (row) {
      h.db.workflowSchedules.update(row.id, { enabled: false });
    }
    h.clock.now = Date.parse("2026-01-01T12:20:00Z");
    expect(h.tick()).toEqual({ fired: 0, skipped: 0, idle: 0 });

    if (row) h.db.workflowSchedules.update(row.id, { enabled: true });
    // Model the repo's resume-time cursor reset on the fake clock explicitly
    // (the repo-level test covers the real upsert timestamp).
    const resumed = h.db.workflowSchedules.getByWorkflow(h.workflow.id);
    if (resumed) {
      h.db.workflowSchedules.update(resumed.id, {
        lastFiredAt: "2026-01-01T12:20:00.000Z",
      });
    }
    expect(h.tick()).toEqual({ fired: 0, skipped: 0, idle: 1 });
    h.clock.now = Date.parse("2026-01-01T13:00:00Z");
    expect(h.tick()).toEqual({ fired: 1, skipped: 0, idle: 0 });
  });

  it("one broken schedule row (hand-edited cron) never breaks the tick", () => {
    const h = setup();
    h.schedule({ cron: "0 * * * *", createdAt: "2026-01-01T09:00:00Z" });
    // A second workflow with a garbage cron in its schedule row (only
    // possible by hand-editing the db): it is ignored as idle.
    const other = h.db.workflows.create({
      id: crypto.randomUUID(),
      projectId: h.workflow.projectId,
      name: "broken",
      steps: [
        {
          id: "worker",
          name: "Worker",
          driver: "fake",
          mode: "auto",
          promptTemplate: "{{task}}",
          continueSession: false,
        },
      ],
    });
    h.db.sqlite
      .prepare(
        `insert into workflow_schedules (id, workflow_id, enabled, cron, task_template, timezone, created_at, updated_at)
         values ($id, $workflow, 1, 'not cron', 't', 'UTC', $createdAt, $createdAt)`,
      )
      .run({ id: "bad", workflow: other.id, createdAt: "2026-01-01T00:00:00Z" });

    h.clock.now = Date.parse("2026-01-01T10:00:00Z");
    expect(h.tick()).toEqual({ fired: 1, skipped: 0, idle: 1 });
  });

  it("dueSlotMs walks to the newest slot and stops at now", () => {
    expect(
      dueSlotMs(
        { cron: "0 * * * *", timezone: "UTC", createdAt: "2026-01-01T09:00:00Z" },
        Date.parse("2026-01-01T13:20:00Z"),
      ),
    ).toBe(Date.parse("2026-01-01T13:00:00Z"));
    expect(
      dueSlotMs(
        { cron: "0 * * * *", timezone: "UTC", createdAt: "2026-01-01T09:00:00Z" },
        Date.parse("2026-01-01T09:59:00Z"),
      ),
    ).toBeUndefined();
    expect(
      dueSlotMs(
        { cron: "0 * * * *", timezone: "Mars/Olympus", createdAt: "2026-01-01T09:00:00Z" },
        Date.parse("2026-01-01T10:00:00Z"),
      ),
    ).toBeUndefined();
  });
});

describe("schedule ticker service (#121)", () => {
  it("ticks on its interval (unref'd) and stop() halts it", async () => {
    const h = setup();
    h.schedule({ cron: "* * * * *", createdAt: "2026-01-01T00:00:00Z" });
    // Real timer, fake clock: the interval callback fires regardless of the
    // clock value, so advance the clock past one every-minute slot and wait
    // for the DB effect (a scheduled run appearing) — then confirm stop().
    h.clock.now = Date.parse("2026-01-01T00:01:00Z");
    const ticker = startScheduleTicker({
      db: h.db,
      executor: h.executor,
      logger: createLogger("silent"),
      secretsKey: Buffer.alloc(32, 7),
      now: () => h.clock.now,
      intervalMs: 10,
    });
    try {
      const deadline = Date.now() + 2_000;
      while (runsOf(h).length === 0) {
        if (Date.now() > deadline) throw new Error("ticker never fired the schedule");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(h.db.workflowSchedules.getByWorkflow(h.workflow.id)?.lastFiredAt).toBeDefined();
    } finally {
      ticker.stop();
    }
    // Stopped: no more runs appear even after several intervals.
    const settled = runsOf(h).length;
    h.clock.now = Date.parse("2026-01-01T00:05:00Z");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(runsOf(h).length).toBe(settled);
    expect(DEFAULT_SCHEDULE_TICK_MS).toBe(60_000);
  });
});
