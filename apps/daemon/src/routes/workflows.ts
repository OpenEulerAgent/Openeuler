import { randomUUID } from "node:crypto";
import type { Run, Workflow } from "@openeuler/core";
import {
  LoopBackSchema,
  StepSchema,
  WorkflowShapeSchema,
  loopBackToStepIndexIssue,
} from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { branchForRun } from "@openeuler/engine";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import type { Executor } from "../executor.js";
import { HttpError } from "../errors.js";

/**
 * Create body: a full Workflow minus the server-assigned id. Built from the
 * unrefined shape (zod cannot `.omit()` on refined objects) with the same
 * cross-field loopBack refinement `WorkflowSchema` applies.
 */
const CreateWorkflowBodySchema = WorkflowShapeSchema.omit({ id: true }).superRefine((body, ctx) => {
  const issue = loopBackToStepIndexIssue(body);
  if (issue !== undefined) {
    ctx.addIssue({ code: "custom", path: ["loopBack", "toStepIndex"], message: issue });
  }
});

/** Patch body: any subset of the mutable fields; `loopBack: null` clears it. */
const PatchWorkflowBodySchema = z.strictObject({
  name: z.string().min(1, "workflow name must be a non-empty string").optional(),
  steps: z.array(StepSchema).min(1, "a workflow needs at least one step").optional(),
  loopBack: LoopBackSchema.nullable().optional(),
});

const CreateWorkflowRunBodySchema = z.strictObject({
  task: z.string().min(1, "task must be a non-empty string"),
});

function requireDb(c: Context<AppEnv>): Db {
  const db = c.get("db");
  if (!db) throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
  return db;
}

function requireExecutor(c: Context<AppEnv>): Executor {
  const executor = c.get("executor");
  if (!executor) throw new HttpError(503, "EXECUTOR_UNAVAILABLE", "executor is not configured");
  return executor;
}

async function parseJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(422, "INVALID_JSON", "request body must be valid JSON");
  }
}

function requireWorkflow(db: Db, id: string): Workflow {
  const workflow = db.workflows.get(id);
  if (!workflow) throw new HttpError(404, "WORKFLOW_NOT_FOUND", `no workflow with id ${id}`);
  return workflow;
}

export function createWorkflowsRouter(): Hono<AppEnv> {
  const workflows = new Hono<AppEnv>();

  workflows.post("/", async (c) => {
    const db = requireDb(c);
    const body = CreateWorkflowBodySchema.parse(await parseJsonBody(c));
    const project = db.projects.get(body.projectId);
    if (!project) {
      throw new HttpError(
        404,
        "PROJECT_NOT_FOUND",
        `no project with id ${body.projectId}; register it via POST /api/projects first`,
      );
    }
    const workflow = db.workflows.create({ id: randomUUID(), ...body });
    c.get("logger").info({ workflowId: workflow.id, projectId: project.id }, "workflow created");
    return c.json({ workflow }, 201);
  });

  workflows.get("/", (c) => {
    const db = requireDb(c);
    return c.json({ workflows: db.workflows.list(c.req.query("projectId") || undefined) });
  });

  workflows.get("/:id", (c) => {
    const db = requireDb(c);
    return c.json({ workflow: requireWorkflow(db, c.req.param("id")) });
  });

  workflows.patch("/:id", async (c) => {
    const db = requireDb(c);
    const id = c.req.param("id");
    requireWorkflow(db, id);
    const body = PatchWorkflowBodySchema.parse(await parseJsonBody(c));
    const workflow = db.workflows.update(id, body);
    if (!workflow) throw new HttpError(404, "WORKFLOW_NOT_FOUND", `no workflow with id ${id}`);
    c.get("logger").info({ workflowId: id }, "workflow updated");
    return c.json({ workflow });
  });

  workflows.delete("/:id", (c) => {
    const db = requireDb(c);
    const id = c.req.param("id");
    requireWorkflow(db, id);
    if (db.runs.listByWorkflow(id).length > 0) {
      throw new HttpError(
        409,
        "WORKFLOW_IN_USE",
        `workflow ${id} has runs recorded; delete is refused to keep run history inspectable`,
      );
    }
    if (!db.workflows.delete(id)) {
      throw new HttpError(404, "WORKFLOW_NOT_FOUND", `no workflow with id ${id}`);
    }
    c.get("logger").info({ workflowId: id }, "workflow deleted");
    return c.body(null, 204);
  });

  // Queue a run of the workflow; execution happens in the background via the
  // flow engine (202). StepRun rows appear as each step starts.
  workflows.post("/:id/runs", async (c) => {
    const db = requireDb(c);
    const executor = requireExecutor(c);
    const id = c.req.param("id");
    const workflow = requireWorkflow(db, id);
    const body = CreateWorkflowRunBodySchema.parse(await parseJsonBody(c));

    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: Run = {
      id: runId,
      projectId: workflow.projectId,
      workflowId: workflow.id,
      status: "queued",
      branch: branchForRun(runId),
      iteration: 0,
      task: body.task,
      createdAt: now,
      updatedAt: now,
    };
    db.runs.create(run);

    c.get("logger").info({ runId, workflowId: workflow.id }, "workflow run accepted");
    executor.startRun(runId);

    return c.json({ run }, 202);
  });

  return workflows;
}
