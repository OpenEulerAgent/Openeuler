import { randomUUID } from "node:crypto";
import type { GraphSummary, Run, Step, Workflow, WorkflowGraph } from "@openeuler/core";
import {
  LoopBackSchema,
  StepSchema,
  WorkflowGraphSchema,
  graphToLinear,
  idSchema,
  linearToGraph,
  loopBackToStepIndexIssue,
  summarizeGraph,
} from "@openeuler/core";
import type { Db, WorkflowRevision } from "@openeuler/db";
import { branchForRun } from "@openeuler/engine";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { recordWorkflowCreatedActivity } from "../activity.js";
import type { Executor } from "../executor.js";
import { HttpError } from "../errors.js";

/**
 * Workflow CRUD + graph revisions.
 *
 * Every workflow carries an immutable graph revision history: saves via
 * `PUT /:id/graph` (and legacy writes through `POST` / `PATCH`, which are
 * auto-snapshotted so runs can always pin a revision) create the next
 * numbered revision; runs pin the revision that was latest when they were
 * created, so editing a workflow never mutates a running run.
 */

/**
 * Create body: either a `graph` (canonical, creates revision 1) or the
 * legacy `steps` (+ optional `loopBack`) shape, which is auto-translated
 * into revision 1. Built from the unrefined shape (zod cannot `.omit()` on
 * refined objects).
 */
const CreateWorkflowBodySchema = z
  .strictObject({
    projectId: idSchema,
    name: z.string().min(1, "workflow name must be a non-empty string"),
    graph: WorkflowGraphSchema.optional(),
    steps: z.array(StepSchema).min(1, "a workflow needs at least one step").optional(),
    loopBack: LoopBackSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.graph !== undefined && body.steps !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["graph"],
        message: "provide either graph or steps, not both",
      });
      return;
    }
    if (body.graph === undefined && body.steps === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: "a workflow needs either a graph or steps",
      });
      return;
    }
    if (body.graph !== undefined && body.loopBack !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["loopBack"],
        message:
          "loopBack belongs to the legacy steps shape; encode loops as conditional graph edges",
      });
      return;
    }
    if (body.steps === undefined) return;
    const issue = loopBackToStepIndexIssue({ steps: body.steps, loopBack: body.loopBack });
    if (issue !== undefined) {
      ctx.addIssue({ code: "custom", path: ["loopBack", "toStepIndex"], message: issue });
    }
  });

/** Patch body: any subset of the mutable legacy fields; `loopBack: null` clears it. */
const PatchWorkflowBodySchema = z.strictObject({
  name: z.string().min(1, "workflow name must be a non-empty string").optional(),
  steps: z.array(StepSchema).min(1, "a workflow needs at least one step").optional(),
  loopBack: LoopBackSchema.nullable().optional(),
});

/**
 * PUT /:id/graph body: the full graph (validated + snapshotted as a new
 * revision) plus the optional concurrency guard (#76): `expectedRevision`
 * pins the revision the client edited — a mismatch with the current latest
 * refuses the save with 409 REVISION_CONFLICT instead of silently winning
 * last-writer-wins. Absent = current behavior (no check), so older clients
 * keep working.
 */
const PutGraphBodySchema = z.strictObject({
  graph: WorkflowGraphSchema,
  expectedRevision: z
    .number({ message: "expectedRevision must be a number" })
    .int("expectedRevision must be an integer")
    .min(1, "expectedRevision must be >= 1")
    .optional(),
});

const CreateWorkflowRunBodySchema = z.strictObject({
  task: z.string().min(1, "task must be a non-empty string"),
});

/** Revision number path param (`:number`). */
const RevisionNumberSchema = z.coerce
  .number()
  .int("revision number must be an integer")
  .min(1, "revision number must be >= 1");

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

function requireRevisionNumber(number: string): number {
  const parsed = RevisionNumberSchema.safeParse(number);
  if (!parsed.success) {
    throw new HttpError(
      422,
      "INVALID_REVISION_NUMBER",
      parsed.error.issues[0]?.message ?? "revision number must be a positive integer",
    );
  }
  return parsed.data;
}

/**
 * Legacy steps mirror for a graph that the linear shape cannot represent
 * (routers, `{{output:}}` templates): the entry node as a single step. The
 * graph revision stays authoritative; this only keeps pre-graph consumers
 * (the steps-based builder UI) rendering something truthful about the start.
 */
function placeholderSteps(graph: WorkflowGraph): Step[] {
  const entry = graph.nodes.find((node) => node.id === graph.entryNodeId);
  if (entry === undefined || entry.type !== "agent") {
    throw new HttpError(422, "VALIDATION_ERROR", "graph entry node must be an agent node");
  }
  return [
    {
      id: entry.id,
      name: entry.name,
      ...entry.config,
    },
  ];
}

/** Mirrors a validated graph onto the legacy steps/loopBack columns when it round-trips. */
function mirrorGraphToSteps(db: Db, workflowId: string, graph: WorkflowGraph): void {
  const linear = graphToLinear(graph);
  if (!linear.ok) return;
  db.workflows.update(workflowId, {
    steps: linear.steps,
    ...(linear.loopBack === undefined ? { loopBack: null } : { loopBack: linear.loopBack }),
  });
}

/**
 * The workflow's latest revision, creating revision 1 from the current
 * legacy steps if the workflow has none yet (lazy migration for rows written
 * before graph revisions existed — the boot migration covers most of these).
 */
export function ensureLatestRevision(db: Db, workflow: Workflow): WorkflowRevision {
  const latest = db.workflowRevisions.latest(workflow.id);
  if (latest !== undefined) return latest;
  return db.workflowRevisions.create(
    workflow.id,
    linearToGraph({ steps: workflow.steps, loopBack: workflow.loopBack }),
  );
}

/**
 * Workflow list row (#70): the row plus a graph summary computed from the
 * latest revision snapshot — NOT the legacy steps mirror, which goes stale
 * for graphs the linear shape cannot represent (routers, branches). The
 * summary is absent for never-saved legacy workflows without revisions;
 * those keep the steps-based display. Full graph blobs stay off the list.
 */
export function workflowListBody(
  db: Db,
  workflow: Workflow,
): Workflow & { graphSummary?: GraphSummary } {
  const latest = db.workflowRevisions.latest(workflow.id);
  if (latest === undefined) return { ...workflow };
  return { ...workflow, graphSummary: summarizeGraph(latest.graph, latest.number) };
}

/** Workflow API body: the row plus its latest revision pointer and graph. */
export function workflowBody(
  db: Db,
  workflow: Workflow,
): Workflow & {
  latestRevision?: { id: string; number: number };
  graph?: WorkflowGraph;
  graphSummary?: GraphSummary;
} {
  const latest = db.workflowRevisions.latest(workflow.id);
  if (latest === undefined) return { ...workflow };
  return {
    ...workflow,
    latestRevision: { id: latest.id, number: latest.number },
    graph: latest.graph,
    graphSummary: summarizeGraph(latest.graph, latest.number),
  };
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

    let revision: WorkflowRevision;
    let workflow: Workflow;
    if (body.graph !== undefined) {
      const linear = graphToLinear(body.graph);
      workflow = db.workflows.create({
        id: randomUUID(),
        projectId: body.projectId,
        name: body.name,
        steps: linear.ok ? linear.steps : placeholderSteps(body.graph),
        ...(linear.ok && linear.loopBack !== undefined ? { loopBack: linear.loopBack } : {}),
      });
      revision = db.workflowRevisions.create(workflow.id, body.graph);
    } else {
      const steps = body.steps as Step[];
      workflow = db.workflows.create({
        id: randomUUID(),
        projectId: body.projectId,
        name: body.name,
        steps,
        ...(body.loopBack === undefined ? {} : { loopBack: body.loopBack }),
      });
      revision = db.workflowRevisions.create(
        workflow.id,
        linearToGraph({ steps, loopBack: body.loopBack }),
      );
    }

    c.get("logger").info(
      { workflowId: workflow.id, projectId: project.id, revision: revision.number },
      "workflow created",
    );
    recordWorkflowCreatedActivity(db, workflow);
    return c.json(
      {
        workflow: workflowBody(db, db.workflows.get(workflow.id) as Workflow),
        revision: { id: revision.id, number: revision.number },
      },
      201,
    );
  });

  workflows.get("/", (c) => {
    const db = requireDb(c);
    const workflows = db.workflows
      .list(c.req.query("projectId") || undefined)
      .map((workflow) => workflowListBody(db, workflow));
    return c.json({ workflows });
  });

  workflows.get("/:id", (c) => {
    const db = requireDb(c);
    return c.json({ workflow: workflowBody(db, requireWorkflow(db, c.req.param("id"))) });
  });

  workflows.patch("/:id", async (c) => {
    const db = requireDb(c);
    const id = c.req.param("id");
    requireWorkflow(db, id);
    const body = PatchWorkflowBodySchema.parse(await parseJsonBody(c));
    const workflow = db.workflows.update(id, body);
    if (!workflow) throw new HttpError(404, "WORKFLOW_NOT_FOUND", `no workflow with id ${id}`);
    // Legacy shape edits are snapshotted so runs can keep pinning revisions.
    if (body.steps !== undefined || body.loopBack !== undefined) {
      db.workflowRevisions.create(
        id,
        linearToGraph({ steps: workflow.steps, loopBack: workflow.loopBack }),
      );
    }
    c.get("logger").info({ workflowId: id }, "workflow updated");
    return c.json({ workflow: workflowBody(db, db.workflows.get(id) as Workflow) });
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
    // Runs are gone (checked above), so the revision snapshots have nothing
    // left to pin; drop them before the row (the FK would otherwise refuse).
    db.workflowRevisions.deleteAllForWorkflow(id);
    if (!db.workflows.delete(id)) {
      throw new HttpError(404, "WORKFLOW_NOT_FOUND", `no workflow with id ${id}`);
    }
    c.get("logger").info({ workflowId: id }, "workflow deleted");
    return c.body(null, 204);
  });

  // Save the graph: validate (422 with node/edge-attributed details), then
  // snapshot it as the next immutable revision. The legacy steps mirror is
  // refreshed when the graph round-trips to the linear shape.
  workflows.put("/:id/graph", async (c) => {
    const db = requireDb(c);
    const id = c.req.param("id");
    requireWorkflow(db, id);
    const body = PutGraphBodySchema.parse(await parseJsonBody(c));
    // Concurrency guard (#76): the client pinned the revision it edited;
    // a newer revision elsewhere refuses the save (409) with the current
    // number so the editor can offer reload vs save-anyway.
    const currentRevision = db.workflowRevisions.latest(id)?.number ?? 0;
    if (body.expectedRevision !== undefined && body.expectedRevision !== currentRevision) {
      throw new HttpError(
        409,
        "REVISION_CONFLICT",
        `workflow ${id} is at revision ${currentRevision}, not the expected ${body.expectedRevision}`,
        { currentRevision },
      );
    }
    const revision = db.workflowRevisions.create(id, body.graph);
    mirrorGraphToSteps(db, id, body.graph);
    c.get("logger").info({ workflowId: id, revision: revision.number }, "workflow graph saved");
    return c.json({
      workflow: workflowBody(db, db.workflows.get(id) as Workflow),
      revision: { id: revision.id, number: revision.number },
    });
  });

  // Revision list (no graph blobs): number, createdAt per snapshot.
  workflows.get("/:id/revisions", (c) => {
    const db = requireDb(c);
    const id = c.req.param("id");
    requireWorkflow(db, id);
    const revisions = db.workflowRevisions
      .list(id)
      .map(({ id: revisionId, number, createdAt }) => ({
        id: revisionId,
        number,
        createdAt,
      }));
    return c.json({ revisions });
  });

  // Full snapshot of one revision.
  workflows.get("/:id/revisions/:number", (c) => {
    const db = requireDb(c);
    const id = c.req.param("id");
    requireWorkflow(db, id);
    const number = requireRevisionNumber(c.req.param("number"));
    const revision = db.workflowRevisions.getByNumber(id, number);
    if (!revision) {
      throw new HttpError(
        404,
        "REVISION_NOT_FOUND",
        `workflow ${id} has no revision ${number} (latest: ${db.workflows.get(id)?.latestRevisionNumber ?? "none"})`,
      );
    }
    return c.json({ revision });
  });

  // Queue a run of the workflow; execution happens in the background via the
  // flow engine (202). StepRun rows appear as each step starts. The run is
  // pinned to the latest graph revision snapshot (creating revision 1 for
  // not-yet-migrated legacy workflows on the fly).
  workflows.post("/:id/runs", async (c) => {
    const db = requireDb(c);
    const executor = requireExecutor(c);
    const id = c.req.param("id");
    const workflow = requireWorkflow(db, id);
    const body = CreateWorkflowRunBodySchema.parse(await parseJsonBody(c));

    const revision = ensureLatestRevision(db, workflow);

    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: Run = {
      id: runId,
      projectId: workflow.projectId,
      workflowId: workflow.id,
      workflowRevisionId: revision.id,
      status: "queued",
      branch: branchForRun(runId),
      iteration: 0,
      task: body.task,
      createdAt: now,
      updatedAt: now,
    };
    db.runs.create(run);

    c.get("logger").info(
      {
        runId,
        workflowId: workflow.id,
        workflowRevisionId: revision.id,
        revision: revision.number,
      },
      "workflow run accepted",
    );
    executor.startRun(runId);

    return c.json(
      { run: { ...run, workflowRevision: { id: revision.id, number: revision.number } } },
      202,
    );
  });

  return workflows;
}
