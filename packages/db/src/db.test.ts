import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { AgentEvent, PersistedEvent, Project, Run, StepRun, Workflow } from "@openeuler/core";
import { createDatabase } from "./index.js";
import type { Db } from "./index.js";

const uuid = (): string => crypto.randomUUID();
const iso = (): string => new Date().toISOString();

const makeProject = (over: Partial<Project> = {}): Project => ({
  id: uuid(),
  path: "/srv/repos/demo",
  name: "demo",
  defaultBranch: "main",
  createdAt: iso(),
  ...over,
});

const makeWorkflow = (projectId: string, over: Partial<Workflow> = {}): Workflow => ({
  id: uuid(),
  projectId,
  name: "ci-fix",
  steps: [
    {
      id: uuid(),
      name: "fix",
      driver: "opencode",
      mode: "auto",
      promptTemplate: "Fix {{task}}",
      continueSession: false,
    },
  ],
  loopBack: {
    toStepIndex: 0,
    when: { type: "outputNotContains", pattern: "done" },
    maxIterations: 3,
  },
  ...over,
});

const makeRun = (projectId: string, over: Partial<Run> = {}): Run => ({
  id: uuid(),
  projectId,
  status: "queued",
  branch: "agent/abc123",
  iteration: 0,
  task: "make it green",
  createdAt: iso(),
  updatedAt: iso(),
  ...over,
});

const makeStepRun = (runId: string, over: Partial<StepRun> = {}): StepRun => ({
  id: uuid(),
  runId,
  stepId: uuid(),
  iteration: 1,
  status: "running",
  output: "",
  ...over,
});

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openeuler-db-"));
  db = createDatabase({ path: join(dir, "test.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("createDatabase", () => {
  it("applies migrations to a fresh file", () => {
    const tables = db.sqlite
      .prepare<[], { name: string }>(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["projects", "workflows", "runs", "step_runs", "events"]),
    );
  });

  it("re-running against the same file is a no-op and keeps data intact", () => {
    const project = db.projects.create(makeProject());
    db.close();
    const reopened = createDatabase({ path: join(dir, "test.db") });
    try {
      expect(reopened.projects.get(project.id)).toEqual(project);
    } finally {
      reopened.close();
    }
  });

  it("0008 backfills runs.event_seq_hwm from existing events (#149)", () => {
    const project = db.projects.create(makeProject());
    const run = db.runs.create(makeRun(project.id));
    db.events.append(run.id, { type: "started" });
    db.events.append(run.id, { type: "done", output: "ok" });
    db.close();

    // Rewind the file to its pre-0008 shape: forget the last applied
    // migrations (0008 hwm + 0009 run ports + 0010 hosting + 0011 sub-workflow
    // parentRunId + 0012 approval awaiting + 0013 step attempt + 0014
    // workflow webhooks + 0015 workflow schedules) and drop the
    // columns/tables they added. (Journal rows carry no usable id — order by
    // created_at.)
    const raw = new Database(join(dir, "test.db"));
    try {
      raw.exec(
        "delete from __drizzle_migrations where created_at >= (select distinct created_at from __drizzle_migrations order by created_at desc limit 1 offset 7)",
      );
      raw.exec("alter table runs drop column event_seq_hwm");
      raw.exec("alter table runs drop column ports");
      raw.exec("alter table runs drop column detected_ports");
      raw.exec("alter table runs drop column hosting");
      raw.exec("alter table runs drop column hosted_until");
      raw.exec("drop index if exists runs_parent_run_id_idx");
      raw.exec("alter table runs drop column parent_run_id");
      raw.exec("alter table runs drop column awaiting_node_id");
      raw.exec("alter table runs drop column awaiting_since");
      raw.exec("alter table step_runs drop column attempt");
      raw.exec("drop table if exists workflow_schedules");
      raw.exec("drop table if exists webhook_deliveries");
      raw.exec("drop table if exists workflow_webhooks");
    } finally {
      raw.close();
    }

    // Re-opening re-applies 0008: ADD COLUMN + backfill hwm = max(seq)/run.
    const upgraded = createDatabase({ path: join(dir, "test.db") });
    const hwmOf = (id: string): number | undefined =>
      (
        upgraded.sqlite
          .prepare<{ id: string }, { event_seq_hwm: number }>(
            "select event_seq_hwm from runs where id = $id",
          )
          .get({ id }) ?? undefined
      )?.event_seq_hwm;
    try {
      expect(hwmOf(run.id)).toBe(2);
      // Runs with no events default to 0.
      const emptyRun = upgraded.runs.create(makeRun(project.id));
      expect(hwmOf(emptyRun.id)).toBe(0);
      // Post-upgrade appends continue past the backfilled mark even after
      // every event row is evicted.
      expect(upgraded.events.deleteOldestByType(run.id, "started", 1)).toBe(1);
      expect(upgraded.events.deleteOldestByType(run.id, "done", 1)).toBe(1);
      expect(upgraded.events.append(run.id, { type: "done", output: "again" }).seq).toBe(3);
    } finally {
      upgraded.close();
    }
  });
});

describe("projects", () => {
  it("round-trips a project", () => {
    const project = makeProject();
    expect(db.projects.create(project)).toEqual(project);
    expect(db.projects.get(project.id)).toEqual(project);
  });

  it("round-trips snapshot metadata (remoteUrl, dirty)", () => {
    const project = makeProject({
      remoteUrl: "https://example.com/demo.git",
      dirty: true,
    });
    db.projects.create(project);
    expect(db.projects.get(project.id)).toEqual(project);
  });

  it("deletes projects and reports unknown ids", () => {
    const project = db.projects.create(makeProject());
    expect(db.projects.delete(project.id)).toBe(true);
    expect(db.projects.get(project.id)).toBeUndefined();
    expect(db.projects.delete(project.id)).toBe(false);
    expect(db.projects.delete(uuid())).toBe(false);
  });

  it("lists projects in creation order", () => {
    const first = makeProject({ name: "first" });
    const second = makeProject({ name: "second" });
    db.projects.create(first);
    db.projects.create(second);
    expect(db.projects.list()).toEqual([first, second]);
  });

  it("returns undefined for unknown ids", () => {
    expect(db.projects.get(uuid())).toBeUndefined();
  });
});

describe("workflows", () => {
  it("round-trips steps and loopBack as JSON", () => {
    const project = db.projects.create(makeProject());
    const workflow = makeWorkflow(project.id);
    db.workflows.create(workflow);
    expect(db.workflows.get(workflow.id)).toEqual(workflow);
  });

  it("round-trips a workflow without loopBack (null column vs absent field)", () => {
    const project = db.projects.create(makeProject());
    const noLoopBack = makeWorkflow(project.id);
    delete noLoopBack.loopBack;
    db.workflows.create(noLoopBack);
    expect(db.workflows.get(noLoopBack.id)).toEqual(noLoopBack);
  });

  it("lists workflows for a project by name", () => {
    const project = db.projects.create(makeProject());
    const other = db.projects.create(makeProject({ name: "other" }));
    const beta = makeWorkflow(project.id, { name: "beta" });
    const alpha = makeWorkflow(project.id, { name: "alpha" });
    db.workflows.create(beta);
    db.workflows.create(alpha);
    db.workflows.create(makeWorkflow(other.id, { name: "elsewhere" }));
    expect(db.workflows.list(project.id)).toEqual([alpha, beta]);
    expect(db.workflows.list()).toHaveLength(3);
  });

  it("patches mutable fields and clears loopBack with null", () => {
    const project = db.projects.create(makeProject());
    const workflow = db.workflows.create(makeWorkflow(project.id));
    const renamed = db.workflows.update(workflow.id, { name: "renamed" });
    expect(renamed).toEqual({ ...workflow, name: "renamed" });

    const steps = [{ ...(workflow.steps[0] as (typeof workflow.steps)[number]), name: "solo" }];
    expect(db.workflows.update(workflow.id, { steps })?.steps).toEqual(steps);

    const withLoop = db.workflows.update(workflow.id, {
      loopBack: { toStepIndex: 0, when: { type: "always" }, maxIterations: 2 },
    });
    expect(withLoop?.loopBack).toEqual({
      toStepIndex: 0,
      when: { type: "always" },
      maxIterations: 2,
    });
    expect(db.workflows.update(workflow.id, { loopBack: null })?.loopBack).toBeUndefined();

    expect(db.workflows.update(uuid(), { name: "x" })).toBeUndefined();
  });

  it("deletes workflows and reports unknown ids", () => {
    const project = db.projects.create(makeProject());
    const workflow = db.workflows.create(makeWorkflow(project.id));
    expect(db.workflows.delete(workflow.id)).toBe(true);
    expect(db.workflows.get(workflow.id)).toBeUndefined();
    expect(db.workflows.delete(workflow.id)).toBe(false);
  });
});

describe("runs", () => {
  it("round-trips a run with optional fields absent", () => {
    const project = db.projects.create(makeProject());
    const run = makeRun(project.id);
    db.runs.create(run);
    expect(db.runs.get(run.id)).toEqual(run);
  });

  it("round-trips a workflow run with output and error", () => {
    const project = db.projects.create(makeProject());
    const workflow = db.workflows.create(makeWorkflow(project.id));
    const run = makeRun(project.id, {
      workflowId: workflow.id,
      status: "failed",
      iteration: 2,
      output: "partial",
      error: "boom",
    });
    db.runs.create(run);
    expect(db.runs.get(run.id)).toEqual(run);
  });

  it("lists runs scoped by project, newest first", () => {
    const project = db.projects.create(makeProject());
    const other = db.projects.create(makeProject({ name: "other" }));
    const older = makeRun(project.id, { createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = makeRun(project.id, { createdAt: "2026-01-02T00:00:00.000Z" });
    db.runs.create(older);
    db.runs.create(newer);
    db.runs.create(makeRun(other.id));
    expect(db.runs.list(project.id)).toEqual([newer, older]);
    expect(db.runs.list()).toHaveLength(3);
  });

  it("lists runs linked to a workflow, newest first", () => {
    const project = db.projects.create(makeProject());
    const workflow = db.workflows.create(makeWorkflow(project.id));
    const older = makeRun(project.id, {
      workflowId: workflow.id,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = makeRun(project.id, {
      workflowId: workflow.id,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    db.runs.create(older);
    db.runs.create(newer);
    db.runs.create(makeRun(project.id));
    expect(db.runs.listByWorkflow(workflow.id)).toEqual([newer, older]);
    expect(db.runs.listByWorkflow(uuid())).toEqual([]);
  });

  it("transitions through every status, updating updatedAt", async () => {
    const project = db.projects.create(makeProject());
    const run = db.runs.create(makeRun(project.id));
    const statuses = ["running", "success", "queued", "aborted", "interrupted", "failed"] as const;
    let previous = run.updatedAt;
    for (const status of statuses) {
      const updated = db.runs.updateStatus(run.id, status);
      expect(updated?.status).toBe(status);
      expect(Date.parse(updated?.updatedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(previous));
      await new Promise((resolve) => setTimeout(resolve, 2));
      previous = updated?.updatedAt ?? previous;
    }
    expect(db.runs.get(run.id)?.status).toBe("failed");
    expect(db.runs.get(run.id)?.updatedAt).not.toBe(run.updatedAt);
    expect(db.runs.updateStatus(uuid(), "running")).toBeUndefined();
  });

  it("round-trips hosting options and hostedUntil, clearing with null (#110)", () => {
    const project = db.projects.create(makeProject());
    const run = db.runs.create(
      makeRun(project.id, {
        status: "success",
        ports: [3000],
        hosting: { enabled: true, keepAliveMinutes: 30 },
        hostedUntil: "2026-01-01T01:00:00.000Z",
      }),
    );
    expect(db.runs.get(run.id)).toEqual(run);

    // Extend: replace the timestamp.
    db.runs.update(run.id, { hostedUntil: "2026-01-01T01:30:00.000Z" });
    expect(db.runs.get(run.id)?.hostedUntil).toBe("2026-01-01T01:30:00.000Z");

    // Hosting ends: null clears the column (absent on the domain row).
    db.runs.update(run.id, { hostedUntil: null });
    const cleared = db.runs.get(run.id);
    expect(cleared?.hostedUntil).toBeUndefined();
    expect(cleared?.hosting).toEqual({ enabled: true, keepAliveMinutes: 30 });

    // The hosting request itself is clearable the same way.
    db.runs.update(run.id, { hosting: null });
    expect(db.runs.get(run.id)?.hosting).toBeUndefined();
  });

  it("filters lists by status on top of the project scope", () => {
    const project = db.projects.create(makeProject());
    db.runs.create(makeRun(project.id, { status: "success" }));
    db.runs.create(
      makeRun(project.id, { status: "failed", createdAt: "2026-01-03T00:00:00.000Z" }),
    );
    db.runs.create(
      makeRun(project.id, { status: "failed", createdAt: "2026-01-04T00:00:00.000Z" }),
    );
    const other = db.projects.create(makeProject({ name: "other" }));
    db.runs.create(makeRun(other.id, { status: "failed" }));
    expect(db.runs.list(project.id, "failed").map((run) => run.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(db.runs.list(undefined, "success")).toHaveLength(1);
    expect(db.runs.list(project.id)).toHaveLength(3);
    expect(db.runs.list(undefined, "queued")).toEqual([]);
  });

  it("patches output and error via update, clearing with null", () => {
    const project = db.projects.create(makeProject());
    const run = db.runs.create(makeRun(project.id));
    expect(db.runs.update(run.id, { status: "failed", output: "partial", error: "boom" })).toEqual({
      ...run,
      status: "failed",
      output: "partial",
      error: "boom",
      updatedAt: expect.any(String),
    });
    expect(db.runs.update(run.id, { output: null, error: null })).toMatchObject({
      status: "failed",
    });
    const cleared = db.runs.get(run.id);
    expect("output" in (cleared ?? {})).toBe(false);
    expect("error" in (cleared ?? {})).toBe(false);
    expect(db.runs.update(uuid(), { status: "success" })).toBeUndefined();
  });

  it("round-trips declared ports and grows detectedPorts via update (#107)", () => {
    const project = db.projects.create(makeProject());
    const run = db.runs.create(makeRun(project.id, { ports: [3000, 8080] }));
    expect(db.runs.get(run.id)).toMatchObject({ ports: [3000, 8080] });

    // Absent when never declared/detected (both columns NULL).
    const bare = db.runs.create(makeRun(project.id));
    expect("ports" in (db.runs.get(bare.id) ?? {})).toBe(false);
    expect("detectedPorts" in (db.runs.get(bare.id) ?? {})).toBe(false);

    // Detection appends through the patch path.
    expect(db.runs.update(bare.id, { detectedPorts: [3000] })).toMatchObject({
      detectedPorts: [3000],
    });
    expect(db.runs.update(bare.id, { detectedPorts: [3000, 4000] })).toMatchObject({
      detectedPorts: [3000, 4000],
    });
  });

  it("rejects invalid port lists on create and update (#107)", () => {
    const project = db.projects.create(makeProject());
    expect(() => db.runs.create(makeRun(project.id, { ports: [0] }))).toThrow();
    expect(() => db.runs.create(makeRun(project.id, { ports: [65536] }))).toThrow();
    expect(() => db.runs.create(makeRun(project.id, { ports: [3000, 3000] }))).toThrow();
    expect(() =>
      db.runs.create(makeRun(project.id, { ports: [3000, 4000, 5000, 6000] })),
    ).toThrow();
    const run = db.runs.create(makeRun(project.id));
    expect(() => db.runs.update(run.id, { detectedPorts: [70000] })).toThrow();
  });
});

describe("step runs", () => {
  it("creates and patches mutable fields, including clearing diff", () => {
    const project = db.projects.create(makeProject());
    const run = db.runs.create(makeRun(project.id));
    const stepRun = db.stepRuns.create(makeStepRun(run.id));
    expect(db.stepRuns.update(stepRun.id, { status: "success", output: "all green" })).toEqual({
      ...stepRun,
      status: "success",
      output: "all green",
    });
    expect(db.stepRuns.update(stepRun.id, { sessionId: "s-1", diff: "+++ ok" })).toMatchObject({
      sessionId: "s-1",
      diff: "+++ ok",
    });
    const cleared = db.stepRuns.update(stepRun.id, { diff: null });
    expect("diff" in (cleared ?? {})).toBe(false);
    expect(db.stepRuns.update(uuid(), { status: "success" })).toBeUndefined();
  });

  it("lists step runs per run ordered by iteration then id", () => {
    const project = db.projects.create(makeProject());
    const run = db.runs.create(makeRun(project.id));
    const otherRun = db.runs.create(makeRun(project.id));
    const second = db.stepRuns.create(makeStepRun(run.id, { iteration: 2, stepId: "step-b" }));
    const first = db.stepRuns.create(makeStepRun(run.id, { iteration: 1, stepId: "adhoc" }));
    db.stepRuns.create(makeStepRun(otherRun.id));
    expect(db.stepRuns.listByRun(run.id)).toEqual([first, second]);
    expect(db.stepRuns.listByRun(otherRun.id)).toHaveLength(1);
    expect(db.stepRuns.listByRun(uuid())).toEqual([]);
  });

  it("persists the retry attempt count in place (#119); NULL reads back as absent", () => {
    const project = db.projects.create(makeProject());
    const run = db.runs.create(makeRun(project.id));
    const stepRun = db.stepRuns.create(makeStepRun(run.id));
    expect("attempt" in (db.stepRuns.listByRun(run.id)[0] ?? {})).toBe(false);
    db.stepRuns.update(stepRun.id, { attempt: 2 });
    expect(db.stepRuns.listByRun(run.id)[0]).toMatchObject({ attempt: 2 });
    db.stepRuns.update(stepRun.id, { attempt: 3, status: "success" });
    expect(db.stepRuns.listByRun(run.id)[0]).toMatchObject({ attempt: 3, status: "success" });
    expect(() => db.stepRuns.update(stepRun.id, { attempt: 0 })).toThrow();
  });
});

describe("events", () => {
  const seedRun = (): { runId: string; otherRunId: string } => {
    const project = db.projects.create(makeProject());
    const run = db.runs.create(makeRun(project.id));
    const otherRun = db.runs.create(makeRun(project.id));
    return { runId: run.id, otherRunId: otherRun.id };
  };

  it("appends events with strictly increasing seq and returns them in order", () => {
    const { runId } = seedRun();
    const appended: PersistedEvent[] = [
      db.events.append(runId, { type: "started" }),
      db.events.append(runId, { type: "session", sessionId: "s-1" }),
      db.events.append(runId, { type: "message-delta", delta: "hi" }),
      db.events.append(runId, { type: "tool-call", tool: "bash", input: { cmd: "ls" } }),
      db.events.append(runId, { type: "tool-output", output: "files" }),
      db.events.append(runId, { type: "done", output: "finished" }),
      db.events.append(runId, { type: "error", message: "exploded", code: "E_AGENT" }),
    ];
    expect(appended.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(db.events.getSince(runId)).toEqual(appended);
  });

  it("getSince respects afterSeq", () => {
    const { runId } = seedRun();
    db.events.append(runId, { type: "started" });
    db.events.append(runId, { type: "session", sessionId: "s-1" });
    db.events.append(runId, { type: "done", output: "ok" });
    expect(db.events.getSince(runId, 1).map((event) => event.type)).toEqual(["session", "done"]);
    expect(db.events.getSince(runId, 3)).toEqual([]);
    expect(db.events.getSince(uuid())).toEqual([]);
  });

  it("keeps independent seq sequences per run", () => {
    const { runId, otherRunId } = seedRun();
    db.events.append(runId, { type: "started" });
    db.events.append(otherRunId, { type: "started" });
    const second = db.events.append(runId, { type: "session", sessionId: "s-a" });
    const otherSecond = db.events.append(otherRunId, { type: "session", sessionId: "s-b" });
    expect(second.seq).toBe(2);
    expect(otherSecond.seq).toBe(2);
    expect(db.events.getSince(runId)).toHaveLength(2);
    expect(db.events.getSince(otherRunId)).toHaveLength(2);
  });

  it("round-trips payloads back through the zod schema", () => {
    const { runId } = seedRun();
    const complex = db.events.append(runId, {
      type: "tool-call",
      tool: "bash",
      input: { nested: { deep: [1, 2, 3] }, flag: true },
    });
    const [read] = db.events.getSince(runId);
    expect(read).toEqual(complex);
    expect(read).toMatchObject({ type: "tool-call", tool: "bash" });
  });

  it("ignores a seq carried by an incoming transport event", () => {
    const { runId } = seedRun();
    const event: AgentEvent = { type: "started", seq: 99 };
    expect(db.events.append(runId, event).seq).toBe(1);
  });

  it("counts events per run", () => {
    const { runId, otherRunId } = seedRun();
    expect(db.events.count(runId)).toBe(0);
    db.events.append(runId, { type: "started" });
    db.events.append(runId, { type: "session", sessionId: "s-1" });
    db.events.append(otherRunId, { type: "started" });
    expect(db.events.count(runId)).toBe(2);
    expect(db.events.count(otherRunId)).toBe(1);
    expect(db.events.count(uuid())).toBe(0);
  });

  it("persists engine events alongside driver events in seq order", () => {
    const { runId } = seedRun();
    db.events.append(runId, { type: "run.status", status: "running" });
    db.events.append(runId, {
      type: "step.started",
      stepId: "s1",
      stepName: "implement",
      iteration: 1,
    });
    db.events.append(runId, { type: "started" });
    db.events.append(runId, { type: "done", output: "ok" });
    db.events.append(runId, {
      type: "step.completed",
      stepId: "s1",
      stepName: "implement",
      iteration: 1,
      status: "success",
    });
    db.events.append(runId, { type: "run.status", status: "success" });

    const events = db.events.getSince(runId);
    expect(events.map((event) => event.type)).toEqual([
      "run.status",
      "step.started",
      "started",
      "done",
      "step.completed",
      "run.status",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events[0]).toEqual({ type: "run.status", seq: 1, status: "running" });
    expect(events[5]).toEqual({ type: "run.status", seq: 6, status: "success" });
  });

  it("lastRunStatus returns the newest run.status event", () => {
    const { runId, otherRunId } = seedRun();
    expect(db.events.lastRunStatus(runId)).toBeUndefined();
    db.events.append(runId, { type: "run.status", status: "running" });
    expect(db.events.lastRunStatus(runId)).toEqual({
      type: "run.status",
      seq: 1,
      status: "running",
    });
    db.events.append(runId, { type: "run.status", status: "failed", error: "boom" });
    expect(db.events.lastRunStatus(runId)).toEqual({
      type: "run.status",
      seq: 2,
      status: "failed",
      error: "boom",
    });
    db.events.append(runId, { type: "started" });
    expect(db.events.lastRunStatus(runId)?.seq).toBe(2);
    expect(db.events.lastRunStatus(otherRunId)).toBeUndefined();
  });

  it("deleteOldestByType removes the oldest N rows of one type, leaving others (#104)", () => {
    const { runId, otherRunId } = seedRun();
    for (let index = 1; index <= 5; index += 1) {
      db.events.append(runId, {
        type: "sandbox.log",
        sandboxId: "sb-1",
        stream: "stdout",
        line: `l${index}`,
      });
    }
    db.events.append(runId, { type: "started" });
    db.events.append(runId, {
      type: "sandbox.log",
      sandboxId: "sb-1",
      stream: "stderr",
      line: "l6",
    });
    db.events.append(otherRunId, {
      type: "sandbox.log",
      sandboxId: "sb-2",
      stream: "stdout",
      line: "other",
    });

    expect(db.events.deleteOldestByType(runId, "sandbox.log", 2)).toBe(2);
    const remaining = db.events
      .getSince(runId, 0)
      .filter((event) => event.type === "sandbox.log")
      .map((event) => (event.type === "sandbox.log" ? event.line : ""));
    expect(remaining).toEqual(["l3", "l4", "l5", "l6"]);
    // Non-matching types and other runs stay untouched; seqs stay contiguous
    // for what remains.
    expect(db.events.getSince(runId, 0).some((event) => event.type === "started")).toBe(true);
    expect(
      db.events
        .getSince(otherRunId, 0)
        .some((event) => event.type === "sandbox.log" && event.line === "other"),
    ).toBe(true);

    // Over-asking removes what exists; count 0 and unknown types are no-ops.
    expect(db.events.deleteOldestByType(runId, "sandbox.log", 100)).toBe(4);
    expect(db.events.deleteOldestByType(runId, "sandbox.log", 3)).toBe(0);
    expect(db.events.deleteOldestByType(runId, "nope", 3)).toBe(0);
    expect(db.events.count(runId)).toBe(1); // only `started` remains
  });

  it("never reuses seq after ring eviction removes the max-seq rows (#149)", () => {
    const { runId } = seedRun();
    const seqs = [1, 2, 3, 4, 5].map(
      (index) =>
        db.events.append(runId, {
          type: "sandbox.log",
          sandboxId: "sb-1",
          stream: "stdout",
          line: `l${index}`,
        }).seq,
    );
    const maxSeq = Math.max(...seqs);

    // Evict EVERY sandbox.log row — including the ones holding max(seq).
    expect(db.events.deleteOldestByType(runId, "sandbox.log", seqs.length)).toBe(seqs.length);

    // The next append must land BEYOND every previously assigned seq, so an
    // SSE Last-Event-ID cursor at maxSeq neither misses nor rebinds events.
    const next = db.events.append(runId, {
      type: "sandbox.log",
      sandboxId: "sb-1",
      stream: "stdout",
      line: "after-eviction",
    });
    expect(next.seq).toBeGreaterThan(maxSeq);
    expect(db.events.getSince(runId, maxSeq)).toEqual([next]);

    // Repeated evict/append cycles keep the seq strictly increasing.
    db.events.deleteOldestByType(runId, "sandbox.log", 1);
    const after = db.events.append(runId, {
      type: "sandbox.log",
      sandboxId: "sb-1",
      stream: "stdout",
      line: "after-eviction-2",
    });
    expect(after.seq).toBeGreaterThan(next.seq);
  });
});
