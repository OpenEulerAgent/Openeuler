import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type {
  BreadcrumbEntry,
  LoopBack,
  ProjectSandboxPolicy,
  Step,
  StepConfig,
  WorkflowGraph,
} from "@openeuler/core";

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
  /**
   * Per-project sandbox policy (#101) as JSON; NULL until first saved via
   * `PATCH /api/projects/:id/policy`. Validated through the core schema on
   * repo write and read.
   */
  sandboxPolicy: text("sandbox_policy", { mode: "json" }).$type<ProjectSandboxPolicy>(),
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
    /**
     * Latest graph revision number (NULL for pre-graph legacy rows until the
     * boot migration snapshots them). Kept in sync by the revision repo.
     */
    latestRevisionNumber: integer("latest_revision_number"),
  },
  (table) => [index("workflows_project_id_idx").on(table.projectId)],
);

/**
 * Immutable graph snapshots. Every save creates a new revision with the next
 * per-workflow number; runs pin the revision they started with, so editing a
 * workflow can never mutate a running run or its history.
 */
export const workflowRevisions = sqliteTable(
  "workflow_revisions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    /** Per-workflow auto-increment, starting at 1. */
    number: integer("number").notNull(),
    graph: text("graph", { mode: "json" }).$type<WorkflowGraph>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("workflow_revisions_workflow_id_number_unique").on(table.workflowId, table.number),
    index("workflow_revisions_workflow_id_idx").on(table.workflowId),
  ],
);

/**
 * Reusable named agent presets ("your team", #49): a saved StepConfig nodes
 * are created from. Project-scoped in v0.1; `builtin` flags presets seeded
 * on project creation (they are deletable like any other). Nodes always
 * keep their own config copy — presets are never referenced at run time.
 */
export const agentPresets = sqliteTable(
  "agent_presets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    description: text("description").notNull(),
    icon: text("icon"),
    config: text("config", { mode: "json" }).$type<StepConfig>().notNull(),
    builtin: integer("builtin", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("agent_presets_project_id_idx").on(table.projectId)],
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
    /** Graph revision snapshot the run is pinned to; NULL for ad-hoc/legacy runs. */
    workflowRevisionId: text("workflow_revision_id").references(() => workflowRevisions.id),
    status: text("status").notNull(),
    branch: text("branch").notNull(),
    iteration: integer("iteration").notNull(),
    task: text("task"),
    output: text("output"),
    error: text("error"),
    /**
     * Ordered execution breadcrumb for graph-revision runs (#45): completed
     * node executions and taken edges, appended as execution proceeds.
     * Empty array for legacy/ad-hoc runs.
     */
    breadcrumb: text("breadcrumb", { mode: "json" })
      .$type<BreadcrumbEntry[]>()
      .notNull()
      .default(sql`'[]'`),
    /**
     * High-water mark of the event seqs assigned for this run (#149):
     * `events.append` sets seq = max(hwm, max(seq)) + 1 and raises hwm in
     * the same transaction, so ring eviction (`deleteOldestByType`) can
     * never make the next append reuse a seq — SSE Last-Event-ID cursors
     * stay monotonic even after rows are deleted.
     */
    eventSeqHwm: integer("event_seq_hwm").notNull().default(0),
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
 * Per-project secrets (#93): env-var-shaped credentials stored encrypted
 * (AES-256-GCM, daemon-side key). `valueEnc` never leaves the db layer
 * decrypted; the API exposes names only. One row per (project, name) —
 * `set` upserts in place, keeping `createdAt`.
 */
export const projectSecrets = sqliteTable(
  "project_secrets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    valueEnc: text("value_enc").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_secrets_project_id_name_unique").on(table.projectId, table.name),
    index("project_secrets_project_id_idx").on(table.projectId),
  ],
);

/**
 * Append-only agent event log. `seq` is assigned per run by the repository
 * (max(runs.event_seq_hwm, max(seq)) + 1 inside a transaction, then hwm is
 * raised); `payload` stores the event JSON without its `seq` so the column
 * stays the single source of truth.
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

/**
 * Dashboard activity feed (#51): one row per interesting cross-entity
 * transition (project/workflow created, run started/terminal). Deliberately
 * NOT part of the per-run `events` log: entries may reference no run at all,
 * referenced rows may later be deleted (plain text ids, no FKs), and the
 * auto-increment `id` doubles as the strictly-descending feed cursor.
 */
export const activity = sqliteTable(
  "activity",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    projectId: text("project_id"),
    runId: text("run_id"),
    workflowId: text("workflow_id"),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("activity_run_id_idx").on(table.runId)],
);
