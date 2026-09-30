import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopBack, Run, RunStatus, Step, Workflow } from "@openeuler/core";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import type { AgentHandle, DriverRegistry, FakeDriver } from "@openeuler/drivers";
import { createFlowEngine } from "./flow-engine.js";
import type { FlowEngine } from "./flow-engine.js";
import { WorktreeManager } from "./worktree.js";

interface Harness {
  dir: string;
  db: Db;
  engine: FlowEngine;
  storeRoot: string;
  projectId: string;
  /** Driver registry: tests register extra scripted drivers on it. */
  registry: DriverRegistry;
  drivers: { impl: FakeDriver; rev: FakeDriver; ship: FakeDriver; boom: FakeDriver };
  makeWorkflow(steps: Workflow["steps"], loopBack?: LoopBack): Workflow;
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
    registry: drivers,
    drivers: { impl, rev, ship, boom },
    makeWorkflow(steps, loopBack) {
      return db.workflows.create({
        id: crypto.randomUUID(),
        projectId: project.id,
        name: "flow",
        steps,
        ...(loopBack === undefined ? {} : { loopBack }),
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

const step = (overrides: Partial<Step> & { id: string; driver: string }): Step => ({
  name: overrides.name ?? overrides.id,
  mode: "auto",
  promptTemplate: "{{task}}",
  continueSession: false,
  ...overrides,
});

const loopEvents = (h: Harness, runId: string) =>
  h.db.events
    .getSince(runId)
    .filter((event) => event.type === "loop.iteration")
    .map((event) =>
      event.type === "loop.iteration"
        ? { iteration: event.iteration, verdict: event.verdict }
        : undefined,
    );

describe("createFlowEngine (loop-back edges + exit conditions)", () => {
  it("loops until outputContains is satisfied on iteration 3: exactly 3 iterations, run success", async () => {
    const h = setup();
    const workflow = h.makeWorkflow(
      [step({ id: "s1", driver: "cycler", promptTemplate: "{{task}} (pass {{iterations}})" })],
      {
        toStepIndex: 0,
        when: { type: "outputContains", pattern: "ALL TESTS PASS" },
        maxIterations: 5,
      },
    );
    const run = h.enqueueRun(workflow.id, "get to green");
    const observedRunIterations: number[] = [];
    const cycler = createFakeDriver({
      id: "cycler",
      events: [{ type: "session", seq: 1, sessionId: "s-cycle" }],
      outputs: ["WIP-1", "WIP-2", "ALL TESTS PASS"],
      onStart: () => {
        // Observe the live run row iteration as each pass starts.
        const current = h.db.runs.get(run.id);
        if (current) observedRunIterations.push(current.iteration);
      },
    });
    h.registry.registerDriver(cycler);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // Exactly 3 driver starts; `{{iterations}}` is 1-based per pass.
    expect(cycler.calls.map((call) => call.prompt)).toEqual([
      "get to green (pass 1)",
      "get to green (pass 2)",
      "get to green (pass 3)",
    ]);

    // Final output is the last (satisfying) output; run row iteration is the
    // 0-based live counter of the final pass.
    expect(h.db.runs.get(run.id)).toMatchObject({
      status: "success",
      output: "ALL TESTS PASS",
      iteration: 2,
    });
    // The run row's iteration updated live: each pass observed its own row value.
    expect(observedRunIterations).toEqual([0, 1, 2]);

    // One StepRun row per pass, all successful, all bound to the session.
    const stepRuns = h.db.stepRuns.listByRun(run.id);
    expect(stepRuns.map((row) => [row.iteration, row.status])).toEqual([
      [1, "success"],
      [2, "success"],
      [3, "success"],
    ]);
    expect(stepRuns.every((row) => row.sessionId === "s-cycle")).toBe(true);

    // Verdicts: continue, continue, then the met exit condition. Exactly one
    // terminal run.status event wraps the passes.
    expect(loopEvents(h, run.id)).toEqual([
      { iteration: 1, verdict: "continue" },
      { iteration: 2, verdict: "continue" },
      { iteration: 3, verdict: "exit-condition-met" },
    ]);
    const terminalStatuses = h.db.events
      .getSince(run.id)
      .filter((event) => event.type === "run.status" && event.status !== "running");
    expect(terminalStatuses).toHaveLength(1);
  });

  it("stops at maxIterations when the condition is never satisfied (run still success)", async () => {
    const h = setup();
    const stuck = createFakeDriver({
      id: "stuck",
      events: [{ type: "session", seq: 1, sessionId: "s-stuck" }],
      output: "still working on it",
    });
    h.registry.registerDriver(stuck);

    const workflow = h.makeWorkflow([step({ id: "s1", driver: "stuck" })], {
      toStepIndex: 0,
      when: { type: "outputContains", pattern: "DONE" },
      maxIterations: 3,
    });
    const run = h.enqueueRun(workflow.id);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    expect(stuck.calls).toHaveLength(3);
    expect(h.db.stepRuns.listByRun(run.id)).toHaveLength(3);
    expect(loopEvents(h, run.id)).toEqual([
      { iteration: 1, verdict: "continue" },
      { iteration: 2, verdict: "continue" },
      { iteration: 3, verdict: "max-iterations" },
    ]);
    expect(h.db.runs.get(run.id)).toMatchObject({
      status: "success",
      output: "still working on it",
      iteration: 2,
    });
  });

  it("does not start a second iteration when the condition is met on the first pass", async () => {
    const h = setup();
    const lgtm = createFakeDriver({
      id: "lgtm",
      events: [{ type: "session", seq: 1, sessionId: "s-lgtm" }],
      output: "looks good: LGTM",
    });
    h.registry.registerDriver(lgtm);

    const workflow = h.makeWorkflow([step({ id: "s1", driver: "lgtm" })], {
      toStepIndex: 0,
      when: { type: "outputContains", pattern: "LGTM" },
      maxIterations: 5,
    });
    const run = h.enqueueRun(workflow.id);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    expect(lgtm.calls).toHaveLength(1);
    expect(h.db.stepRuns.listByRun(run.id)).toHaveLength(1);
    expect(loopEvents(h, run.id)).toEqual([{ iteration: 1, verdict: "exit-condition-met" }]);
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", iteration: 0 });
  });

  it("jumps back to toStepIndex: earlier steps never re-run and prevOutput flows across the jump", async () => {
    const h = setup();
    const workflow = h.makeWorkflow(
      [
        step({ id: "s1", driver: "impl", promptTemplate: "S1[{{task}}]" }),
        step({ id: "s2", driver: "rev", promptTemplate: "S2[{{prevOutput}}]#{{iterations}}" }),
        step({ id: "s3", driver: "ship", promptTemplate: "S3[{{prevOutput}}]" }),
      ],
      {
        toStepIndex: 1,
        when: { type: "outputContains", pattern: "SHIP-OUT WITH LGTM" },
        maxIterations: 2,
      },
    );
    const run = h.enqueueRun(workflow.id);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // s1 ran once; s2 and s3 ran twice (the jump targets s2).
    expect(h.drivers.impl.calls).toHaveLength(1);
    expect(h.drivers.rev.calls).toHaveLength(2);
    expect(h.drivers.ship.calls).toHaveLength(2);

    // Iteration 1 chains linearly; iteration 2's first re-run step (s2)
    // receives the previous iteration's LAST step output (s3's SHIP-OUT).
    expect(h.drivers.rev.calls.map((call) => call.prompt)).toEqual([
      "S2[IMPL-OUT]#1",
      "S2[SHIP-OUT]#2",
    ]);
    expect(h.drivers.ship.calls.map((call) => call.prompt)).toEqual(["S3[REV-OUT]", "S3[REV-OUT]"]);

    // The condition stays unmet (SHIP-OUT never contains the pattern) so the
    // configured cap stops the loop.
    expect(loopEvents(h, run.id)).toEqual([
      { iteration: 1, verdict: "continue" },
      { iteration: 2, verdict: "max-iterations" },
    ]);
  });

  it("continueSession steps resume the previous iteration's same-step session", async () => {
    const h = setup();
    const workflow = h.makeWorkflow(
      [
        step({ id: "s1", driver: "impl", continueSession: false }),
        step({ id: "s2", driver: "rev", continueSession: true }),
      ],
      {
        toStepIndex: 0,
        when: { type: "outputContains", pattern: "NEVER APPEARS" },
        maxIterations: 2,
      },
    );
    const run = h.enqueueRun(workflow.id);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // Iteration 1: s2 continues s1's session (linear chaining).
    expect(h.drivers.impl.calls[0]?.sessionId).toBeUndefined();
    expect(h.drivers.rev.calls[0]?.sessionId).toBe("s-impl");
    // Iteration 2: s2 resumes ITS OWN session from iteration 1 (full review
    // context), not s1's fresh iteration-2 session.
    expect(h.drivers.impl.calls[1]?.sessionId).toBeUndefined();
    expect(h.drivers.rev.calls[1]?.sessionId).toBe("s-rev");

    const revRows = h.db.stepRuns
      .listByRun(run.id)
      .filter((row) => row.stepId === "s2")
      .sort((a, b) => a.iteration - b.iteration);
    expect(revRows.map((row) => [row.iteration, row.sessionId])).toEqual([
      [1, "s-rev"],
      [2, "s-rev"],
    ]);
  });

  it("clamps maxIterations at the hard cap of 25 regardless of configuration", async () => {
    const h = setup();
    const forever = createFakeDriver({
      id: "forever",
      events: [{ type: "session", seq: 1, sessionId: "s-forever" }],
      output: "not done yet",
    });
    h.registry.registerDriver(forever);

    const workflow = h.makeWorkflow([step({ id: "s1", driver: "forever" })], {
      toStepIndex: 0,
      when: { type: "outputContains", pattern: "DONE" },
      maxIterations: 100,
    });
    const run = h.enqueueRun(workflow.id);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    expect(forever.calls).toHaveLength(25);
    expect(h.db.stepRuns.listByRun(run.id)).toHaveLength(25);
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", iteration: 24 });
    const verdicts = loopEvents(h, run.id).map((entry) => entry?.verdict);
    expect(verdicts.slice(0, 24)).toEqual(Array.from({ length: 24 }, () => "continue"));
    // The stop reason is the clamp: maxIterations=100 was hard-capped at 25.
    expect(verdicts[24]).toBe("hard-cap");
  });

  it("evaluates outputMatches against the final output (user-controlled anchoring)", async () => {
    const h = setup();
    const exact = createFakeDriver({
      id: "exact",
      events: [],
      outputs: ["noise before\nstatus: green", "status: green"],
    });
    h.registry.registerDriver(exact);

    const workflow = h.makeWorkflow(
      [step({ id: "s1", driver: "exact", promptTemplate: "{{iterations}}: {{task}}" })],
      {
        toStepIndex: 0,
        when: { type: "outputMatches", regex: "^status: green$" },
        maxIterations: 3,
      },
    );
    const run = h.enqueueRun(workflow.id);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // Pass 1 output has prefix noise so the anchored pattern misses; pass 2
    // matches exactly. Unanchored patterns search (test) the whole output.
    expect(exact.calls).toHaveLength(2);
    expect(loopEvents(h, run.id)).toEqual([
      { iteration: 1, verdict: "continue" },
      { iteration: 2, verdict: "exit-condition-met" },
    ]);
  });

  it("fails the run defensively when loopBack.toStepIndex is out of bounds at runtime", async () => {
    const h = setup();
    const workflow = h.makeWorkflow([step({ id: "s1", driver: "impl" })]);
    // Bypass the schema (which rejects this at save time) via a raw update.
    h.db.sqlite
      .prepare("update workflows set loop_back = ? where id = ?")
      .run(
        JSON.stringify({ toStepIndex: 7, when: { type: "always" }, maxIterations: 2 }),
        workflow.id,
      );
    const run = h.enqueueRun(workflow.id);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "failed");

    expect(h.db.runs.get(run.id)?.error).toContain(
      "loopBack.toStepIndex must be < steps.length (got 7, but the workflow has 1 step(s))",
    );
    expect(h.drivers.impl.calls).toHaveLength(0);
    expect(loopEvents(h, run.id)).toEqual([]);
  });
});

describe("createFlowEngine (run abort)", () => {
  it("aborts mid step-2 of a 3-step flow: s1 success, s2 aborted, s3 never starts, one terminal run.status", async () => {
    const h = setup();
    const slow = createFakeDriver({
      id: "slow",
      events: [
        { type: "session", seq: 1, sessionId: "s-slow" },
        { type: "message-delta", seq: 2, delta: "half " },
        { type: "message-delta", seq: 3, delta: "done" },
      ],
      delayMs: 40,
    });
    h.registry.registerDriver(slow);

    const workflow = h.makeWorkflow([
      step({ id: "s1", driver: "impl" }),
      step({ id: "s2", driver: "slow" }),
      step({ id: "s3", driver: "ship" }),
    ]);
    const run = h.enqueueRun(workflow.id);

    let abortRequested = false;
    let handleCount = 0;
    const control = {
      isAbortRequested: (): boolean => abortRequested,
      onHandle: (handle: AgentHandle | undefined): void => {
        if (handle === undefined) return;
        handleCount += 1;
        if (handleCount === 2) {
          // Abort lands while step 2 (the slow driver) is mid-flight.
          setTimeout(() => {
            abortRequested = true;
            void handle.abort();
          }, 5);
        }
      },
    };

    await h.engine.executeRun(run.id, control);
    await awaitStatus(h, run.id, "aborted");

    expect(h.db.runs.get(run.id)).toMatchObject({ status: "aborted" });

    const byStep = new Map(
      h.db.stepRuns.listByRun(run.id).map((stepRun) => [stepRun.stepId, stepRun]),
    );
    expect(byStep.get("s1")?.status).toBe("success");
    expect(byStep.get("s2")?.status).toBe("aborted");
    expect(byStep.has("s3")).toBe(false);

    expect(h.drivers.impl.calls).toHaveLength(1);
    expect(slow.calls).toHaveLength(1);
    expect(h.drivers.ship.calls).toHaveLength(0);

    // Exactly one terminal run.status event (running is the only other one).
    const statusEvents = h.db.events
      .getSince(run.id)
      .filter((event) => event.type === "run.status");
    expect(statusEvents.map((event) => (event.type === "run.status" ? event.status : ""))).toEqual([
      "running",
      "aborted",
    ]);
  });
});
