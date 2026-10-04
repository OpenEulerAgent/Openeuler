import { WorkflowScheduleConfigSchema } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../app.js";
import { HttpError } from "../errors.js";

/**
 * Per-workflow cron schedules (#121), management API mounted at
 * `/api/workflows` (normal auth): `GET /:id/schedule` (404 when none),
 * `PUT /:id/schedule` (idempotent full-config upsert — exactly one
 * schedule row per workflow by construction; the body is the core
 * `WorkflowScheduleConfigSchema`, so invalid crons/timezones answer 422
 * with field-attributed details), `DELETE /:id/schedule`. The run minting
 * lives in the daemon's minute ticker (`scheduler.ts`), not here: PUT only
 * stores config; scheduled runs are ordinary workflow runs.
 */

function requireDb(c: Context<AppEnv>): Db {
  const db = c.get("db");
  if (!db) throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
  return db;
}

async function parseJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(422, "INVALID_JSON", "request body must be valid JSON");
  }
}

/** A schedule row as the API serves it (never secrets — there are none). */
export function scheduleBody(schedule: {
  id: string;
  workflowId: string;
  enabled: boolean;
  cron: string;
  taskTemplate: string;
  timezone: string;
  lastFiredAt?: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: schedule.id,
    workflowId: schedule.workflowId,
    enabled: schedule.enabled,
    cron: schedule.cron,
    taskTemplate: schedule.taskTemplate,
    timezone: schedule.timezone,
    ...(schedule.lastFiredAt === undefined ? {} : { lastFiredAt: schedule.lastFiredAt }),
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

export function createWorkflowSchedulesRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/:id/schedule", (c) => {
    const db = requireDb(c);
    const workflow = db.workflows.get(c.req.param("id"));
    if (!workflow) {
      throw new HttpError(404, "WORKFLOW_NOT_FOUND", `no workflow with id ${c.req.param("id")}`);
    }
    const schedule = db.workflowSchedules.getByWorkflow(workflow.id);
    if (!schedule) {
      throw new HttpError(
        404,
        "SCHEDULE_NOT_FOUND",
        `workflow ${workflow.id} has no schedule; create one via PUT /api/workflows/${workflow.id}/schedule`,
      );
    }
    return c.json({ schedule: scheduleBody(schedule) });
  });

  // Full-config upsert: replaces the config whether the row exists or not
  // (the repo's transaction keeps one row per workflow — no duplicates).
  router.put("/:id/schedule", async (c) => {
    const db = requireDb(c);
    const workflow = db.workflows.get(c.req.param("id"));
    if (!workflow) {
      throw new HttpError(404, "WORKFLOW_NOT_FOUND", `no workflow with id ${c.req.param("id")}`);
    }
    const body = WorkflowScheduleConfigSchema.parse(await parseJsonBody(c));
    const schedule = db.workflowSchedules.upsertByWorkflow(workflow.id, {
      enabled: body.enabled,
      cron: body.cron.trim(),
      taskTemplate: body.taskTemplate,
      timezone: body.timezone.trim(),
    });
    c.get("logger").info(
      { scheduleId: schedule.id, workflowId: workflow.id, enabled: schedule.enabled },
      "workflow schedule saved",
    );
    return c.json({ schedule: scheduleBody(schedule) });
  });

  router.delete("/:id/schedule", (c) => {
    const db = requireDb(c);
    const workflow = db.workflows.get(c.req.param("id"));
    if (!workflow) {
      throw new HttpError(404, "WORKFLOW_NOT_FOUND", `no workflow with id ${c.req.param("id")}`);
    }
    const schedule = db.workflowSchedules.getByWorkflow(workflow.id);
    if (!schedule || !db.workflowSchedules.delete(schedule.id)) {
      throw new HttpError(404, "SCHEDULE_NOT_FOUND", `workflow ${workflow.id} has no schedule`);
    }
    c.get("logger").info(
      { scheduleId: schedule.id, workflowId: workflow.id },
      "workflow schedule deleted",
    );
    return c.body(null, 204);
  });

  return router;
}
