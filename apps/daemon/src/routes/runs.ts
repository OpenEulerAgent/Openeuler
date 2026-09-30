import { randomUUID } from "node:crypto";
import type { Run, StepRun } from "@openeuler/core";
import { RunStatusSchema } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { DriverError } from "@openeuler/drivers";
import { branchForRun } from "@openeuler/engine";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import type { Executor } from "../executor.js";
import { HttpError } from "../errors.js";

/** Synthetic step concept backing ad-hoc runs (no workflow yet). */
export const ADHOC_STEP_ID = "adhoc";

const CreateRunBodySchema = z.strictObject({
  projectId: z.string().min(1, "projectId must be a non-empty string"),
  prompt: z.string().min(1, "prompt must be a non-empty string"),
  model: z.string().min(1, "model must be a non-empty string").optional(),
  mode: z.enum(["auto", "ask"]).optional(),
});

/** Run detail payload: the run, its step runs, and a small summary. */
export interface RunDetailBody {
  run: Run;
  steps: StepRun[];
  summary: { eventCount: number };
}

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

function requireRun(db: Db, id: string): Run {
  const run = db.runs.get(id);
  if (!run) throw new HttpError(404, "RUN_NOT_FOUND", `no run with id ${id}`);
  return run;
}

export function createRunsRouter(): Hono<AppEnv> {
  const runs = new Hono<AppEnv>();

  runs.post("/", async (c) => {
    const db = requireDb(c);
    const executor = requireExecutor(c);
    const body = CreateRunBodySchema.parse(await parseJsonBody(c));

    const project = db.projects.get(body.projectId);
    if (!project) {
      throw new HttpError(
        404,
        "PROJECT_NOT_FOUND",
        `no project with id ${body.projectId}; register it via POST /api/projects first`,
      );
    }

    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: Run = {
      id: runId,
      projectId: project.id,
      status: "queued",
      branch: branchForRun(runId),
      iteration: 0,
      task: body.prompt,
      createdAt: now,
      updatedAt: now,
    };
    db.runs.create(run);
    db.stepRuns.create({
      id: randomUUID(),
      runId,
      stepId: ADHOC_STEP_ID,
      iteration: 1,
      status: "queued",
      output: "",
    });

    c.get("logger").info({ runId, projectId: project.id }, "run accepted");
    // Background execution; never blocks the response.
    executor.startRun(runId, {
      ...(body.model === undefined ? {} : { model: body.model }),
      mode: body.mode ?? "auto",
    });

    return c.json({ run }, 202);
  });

  runs.get("/", (c) => {
    const db = requireDb(c);
    const statusRaw = c.req.query("status");
    let status: Run["status"] | undefined;
    if (statusRaw !== undefined) {
      const parsed = RunStatusSchema.safeParse(statusRaw);
      if (!parsed.success) {
        throw new HttpError(
          422,
          "INVALID_STATUS",
          `status must be one of queued|running|success|failed|aborted|interrupted, got ${JSON.stringify(statusRaw)}`,
        );
      }
      status = parsed.data;
    }
    return c.json({ runs: db.runs.list(c.req.query("projectId") || undefined, status) });
  });

  runs.get("/:id", (c) => {
    const db = requireDb(c);
    const run = requireRun(db, c.req.param("id"));
    const body: RunDetailBody = {
      run,
      steps: db.stepRuns.listByRun(run.id),
      summary: { eventCount: db.events.count(run.id) },
    };
    return c.json(body);
  });

  runs.post("/:id/abort", async (c) => {
    const db = requireDb(c);
    const executor = requireExecutor(c);
    const id = c.req.param("id");
    requireRun(db, id);

    let result;
    try {
      result = await executor.abortRun(id);
    } catch (err) {
      if (err instanceof DriverError) {
        throw new HttpError(
          500,
          "ABORT_FAILED",
          `driver failed to abort run ${id}: ${err.message}`,
        );
      }
      throw err;
    }

    if (result.outcome === "not_found") {
      throw new HttpError(404, "RUN_NOT_FOUND", `no run with id ${id}`);
    }
    if (result.outcome === "not_abortable") {
      throw new HttpError(
        409,
        "RUN_TERMINAL",
        `run ${id} already finished with status ${result.status}`,
      );
    }
    return c.json({ run: db.runs.get(id) });
  });

  return runs;
}
