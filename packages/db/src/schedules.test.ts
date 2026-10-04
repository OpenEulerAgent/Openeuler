import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Step, Workflow } from "@openeuler/core";
import { createDatabase } from "./index.js";
import type { Db, WorkflowScheduleRow } from "./index.js";

/**
 * Workflow schedule repository (#121): one schedule per workflow (unique
 * workflow, upsert-by-workflow keeps id + lastFiredAt), enabled listing for
 * the daemon ticker, and the workflow-delete cascade.
 */

const uuid = (): string => crypto.randomUUID();
const iso = (): string => new Date().toISOString();

const makeWorkflow = (db: Db): Workflow => {
  const project = db.projects.create({
    id: uuid(),
    path: "/srv/repos/demo",
    name: "demo",
    defaultBranch: "main",
    createdAt: iso(),
  });
  const steps: Step[] = [
    {
      id: "s1",
      name: "Worker",
      driver: "fake",
      mode: "auto",
      promptTemplate: "{{task}}",
      continueSession: false,
    },
  ];
  return db.workflows.create({ id: uuid(), projectId: project.id, name: "wf", steps });
};

const config = {
  enabled: true,
  cron: "30 9 * * 1-5",
  taskTemplate: "morning triage",
  timezone: "America/New_York",
};

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openeuler-schedules-"));
  db = createDatabase({ path: join(dir, "test.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("workflow schedule repo", () => {
  it("creates and reads back a schedule", () => {
    const workflow = makeWorkflow(db);
    const schedule: WorkflowScheduleRow = {
      id: uuid(),
      workflowId: workflow.id,
      ...config,
      createdAt: iso(),
      updatedAt: iso(),
    };
    db.workflowSchedules.create(schedule);
    expect(db.workflowSchedules.getByWorkflow(workflow.id)).toEqual(schedule);
    expect(db.workflowSchedules.get(schedule.id)).toEqual(schedule);
  });

  it("upsertByWorkflow inserts once, then updates in place (id + cursor kept)", () => {
    const workflow = makeWorkflow(db);
    const first = db.workflowSchedules.upsertByWorkflow(workflow.id, config);
    expect(first.enabled).toBe(true);

    // The ticker advances the missed-tick cursor.
    db.workflowSchedules.update(first.id, { lastFiredAt: "2026-01-01T09:30:00.000Z" });

    const second = db.workflowSchedules.upsertByWorkflow(workflow.id, {
      ...config,
      cron: "0 12 * * *",
      enabled: false,
    });
    expect(second.id).toBe(first.id);
    expect(second.cron).toBe("0 12 * * *");
    expect(second.enabled).toBe(false);
    expect(second.lastFiredAt).toBe("2026-01-01T09:30:00.000Z");
    expect(second.createdAt).toBe(first.createdAt);
    expect(db.workflowSchedules.getByWorkflow(workflow.id)?.id).toBe(first.id);
  });

  it("resets the missed-tick cursor on resume and on timing edits", () => {
    const workflow = makeWorkflow(db);
    const created = db.workflowSchedules.upsertByWorkflow(workflow.id, config);
    db.workflowSchedules.update(created.id, { lastFiredAt: "2026-01-01T09:30:00.000Z" });

    const paused = db.workflowSchedules.upsertByWorkflow(workflow.id, {
      ...config,
      enabled: false,
    });
    expect(paused.lastFiredAt).toBe("2026-01-01T09:30:00.000Z");

    const resumed = db.workflowSchedules.upsertByWorkflow(workflow.id, config);
    expect(resumed.lastFiredAt).toBe(resumed.updatedAt);

    db.workflowSchedules.update(resumed.id, { lastFiredAt: "2026-01-01T09:30:00.000Z" });
    const retimed = db.workflowSchedules.upsertByWorkflow(workflow.id, {
      ...config,
      cron: "0 12 * * *",
    });
    expect(retimed.lastFiredAt).toBe(retimed.updatedAt);
  });

  it("refuses a second schedule row for the same workflow (unique index)", () => {
    const workflow = makeWorkflow(db);
    db.workflowSchedules.upsertByWorkflow(workflow.id, config);
    const duplicate = (): unknown =>
      db.workflowSchedules.create({
        id: uuid(),
        workflowId: workflow.id,
        ...config,
        createdAt: iso(),
        updatedAt: iso(),
      });
    expect(duplicate).toThrow(/UNIQUE constraint failed/);
  });

  it("lists only enabled schedules", () => {
    const a = makeWorkflow(db);
    const b = makeWorkflow(db);
    db.workflowSchedules.upsertByWorkflow(a.id, config);
    db.workflowSchedules.upsertByWorkflow(b.id, { ...config, enabled: false });
    const enabled = db.workflowSchedules.listEnabled();
    expect(enabled.map((row) => row.workflowId)).toEqual([a.id]);
  });

  it("updates fields and bumps updatedAt", () => {
    const workflow = makeWorkflow(db);
    const created = db.workflowSchedules.upsertByWorkflow(workflow.id, config);
    const updated = db.workflowSchedules.update(created.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(updated && created && updated.updatedAt >= created.updatedAt).toBe(true);
    expect(db.workflowSchedules.update(uuid(), { enabled: true })).toBeUndefined();
  });

  it("deletes one schedule and cascades on workflow delete", () => {
    const workflow = makeWorkflow(db);
    const created = db.workflowSchedules.upsertByWorkflow(workflow.id, config);
    expect(db.workflowSchedules.delete(created.id)).toBe(true);
    expect(db.workflowSchedules.delete(created.id)).toBe(false);
    expect(db.workflowSchedules.getByWorkflow(workflow.id)).toBeUndefined();

    const again = db.workflowSchedules.upsertByWorkflow(workflow.id, config);
    expect(db.workflowSchedules.deleteForWorkflow(workflow.id)).toBe(1);
    expect(db.workflowSchedules.get(again.id)).toBeUndefined();
  });
});
