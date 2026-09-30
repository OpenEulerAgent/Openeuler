import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run, RunStatus, Workflow } from "@openeuler/core";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import type { FakeDriver } from "@openeuler/drivers";
import { createFlowEngine } from "./flow-engine.js";
import type { FlowEngine } from "./flow-engine.js";
import { WorktreeManager } from "./worktree.js";

interface Harness {
  dir: string;
  db: Db;
  engine: FlowEngine;
  storeRoot: string;
  projectId: string;
  drivers: { impl: FakeDriver; rev: FakeDriver; ship: FakeDriver; boom: FakeDriver };
  makeWorkflow(steps: Workflow["steps"]): Workflow;
  enqueueRun(workflowId?: string, task?: string): Run;
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const created: Harness[] = [];

const setup = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-flow-"));
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

  const impl = createFakeDriver({
    id: "impl",
    events: [
      { type: "session", seq: 1, sessionId: "s-impl" },
      { type: "message-delta", seq: 2, delta: "implementing" },
    ],
    output: "IMPL-OUT",
  });
  const rev = createFakeDriver({
    id: "rev",
    events: [{ type: "session", seq: 1, sessionId: "s-rev" }],
    output: "REV-OUT",
  });
  const ship = createFakeDriver({
    id: "ship",
    events: [{ type: "session", seq: 1, sessionId: "s-ship" }],
    output: "SHIP-OUT",
  });
  const boom = createFakeDriver({
    id: "boom",
    events: [{ type: "session", seq: 1, sessionId: "s-boom" }],
    output: "PARTIAL",
    exitCode: 7,
  });

  const drivers = createDriverRegistry();
  for (const driver of [impl, rev, ship, boom]) drivers.registerDriver(driver);

  const storeRoot = join(dir, "store");
  const engine = createFlowEngine({ db, worktrees: new WorktreeManager({ storeRoot }), drivers });

  const harness: Harness = {
    dir,
    db,
    engine,
    storeRoot,
    projectId: project.id,
    drivers: { impl, rev, ship, boom },
    makeWorkflow(steps) {
      return db.workflows.create({
        id: crypto.randomUUID(),
        projectId: project.id,
        name: "flow",
        steps,
      });
    },
    enqueueRun(workflowId, task = "fix the docs") {
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      return db.runs.create({
        id: runId,
        projectId: project.id,
        ...(workflowId === undefined ? {} : { workflowId }),
        status: "queued",
        branch: `agentloop/${runId}`,
        iteration: 0,
        task,
        createdAt: now,
        updatedAt: now,
      });
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

const noAbort = {
  isAbortRequested: (): boolean => false,
  onHandle: undefined,
};

const awaitStatus = async (h: Harness, runId: string, status: RunStatus): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (h.db.runs.get(runId)?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${status}; currently ${h.db.runs.get(runId)?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("createFlowEngine (workflow runs)", () => {
  it("chains outputs and sessions across steps with rendered prompts", async () => {
    const h = setup();
    const workflow = h.makeWorkflow([
      {
        id: "s1",
        name: "implement",
        driver: "impl",
        mode: "auto",
        promptTemplate: "Task: {{task}}",
        continueSession: false,
      },
      {
        id: "s2",
        name: "review",
        driver: "rev",
        mode: "auto",
        promptTemplate: "Prev: {{prevOutput}} (task {{task}}, pass {{iterations}})",
        continueSession: false,
      },
      {
        id: "s3",
        name: "ship",
        driver: "ship",
        mode: "auto",
        promptTemplate: "Ship: {{prevOutput}}",
        continueSession: true,
      },
    ]);
    const run = h.enqueueRun(workflow.id);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // Prompt templating: task, prevOutput and 1-based iterations all flow.
    expect(h.drivers.impl.calls[0]?.prompt).toBe("Task: fix the docs");
    expect(h.drivers.rev.calls[0]?.prompt).toBe("Prev: IMPL-OUT (task fix the docs, pass 1)");
    expect(h.drivers.ship.calls[0]?.prompt).toBe("Ship: REV-OUT");

    // All steps shared the run worktree.
    const worktreePath = join(h.storeRoot, run.id);
    for (const driver of [h.drivers.impl, h.drivers.rev, h.drivers.ship]) {
      expect(driver.calls[0]?.cwd).toBe(worktreePath);
    }

    // Session continuation: step 3 continues step 2's session, not step 1's.
    expect(h.drivers.impl.calls[0]?.sessionId).toBeUndefined();
    expect(h.drivers.rev.calls[0]?.sessionId).toBeUndefined();
    expect(h.drivers.ship.calls[0]?.sessionId).toBe("s-rev");

    // StepRun rows: 1-based iteration, session bound, output and final status.
    // (listByRun orders by iteration then row id, so key by stepId.)
    const byStep = new Map(
      h.db.stepRuns.listByRun(run.id).map((stepRun) => [stepRun.stepId, stepRun]),
    );
    expect([...byStep.keys()].sort()).toEqual(["s1", "s2", "s3"]);
    expect(["s1", "s2", "s3"].map((id) => byStep.get(id)?.iteration)).toEqual([1, 1, 1]);
    expect(["s1", "s2", "s3"].map((id) => byStep.get(id)?.status)).toEqual([
      "success",
      "success",
      "success",
    ]);
    expect(["s1", "s2", "s3"].map((id) => byStep.get(id)?.sessionId)).toEqual([
      "s-impl",
      "s-rev",
      "s-ship",
    ]);
    expect(["s1", "s2", "s3"].map((id) => byStep.get(id)?.output)).toEqual([
      "IMPL-OUT",
      "REV-OUT",
      "SHIP-OUT",
    ]);

    expect(h.db.runs.get(run.id)).toMatchObject({
      status: "success",
      output: "SHIP-OUT",
      workflowId: workflow.id,
    });
  });

  it("stops on the first failed step: run failed, earlier steps stay inspectable, later steps never start", async () => {
    const h = setup();
    const workflow = h.makeWorkflow([
      {
        id: "s1",
        name: "implement",
        driver: "impl",
        mode: "auto",
        promptTemplate: "{{task}}",
        continueSession: false,
      },
      {
        id: "s2",
        name: "verify",
        driver: "boom",
        mode: "auto",
        promptTemplate: "{{prevOutput}}",
        continueSession: false,
      },
      {
        id: "s3",
        name: "ship",
        driver: "ship",
        mode: "auto",
        promptTemplate: "{{prevOutput}}",
        continueSession: false,
      },
    ]);
    const run = h.enqueueRun(workflow.id);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "failed");

    expect(h.db.runs.get(run.id)).toMatchObject({
      status: "failed",
      error: "agent exited with code 7",
      output: "PARTIAL",
    });

    // Step 1 remains successful and inspectable; step 2 failed; step 3 never ran.
    const byStep = new Map(
      h.db.stepRuns.listByRun(run.id).map((stepRun) => [stepRun.stepId, stepRun]),
    );
    expect(byStep.get("s1")?.status).toBe("success");
    expect(byStep.get("s2")?.status).toBe("failed");
    expect(byStep.has("s3")).toBe(false);
    expect(h.drivers.ship.calls).toHaveLength(0);
    expect(h.drivers.impl.calls).toHaveLength(1);
    expect(h.drivers.boom.calls).toHaveLength(1);
  });

  it("persists an ordered event log: run.status wraps step.started/driver events/step.completed", async () => {
    const h = setup();
    const workflow = h.makeWorkflow([
      {
        id: "s1",
        name: "implement",
        driver: "impl",
        mode: "auto",
        promptTemplate: "{{task}}",
        continueSession: false,
      },
      {
        id: "s2",
        name: "ship",
        driver: "ship",
        mode: "auto",
        promptTemplate: "{{prevOutput}}",
        continueSession: false,
      },
    ]);
    const run = h.enqueueRun(workflow.id);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    const events = h.db.events.getSince(run.id);
    expect(
      events.map((event) => `${event.type}${"status" in event ? `:${event.status}` : ""}`),
    ).toEqual([
      "run.status:running",
      "step.started",
      "started",
      "session",
      "message-delta",
      "step.completed:success",
      "step.started",
      "started",
      "session",
      "step.completed:success",
      "run.status:success",
    ]);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(h.db.events.lastRunStatus(run.id)).toEqual({
      type: "run.status",
      seq: 11,
      status: "success",
    });
  });

  it("fails the run when the workflow references an unknown driver or bad template variable", async () => {
    const h = setup();
    const badDriver = h.makeWorkflow([
      {
        id: "s1",
        name: "ghost",
        driver: "nope",
        mode: "auto",
        promptTemplate: "{{task}}",
        continueSession: false,
      },
    ]);
    const driverRun = h.enqueueRun(badDriver.id);
    await h.engine.executeRun(driverRun.id, noAbort);
    await awaitStatus(h, driverRun.id, "failed");
    expect(h.db.runs.get(driverRun.id)?.error).toContain('no driver registered with id "nope"');

    const badTemplate = h.makeWorkflow([
      {
        id: "s1",
        name: "typo",
        driver: "impl",
        mode: "auto",
        promptTemplate: "{{tsk}}",
        continueSession: false,
      },
    ]);
    const templateRun = h.enqueueRun(badTemplate.id);
    await h.engine.executeRun(templateRun.id, noAbort);
    await awaitStatus(h, templateRun.id, "failed");
    expect(h.db.runs.get(templateRun.id)?.error).toContain("Unknown prompt template variable");
    expect(h.db.events.lastRunStatus(templateRun.id)).toMatchObject({ status: "failed" });
  });

  it("marks the run failed when the project repo is not usable", async () => {
    const h = setup();
    const plain = h.db.projects.create({
      id: crypto.randomUUID(),
      path: join(h.dir, "plain"),
      name: "plain",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    mkdirSync(join(h.dir, "plain"), { recursive: true });
    const run = h.enqueueRun(undefined, "x");
    // Retarget the run at the unusable project (create() needs a valid FK).
    h.db.sqlite.prepare("update runs set project_id = ? where id = ?").run(plain.id, run.id);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "failed");
    expect(h.db.runs.get(run.id)?.error).toContain("not a git repository");
    expect(h.db.events.lastRunStatus(run.id)).toMatchObject({ status: "failed" });
  });
});

describe("createFlowEngine (ad-hoc runs)", () => {
  it("executes a workflow-less run as one transient step with the task as prompt", async () => {
    const h = setup();
    const run = h.enqueueRun(undefined, "just do it");

    await h.engine.executeRun(run.id, noAbort, { driverId: "impl", model: "glm-4.6", mode: "ask" });
    await awaitStatus(h, run.id, "success");

    expect(h.drivers.impl.calls).toEqual([
      { cwd: join(h.storeRoot, run.id), prompt: "just do it", model: "glm-4.6", mode: "ask" },
    ]);
    expect(h.db.stepRuns.listByRun(run.id)).toEqual([
      expect.objectContaining({
        stepId: "adhoc",
        iteration: 1,
        status: "success",
        sessionId: "s-impl",
      }),
    ]);
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "IMPL-OUT" });
  });

  it("reuses a pre-existing queued step run row instead of duplicating it", async () => {
    const h = setup();
    const run = h.enqueueRun(undefined, "resume me");
    const stepRunId = crypto.randomUUID();
    h.db.stepRuns.create({
      id: stepRunId,
      runId: run.id,
      stepId: "adhoc",
      iteration: 1,
      status: "queued",
      output: "",
    });

    await h.engine.executeRun(run.id, noAbort, { driverId: "impl" });
    await awaitStatus(h, run.id, "success");

    const stepRuns = h.db.stepRuns.listByRun(run.id);
    expect(stepRuns).toHaveLength(1);
    expect(stepRuns[0]).toMatchObject({ id: stepRunId, status: "success" });
  });
});
