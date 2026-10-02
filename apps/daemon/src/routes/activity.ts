import type { Run } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { type ActivityType, isOpsActivityType, type OpsActivityType } from "../activity.js";
import { HttpError } from "../errors.js";
import { getVersion } from "../version.js";

/**
 * Activity feed API (#51): `GET /api/activity?cursor=<id>&limit=20` — an
 * aggregated, newest-first feed over the append-only `activity` table
 * (project/workflow created, run started/terminal). The cursor is the last
 * item's `id`; pages are strictly descending with no duplicates or gaps.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const ActivityQuerySchema = z.strictObject({
  cursor: z.coerce
    .number()
    .int("cursor must be an integer")
    .min(0, "cursor must be >= 0")
    .optional(),
  limit: z.coerce
    .number()
    .int("limit must be an integer")
    .min(1, "limit must be >= 1")
    .max(MAX_LIMIT, `limit must be <= ${MAX_LIMIT}`)
    .optional(),
});

/** One feed item as returned by the API: ids/names resolved at read time. */
export interface ActivityApiItem {
  id: number;
  type: ActivityType;
  createdAt: string;
  project?: { id: string; name: string };
  run?: { id: string; status: Run["status"]; branch: string };
  workflow?: { id: string; name: string };
  message: string;
}

export interface ActivityListBody {
  items: ActivityApiItem[];
  /** Present while another page may exist (the next page's cursor). */
  nextCursor?: number;
}

function requireDb(c: Context<AppEnv>): Db {
  const db = c.get("db");
  if (!db) throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
  return db;
}

/** Short human label for a run: workflow name, task snippet, else branch. */
function runLabel(
  workflowName: string | undefined,
  run: { branch: string; task?: string } | undefined,
): string {
  if (workflowName !== undefined) return workflowName;
  const task = run?.task;
  if (task !== undefined && task.length > 0) {
    return task.length > 64 ? `${task.slice(0, 61)}…` : task;
  }
  return run?.branch ?? "run";
}

/** `n <label>` / `n <label>s` — keeps count-bearing messages readable. */
function plural(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function opsMessage(type: OpsActivityType, payload: Record<string, unknown> | undefined): string {
  const numberish = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  switch (type) {
    case "ops.daemon-boot": {
      const version =
        typeof payload?.["version"] === "string" ? (payload["version"] as string) : getVersion();
      return `Daemon v${version} started`;
    }
    case "ops.recovery-sweep":
      return `Boot recovery sweep: ${plural(
        numberish(payload?.["interrupted"]),
        "interrupted run",
      )}, ${plural(numberish(payload?.["orphanedWorktrees"]), "orphaned worktree")}`;
    case "ops.gc":
      return "Garbage collection ran";
    case "ops.image-pull": {
      const ref = typeof payload?.["ref"] === "string" ? (payload["ref"] as string) : "image";
      return payload?.["done"] === false
        ? `Image pull failed: ${ref}`
        : `Image pulled: ${ref}`;
    }
    case "ops.image-build": {
      const ref = typeof payload?.["ref"] === "string" ? (payload["ref"] as string) : "image";
      return payload?.["done"] === false
        ? `Image build failed: ${ref}`
        : `Image built: ${ref}`;
    }
  }
}

function activityMessage(
  type: ActivityType,
  refs: {
    projectName?: string;
    workflowName?: string;
    run?: { branch: string; task?: string };
    payload?: Record<string, unknown>;
  },
): string {
  if (isOpsActivityType(type)) return opsMessage(type, refs.payload);
  switch (type) {
    case "project.created":
      return `Project ${refs.projectName ?? "unknown"} registered`;
    case "workflow.created":
      return `Workflow ${refs.workflowName ?? "unknown"} created`;
    case "run.started":
      return `Run ${runLabel(refs.workflowName, refs.run)} started`;
    case "run.completed":
      return `Run ${runLabel(refs.workflowName, refs.run)} completed`;
    case "run.failed":
      return `Run ${runLabel(refs.workflowName, refs.run)} failed`;
    case "run.aborted":
      return `Run ${runLabel(refs.workflowName, refs.run)} was aborted`;
    case "run.interrupted":
      return `Run ${runLabel(refs.workflowName, refs.run)} was interrupted by a daemon restart`;
  }
}

export function createActivityRouter(): Hono<AppEnv> {
  const activity = new Hono<AppEnv>();

  activity.get("/", (c) => {
    const db = requireDb(c);
    const query = ActivityQuerySchema.safeParse({
      ...(c.req.query("cursor") === undefined ? {} : { cursor: c.req.query("cursor") }),
      ...(c.req.query("limit") === undefined ? {} : { limit: c.req.query("limit") }),
    });
    if (!query.success) {
      const issue = query.error.issues[0];
      throw new HttpError(422, "INVALID_QUERY", issue?.message ?? "invalid query parameters");
    }
    const limit = query.data.limit ?? DEFAULT_LIMIT;

    const rows = db.activity.list({
      ...(query.data.cursor === undefined || query.data.cursor === 0
        ? {}
        : { beforeId: query.data.cursor }),
      limit,
    });

    // Resolve referenced rows at read time: deleted entities simply drop
    // their field (the message stays meaningful), renames stay fresh.
    const items = rows.map((row) => {
      const type = row.type as ActivityType;
      const project = row.projectId === undefined ? undefined : db.projects.get(row.projectId);
      const run = row.runId === undefined ? undefined : db.runs.get(row.runId);
      const workflowId = run?.workflowId ?? row.workflowId;
      const workflow = workflowId === undefined ? undefined : db.workflows.get(workflowId);

      // Prefer the transition-time snapshot from the payload: the feed row
      // says what happened THEN (a live row may since be terminal). Rows
      // without a payload (legacy/manual appends) fall back to the live row.
      const snapshot = row.payload;
      const runSummary =
        typeof snapshot?.["branch"] === "string"
          ? {
              id: row.runId as string,
              status: (snapshot["status"] as Run["status"] | undefined) ?? "success",
              branch: snapshot["branch"],
            }
          : run !== undefined
            ? { id: run.id, status: run.status, branch: run.branch }
            : undefined;
      const workflowSummary =
        workflow === undefined ? undefined : { id: workflow.id, name: workflow.name };

      const task =
        run?.task ??
        (typeof row.payload?.["task"] === "string" ? (row.payload["task"] as string) : undefined);

      return {
        id: row.id,
        type,
        createdAt: row.createdAt,
        ...(project === undefined ? {} : { project: { id: project.id, name: project.name } }),
        ...(runSummary === undefined ? {} : { run: runSummary }),
        ...(workflowSummary === undefined ? {} : { workflow: workflowSummary }),
        message: activityMessage(type, {
          projectName: project?.name,
          workflowName: workflowSummary?.name,
          run:
            runSummary === undefined
              ? undefined
              : { branch: runSummary.branch, ...(task === undefined ? {} : { task }) },
          // ops.* rows carry their message inputs (version, sweep counts) in
          // the payload; entity rows ignore it (#94).
          payload: row.payload,
        }),
      } satisfies ActivityApiItem;
    });

    const body: ActivityListBody = {
      items,
      ...(items.length === limit && items.length > 0
        ? { nextCursor: items[items.length - 1]?.id }
        : {}),
    };
    return c.json(body);
  });

  return activity;
}
