import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { LoopBack, Step } from "@openeuler/core";

/**
 * Physical schema. Domain validation lives in `@openeuler/core` zod schemas;
 * rows are mapped to/from domain types in the repository layer. Timestamps are
 * ISO 8601 strings (TEXT), matching the core convention.
 */

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  path: text("path").notNull(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").notNull(),
  /** Nullable metadata snapshot columns; absent domain fields persist as NULL. */
  remoteUrl: text("remote_url"),
  dirty: integer("dirty", { mode: "boolean" }),
  createdAt: text("created_at").notNull(),
});

export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    steps: text("steps", { mode: "json" }).$type<Step[]>().notNull(),
    loopBack: text("loop_back", { mode: "json" }).$type<LoopBack | null>(),
  },
  (table) => [index("workflows_project_id_idx").on(table.projectId)],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    /** Null when absent (ad-hoc runs); stored as NULL, not the string "null". */
    workflowId: text("workflow_id").references(() => workflows.id),
    status: text("status").notNull(),
    branch: text("branch").notNull(),
    iteration: integer("iteration").notNull(),
    task: text("task"),
    output: text("output"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("runs_project_id_idx").on(table.projectId),
    index("runs_workflow_id_idx").on(table.workflowId),
    index("runs_status_idx").on(table.status),
  ],
);

export const stepRuns = sqliteTable(
  "step_runs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    stepId: text("step_id").notNull(),
    iteration: integer("iteration").notNull(),
    sessionId: text("session_id"),
    status: text("status").notNull(),
    output: text("output").notNull(),
    diff: text("diff"),
  },
  (table) => [index("step_runs_run_id_idx").on(table.runId)],
);

/**
 * Append-only agent event log. `seq` is assigned per run by the repository
 * (max(seq)+1 inside a transaction); `payload` stores the event JSON without
 * its `seq` so the column stays the single source of truth.
 */
export const events = sqliteTable(
  "events",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("events_run_id_seq_unique").on(table.runId, table.seq)],
);
