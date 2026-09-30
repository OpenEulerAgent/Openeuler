import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, Project, Run, StepRun, Workflow } from "@openeuler/core";
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
  iteration: 0,
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
});

describe("projects", () => {
  it("round-trips a project", () => {
    const project = makeProject();
    expect(db.projects.create(project)).toEqual(project);
    expect(db.projects.get(project.id)).toEqual(project);
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
    const appended: AgentEvent[] = [
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
});
