import { and, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import {
  AgentPresetSchema,
  BreadcrumbEntrySchema,
  PersistedEventSchema,
  ProjectSandboxPolicySchema,
  ProjectSchema,
  RunSchema,
  RunStatusEventSchema,
  RunStatusSchema,
  StepRunSchema,
  WorkflowGraphSchema,
  WorkflowSchema,
} from "@openeuler/core";
import type {
  AgentPreset,
  BreadcrumbEntry,
  LoopBack,
  PersistedEvent,
  Project,
  ProjectSandboxPolicy,
  Run,
  RunStatus,
  RunStatusEvent,
  Step,
  StepRun,
  Workflow,
  WorkflowGraph,
} from "@openeuler/core";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * A persisted event without its `seq` — the database owns sequence assignment.
 * Values of type `AgentEvent`/`RunEvent` remain assignable (the extra `seq`
 * key is simply ignored), so transport events can be passed straight through.
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type EventInput = DistributiveOmit<PersistedEvent, "seq">;
/** @deprecated Renamed to {@link EventInput}: the log holds engine events too. */
export type AgentEventInput = EventInput;

/** Fields of a run that may change after creation; `null` clears a field. */
export type RunPatch = {
  status?: RunStatus;
  output?: string | null;
  error?: string | null;
  iteration?: number;
  /** Replaces the execution breadcrumb (graph engine appends as it goes). */
  breadcrumb?: BreadcrumbEntry[];
};

/** Fields of a step run that may change after creation; `null` clears a field. */
export type StepRunPatch = {
  sessionId?: string | null;
  status?: RunStatus;
  output?: string;
  diff?: string | null;
};

export interface ProjectRepo {
  create(project: Project): Project;
  get(id: string): Project | undefined;
  /** Bulk `get`: every existing row for the ids, in one query (#62). */
  getMany(ids: string[]): Project[];
  list(): Project[];
  /**
   * Replaces the project's sandbox policy (#101); returns the updated
   * project, or undefined when the row does not exist. The policy is
   * validated through the core schema on write; `get`/`list` re-validate
   * on read so a corrupted column can never leak past the API.
   */
  setSandboxPolicy(id: string, policy: ProjectSandboxPolicy): Project | undefined;
  /** Deletes the project; returns true when a row was removed. */
  delete(id: string): boolean;
}

/** Fields of a workflow that may change after creation; `loopBack: null` clears it. */
export type WorkflowPatch = {
  name?: string;
  steps?: Step[];
  loopBack?: LoopBack | null;
};

export interface WorkflowRepo {
  create(workflow: Workflow): Workflow;
  get(id: string): Workflow | undefined;
  /** Bulk `get`: every existing row for the ids, in one query (#62). */
  getMany(ids: string[]): Workflow[];
  /** Workflows for a project, ordered by name. */
  list(projectId?: string): Workflow[];
  /** Patches mutable fields; returns undefined when the row does not exist. */
  update(id: string, patch: WorkflowPatch): Workflow | undefined;
  /** Deletes the workflow; returns true when a row was removed. */
  delete(id: string): boolean;
}

/** An immutable graph snapshot of a workflow. */
export interface WorkflowRevision {
  id: string;
  workflowId: string;
  /** Per-workflow sequence number, starting at 1. */
  number: number;
  graph: WorkflowGraph;
  createdAt: string;
}

export interface WorkflowRevisionRepo {
  /**
   * Validates + normalizes `graph` (WorkflowGraphSchema), assigns the next
   * per-workflow number, snapshots it, and bumps
   * `workflows.latestRevisionNumber` — all in one transaction. The repo mints
   * the revision id and createdAt.
   */
  create(workflowId: string, graph: unknown): WorkflowRevision;
  get(id: string): WorkflowRevision | undefined;
  /** Bulk `get`: every existing row for the ids, in one query (#62). */
  getMany(ids: string[]): WorkflowRevision[];
  getByNumber(workflowId: string, number: number): WorkflowRevision | undefined;
  /** Revisions of a workflow, oldest first. */
  list(workflowId: string): WorkflowRevision[];
  /** Newest revision of a workflow, if any. */
  latest(workflowId: string): WorkflowRevision | undefined;
  /**
   * Deletes every revision of a workflow (workflow delete path, only allowed
   * once no runs reference them). Returns how many rows were removed.
   */
  deleteAllForWorkflow(workflowId: string): number;
}

/** One stored project secret; the value stays encrypted (`valueEnc`). */
export interface ProjectSecret {
  id: string;
  projectId: string;
  name: string;
  /** AES-256-GCM ciphertext envelope (`v1:<iv>:<tag>:<cipher>`, base64 parts). */
  valueEnc: string;
  createdAt: string;
  updatedAt: string;
}

/** Name-only projection the API may safely return (values never leave the daemon). */
export interface ProjectSecretName {
  name: string;
  createdAt: string;
}

export interface ProjectSecretRepo {
  /**
   * Upserts the (projectId, name) secret to `valueEnc`; the creating insert
   * keeps its `createdAt`, an update only bumps `updatedAt`. The repo mints
   * the id.
   */
  set(projectId: string, name: string, valueEnc: string): ProjectSecret;
  /** Deletes the named secret; true when a row was removed. */
  delete(projectId: string, name: string): boolean;
  /** Names + createdAt for a project, ordered by name. Values never included. */
  listNames(projectId: string): ProjectSecretName[];
  /** Full row (encrypted value) for one secret, for the executor's decrypt path. */
  get(projectId: string, name: string): ProjectSecret | undefined;
  /** Every full row for a project (encrypted values), for run-start loading. */
  list(projectId: string): ProjectSecret[];
  /** Deletes every secret of a project (project delete path). Returns rows removed. */
  deleteAllForProject(projectId: string): number;
}

/** Fields of an agent preset that may change after creation; `null` clears `icon`. */
export type AgentPresetPatch = {
  name?: string;
  description?: string;
  icon?: string | null;
  config?: AgentPreset["config"];
};

export interface AgentPresetRepo {
  create(preset: AgentPreset): AgentPreset;
  get(id: string): AgentPreset | undefined;
  /** Presets of a project: builtins first, then by name. */
  list(projectId: string): AgentPreset[];
  /** Patches mutable fields (never `builtin`) and bumps `updatedAt`. */
  update(id: string, patch: AgentPresetPatch): AgentPreset | undefined;
  /** Deletes the preset; returns true when a row was removed. */
  delete(id: string): boolean;
  /** Deletes every preset of a project (project delete path). Returns rows removed. */
  deleteAllForProject(projectId: string): number;
}

export interface RunRepo {
  create(run: Run): Run;
  get(id: string): Run | undefined;
  /** Runs for a project (all projects when omitted), newest first. */
  list(projectId?: string, status?: RunStatus): Run[];
  /** Runs linked to a workflow, newest first. */
  listByWorkflow(workflowId: string): Run[];
  updateStatus(id: string, status: RunStatus): Run | undefined;
  /** Patches mutable fields (`status`, `output`, `error`, `iteration`). */
  update(id: string, patch: RunPatch): Run | undefined;
}

export interface StepRunRepo {
  create(stepRun: StepRun): StepRun;
  update(id: string, patch: StepRunPatch): StepRun | undefined;
  /** Step runs belonging to a run, ordered by iteration then id. */
  listByRun(runId: string): StepRun[];
}

export interface EventRepo {
  /** Assigns `seq = max(seq) + 1` for the run atomically; returns the stored event. */
  append(runId: string, event: EventInput): PersistedEvent;
  /** Events for the run with `seq > afterSeq`, in seq order. */
  getSince(runId: string, afterSeq?: number): PersistedEvent[];
  /** Number of events persisted for the run. */
  count(runId: string): number;
  /**
   * Deletes the `count` oldest events of exactly `type` for the run (by
   * ascending seq) and returns how many rows were removed (#104: keeps the
   * persisted `sandbox.log` ring bounded — the caller's in-memory counters
   * stay authoritative because it is the sole writer of that type).
   */
  deleteOldestByType(runId: string, type: string, count: number): number;
  /** Latest persisted `run.status` event for the run, if any (terminal-close detection). */
  lastRunStatus(runId: string): RunStatusEvent | undefined;
}

/** One dashboard activity feed row (#51). */
export interface ActivityRow {
  id: number;
  type: string;
  projectId?: string;
  runId?: string;
  workflowId?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

/** Values of an activity row the repository assigns itself. */
export type ActivityInput = Omit<ActivityRow, "id" | "createdAt">;

export interface ActivityRepo {
  /** Appends a feed row; mints `id` (auto-increment) and `createdAt`. */
  append(entry: ActivityInput): ActivityRow;
  /**
   * Feed page, newest first: rows with `id < beforeId` (all rows when
   * omitted), at most `limit`. The stable cursor is the last returned `id`.
   */
  list(options?: { beforeId?: number; limit?: number }): ActivityRow[];
  /** Most recent feed row referencing the run, if any. */
  latestForRun(runId: string): ActivityRow | undefined;
}

export function createProjectRepo(db: Db): ProjectRepo {
  const toDomain = (row: typeof schema.projects.$inferSelect): Project =>
    ProjectSchema.parse({
      id: row.id,
      path: row.path,
      name: row.name,
      defaultBranch: row.defaultBranch,
      ...(row.remoteUrl === null ? {} : { remoteUrl: row.remoteUrl }),
      ...(row.dirty === null ? {} : { dirty: row.dirty }),
      ...(row.sandboxPolicy === null
        ? {}
        : { sandboxPolicy: ProjectSandboxPolicySchema.parse(row.sandboxPolicy) }),
      createdAt: row.createdAt,
    });

  return {
    create(project) {
      const value = ProjectSchema.parse(project);
      db.insert(schema.projects)
        .values({
          id: value.id,
          path: value.path,
          name: value.name,
          defaultBranch: value.defaultBranch,
          remoteUrl: value.remoteUrl ?? null,
          dirty: value.dirty ?? null,
          sandboxPolicy: value.sandboxPolicy ?? null,
          createdAt: value.createdAt,
        })
        .run();
      return value;
    },
    get(id) {
      const row = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
      return row ? toDomain(row) : undefined;
    },
    getMany(ids) {
      if (ids.length === 0) return [];
      const rows = db.select().from(schema.projects).where(inArray(schema.projects.id, ids)).all();
      return rows.map(toDomain);
    },
    list() {
      const rows = db.select().from(schema.projects).orderBy(schema.projects.createdAt).all();
      return rows.map(toDomain);
    },
    setSandboxPolicy(id, policy) {
      const value = ProjectSandboxPolicySchema.parse(policy);
      const row = db
        .update(schema.projects)
        .set({ sandboxPolicy: value })
        .where(eq(schema.projects.id, id))
        .returning()
        .get();
      return row ? toDomain(row) : undefined;
    },
    delete(id) {
      const result = db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
      return result.changes > 0;
    },
  };
}

export function createWorkflowRepo(db: Db): WorkflowRepo {
  const toDomain = (row: typeof schema.workflows.$inferSelect): Workflow =>
    WorkflowSchema.parse({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      steps: row.steps,
      ...(row.loopBack === null ? {} : { loopBack: row.loopBack }),
      ...(row.latestRevisionNumber === null
        ? {}
        : { latestRevisionNumber: row.latestRevisionNumber }),
    });

  return {
    create(workflow) {
      const value = WorkflowSchema.parse(workflow);
      db.insert(schema.workflows)
        .values({
          id: value.id,
          projectId: value.projectId,
          name: value.name,
          steps: value.steps,
          loopBack: value.loopBack ?? null,
        })
        .run();
      return value;
    },
    get(id) {
      const row = db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).get();
      return row ? toDomain(row) : undefined;
    },
    getMany(ids) {
      if (ids.length === 0) return [];
      const rows = db
        .select()
        .from(schema.workflows)
        .where(inArray(schema.workflows.id, ids))
        .all();
      return rows.map(toDomain);
    },
    list(projectId) {
      const rows = db
        .select()
        .from(schema.workflows)
        .where(projectId ? eq(schema.workflows.projectId, projectId) : undefined)
        .orderBy(schema.workflows.name)
        .all();
      return rows.map(toDomain);
    },
    update(id, patch) {
      const current = db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).get();
      if (!current) return undefined;
      const next = WorkflowSchema.parse({
        id: current.id,
        projectId: current.projectId,
        name: patch.name ?? current.name,
        steps: patch.steps ?? current.steps,
        ...(patch.loopBack === undefined
          ? current.loopBack === null
            ? {}
            : { loopBack: current.loopBack }
          : patch.loopBack === null
            ? {}
            : { loopBack: patch.loopBack }),
        ...(current.latestRevisionNumber === null
          ? {}
          : { latestRevisionNumber: current.latestRevisionNumber }),
      });
      db.update(schema.workflows)
        .set({ name: next.name, steps: next.steps, loopBack: next.loopBack ?? null })
        .where(eq(schema.workflows.id, id))
        .run();
      return next;
    },
    delete(id) {
      const result = db.delete(schema.workflows).where(eq(schema.workflows.id, id)).run();
      return result.changes > 0;
    },
  };
}

export function createWorkflowRevisionRepo(db: Db): WorkflowRevisionRepo {
  const toDomain = (row: typeof schema.workflowRevisions.$inferSelect): WorkflowRevision => ({
    id: row.id,
    workflowId: row.workflowId,
    number: row.number,
    graph: WorkflowGraphSchema.parse(row.graph),
    createdAt: row.createdAt,
  });

  return {
    create(workflowId, graph) {
      const parsed = WorkflowGraphSchema.parse(graph);
      return db.transaction((tx) => {
        const row = tx
          .select({ maxNumber: sql<number | null>`max(${schema.workflowRevisions.number})` })
          .from(schema.workflowRevisions)
          .where(eq(schema.workflowRevisions.workflowId, workflowId))
          .get();
        const number = (row?.maxNumber ?? 0) + 1;
        const revision: WorkflowRevision = {
          id: crypto.randomUUID(),
          workflowId,
          number,
          graph: parsed,
          createdAt: new Date().toISOString(),
        };
        tx.insert(schema.workflowRevisions)
          .values({
            id: revision.id,
            workflowId,
            number,
            graph: revision.graph,
            createdAt: revision.createdAt,
          })
          .run();
        tx.update(schema.workflows)
          .set({ latestRevisionNumber: number })
          .where(eq(schema.workflows.id, workflowId))
          .run();
        return revision;
      });
    },
    get(id) {
      const row = db
        .select()
        .from(schema.workflowRevisions)
        .where(eq(schema.workflowRevisions.id, id))
        .get();
      return row ? toDomain(row) : undefined;
    },
    getMany(ids) {
      if (ids.length === 0) return [];
      const rows = db
        .select()
        .from(schema.workflowRevisions)
        .where(inArray(schema.workflowRevisions.id, ids))
        .all();
      return rows.map(toDomain);
    },
    getByNumber(workflowId, number) {
      const row = db
        .select()
        .from(schema.workflowRevisions)
        .where(
          and(
            eq(schema.workflowRevisions.workflowId, workflowId),
            eq(schema.workflowRevisions.number, number),
          ),
        )
        .get();
      return row ? toDomain(row) : undefined;
    },
    list(workflowId) {
      const rows = db
        .select()
        .from(schema.workflowRevisions)
        .where(eq(schema.workflowRevisions.workflowId, workflowId))
        .orderBy(schema.workflowRevisions.number)
        .all();
      return rows.map(toDomain);
    },
    latest(workflowId) {
      const rows = db
        .select()
        .from(schema.workflowRevisions)
        .where(eq(schema.workflowRevisions.workflowId, workflowId))
        .orderBy(sql`${schema.workflowRevisions.number} desc`)
        .limit(1)
        .all();
      return rows.length > 0
        ? toDomain(rows[0] as typeof schema.workflowRevisions.$inferSelect)
        : undefined;
    },
    deleteAllForWorkflow(workflowId) {
      const result = db
        .delete(schema.workflowRevisions)
        .where(eq(schema.workflowRevisions.workflowId, workflowId))
        .run();
      return result.changes;
    },
  };
}

export function createAgentPresetRepo(db: Db): AgentPresetRepo {
  const toDomain = (row: typeof schema.agentPresets.$inferSelect): AgentPreset =>
    AgentPresetSchema.parse({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      description: row.description,
      ...(row.icon === null ? {} : { icon: row.icon }),
      config: row.config,
      ...(row.builtin ? { builtin: true } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });

  const toRow = (preset: AgentPreset) => ({
    id: preset.id,
    projectId: preset.projectId,
    name: preset.name,
    description: preset.description,
    icon: preset.icon ?? null,
    config: preset.config,
    builtin: preset.builtin === true,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  });

  return {
    create(preset) {
      const value = AgentPresetSchema.parse(preset);
      db.insert(schema.agentPresets).values(toRow(value)).run();
      return value;
    },
    get(id) {
      const row = db.select().from(schema.agentPresets).where(eq(schema.agentPresets.id, id)).get();
      return row ? toDomain(row) : undefined;
    },
    list(projectId) {
      const rows = db
        .select()
        .from(schema.agentPresets)
        .where(eq(schema.agentPresets.projectId, projectId))
        .orderBy(sql`${schema.agentPresets.builtin} desc`, schema.agentPresets.name)
        .all();
      return rows.map(toDomain);
    },
    update(id, patch) {
      const current = db
        .select()
        .from(schema.agentPresets)
        .where(eq(schema.agentPresets.id, id))
        .get();
      if (!current) return undefined;
      const next = AgentPresetSchema.parse({
        id: current.id,
        projectId: current.projectId,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        ...(patch.icon === undefined
          ? current.icon === null
            ? {}
            : { icon: current.icon }
          : patch.icon === null
            ? {}
            : { icon: patch.icon }),
        config: patch.config ?? current.config,
        ...(current.builtin ? { builtin: true } : {}),
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      });
      db.update(schema.agentPresets)
        .set({
          name: next.name,
          description: next.description,
          icon: next.icon ?? null,
          config: next.config,
          updatedAt: next.updatedAt,
        })
        .where(eq(schema.agentPresets.id, id))
        .run();
      return next;
    },
    delete(id) {
      const result = db.delete(schema.agentPresets).where(eq(schema.agentPresets.id, id)).run();
      return result.changes > 0;
    },
    deleteAllForProject(projectId) {
      const result = db
        .delete(schema.agentPresets)
        .where(eq(schema.agentPresets.projectId, projectId))
        .run();
      return result.changes;
    },
  };
}

export function createProjectSecretRepo(db: Db): ProjectSecretRepo {
  return {
    set(projectId, name, valueEnc) {
      const now = new Date().toISOString();
      return db.transaction((tx) => {
        const existing = tx
          .select()
          .from(schema.projectSecrets)
          .where(
            and(
              eq(schema.projectSecrets.projectId, projectId),
              eq(schema.projectSecrets.name, name),
            ),
          )
          .get();
        if (existing !== undefined) {
          const row = tx
            .update(schema.projectSecrets)
            .set({ valueEnc, updatedAt: now })
            .where(eq(schema.projectSecrets.id, existing.id))
            .returning()
            .get();
          return row as typeof schema.projectSecrets.$inferSelect;
        }
        const row = tx
          .insert(schema.projectSecrets)
          .values({
            id: crypto.randomUUID(),
            projectId,
            name,
            valueEnc,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        return row as typeof schema.projectSecrets.$inferSelect;
      });
    },
    delete(projectId, name) {
      const result = db
        .delete(schema.projectSecrets)
        .where(
          and(eq(schema.projectSecrets.projectId, projectId), eq(schema.projectSecrets.name, name)),
        )
        .run();
      return result.changes > 0;
    },
    listNames(projectId) {
      const rows = db
        .select({ name: schema.projectSecrets.name, createdAt: schema.projectSecrets.createdAt })
        .from(schema.projectSecrets)
        .where(eq(schema.projectSecrets.projectId, projectId))
        .orderBy(schema.projectSecrets.name)
        .all();
      return rows;
    },
    get(projectId, name) {
      return (
        db
          .select()
          .from(schema.projectSecrets)
          .where(
            and(
              eq(schema.projectSecrets.projectId, projectId),
              eq(schema.projectSecrets.name, name),
            ),
          )
          .get() ?? undefined
      );
    },
    list(projectId) {
      return db
        .select()
        .from(schema.projectSecrets)
        .where(eq(schema.projectSecrets.projectId, projectId))
        .orderBy(schema.projectSecrets.name)
        .all();
    },
    deleteAllForProject(projectId) {
      const result = db
        .delete(schema.projectSecrets)
        .where(eq(schema.projectSecrets.projectId, projectId))
        .run();
      return result.changes;
    },
  };
}

export function createRunRepo(db: Db): RunRepo {
  const toDomain = (row: typeof schema.runs.$inferSelect): Run =>
    RunSchema.parse({
      id: row.id,
      projectId: row.projectId,
      ...(row.workflowId === null ? {} : { workflowId: row.workflowId }),
      ...(row.workflowRevisionId === null ? {} : { workflowRevisionId: row.workflowRevisionId }),
      status: row.status,
      branch: row.branch,
      iteration: row.iteration,
      ...(row.task === null ? {} : { task: row.task }),
      ...(row.output === null ? {} : { output: row.output }),
      ...(row.error === null ? {} : { error: row.error }),
      ...((row.breadcrumb ?? []).length === 0 ? {} : { breadcrumb: row.breadcrumb ?? [] }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });

  const toRow = (run: Run) => ({
    id: run.id,
    projectId: run.projectId,
    workflowId: run.workflowId ?? null,
    workflowRevisionId: run.workflowRevisionId ?? null,
    status: run.status,
    branch: run.branch,
    iteration: run.iteration,
    task: run.task ?? null,
    output: run.output ?? null,
    error: run.error ?? null,
    breadcrumb: run.breadcrumb ?? [],
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  });

  return {
    create(run) {
      const value = RunSchema.parse(run);
      db.insert(schema.runs).values(toRow(value)).run();
      return value;
    },
    get(id) {
      const row = db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
      return row ? toDomain(row) : undefined;
    },
    list(projectId, status) {
      const filters = [
        ...(projectId ? [eq(schema.runs.projectId, projectId)] : []),
        ...(status ? [eq(schema.runs.status, status)] : []),
      ];
      const rows = db
        .select()
        .from(schema.runs)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(sql`${schema.runs.createdAt} desc`, schema.runs.id)
        .all();
      return rows.map(toDomain);
    },
    listByWorkflow(workflowId) {
      const rows = db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.workflowId, workflowId))
        .orderBy(sql`${schema.runs.createdAt} desc`, schema.runs.id)
        .all();
      return rows.map(toDomain);
    },
    updateStatus(id, status) {
      return this.update(id, { status });
    },
    update(id, patch) {
      const row = db
        .update(schema.runs)
        .set({
          ...(patch.status === undefined ? {} : { status: RunStatusSchema.parse(patch.status) }),
          ...(patch.iteration === undefined ? {} : { iteration: patch.iteration }),
          ...(patch.output === undefined ? {} : { output: patch.output }),
          ...(patch.error === undefined ? {} : { error: patch.error }),
          ...(patch.breadcrumb === undefined
            ? {}
            : { breadcrumb: z.array(BreadcrumbEntrySchema).parse(patch.breadcrumb) }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.runs.id, id))
        .returning()
        .get();
      return row ? toDomain(row) : undefined;
    },
  };
}

export function createStepRunRepo(db: Db): StepRunRepo {
  const toDomain = (row: typeof schema.stepRuns.$inferSelect): StepRun =>
    StepRunSchema.parse({
      id: row.id,
      runId: row.runId,
      stepId: row.stepId,
      iteration: row.iteration,
      ...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
      status: row.status,
      output: row.output,
      ...(row.diff === null ? {} : { diff: row.diff }),
    });

  return {
    create(stepRun) {
      const value = StepRunSchema.parse(stepRun);
      db.insert(schema.stepRuns)
        .values({
          id: value.id,
          runId: value.runId,
          stepId: value.stepId,
          iteration: value.iteration,
          sessionId: value.sessionId ?? null,
          status: value.status,
          output: value.output,
          diff: value.diff ?? null,
        })
        .run();
      return value;
    },
    update(id, patch) {
      const row = db
        .update(schema.stepRuns)
        .set({
          ...(patch.sessionId === undefined ? {} : { sessionId: patch.sessionId }),
          ...(patch.status === undefined ? {} : { status: RunStatusSchema.parse(patch.status) }),
          ...(patch.output === undefined ? {} : { output: patch.output }),
          ...(patch.diff === undefined ? {} : { diff: patch.diff }),
        })
        .where(eq(schema.stepRuns.id, id))
        .returning()
        .get();
      return row ? toDomain(row) : undefined;
    },
    listByRun(runId) {
      const rows = db
        .select()
        .from(schema.stepRuns)
        .where(eq(schema.stepRuns.runId, runId))
        .orderBy(schema.stepRuns.iteration, schema.stepRuns.id)
        .all();
      return rows.map(toDomain);
    },
  };
}

export function createEventRepo(db: Db): EventRepo {
  return {
    append(runId, event) {
      const body: Record<string, unknown> = { ...event };
      delete body["seq"];
      return db.transaction((tx) => {
        const row = tx
          .select({ maxSeq: sql<number | null>`max(${schema.events.seq})` })
          .from(schema.events)
          .where(eq(schema.events.runId, runId))
          .get();
        const seq = (row?.maxSeq ?? 0) + 1;
        const stored = PersistedEventSchema.parse({ ...body, seq });
        tx.insert(schema.events)
          .values({
            runId,
            seq,
            type: stored.type,
            payload: JSON.stringify(body),
            createdAt: new Date().toISOString(),
          })
          .run();
        return stored;
      });
    },
    getSince(runId, afterSeq = 0) {
      const rows = db
        .select()
        .from(schema.events)
        .where(sql`${schema.events.runId} = ${runId} and ${schema.events.seq} > ${afterSeq}`)
        .orderBy(schema.events.seq)
        .all();
      return rows.map((row) =>
        PersistedEventSchema.parse({ ...JSON.parse(row.payload), seq: row.seq }),
      );
    },
    count(runId) {
      const row = db
        .select({ total: sql<number>`count(*)` })
        .from(schema.events)
        .where(eq(schema.events.runId, runId))
        .get();
      return row?.total ?? 0;
    },
    deleteOldestByType(runId, type, count) {
      const limit = Math.max(0, Math.trunc(count));
      if (limit === 0) return 0;
      const oldest = db
        .select({ seq: schema.events.seq })
        .from(schema.events)
        .where(and(eq(schema.events.runId, runId), eq(schema.events.type, type)))
        .orderBy(schema.events.seq)
        .limit(limit)
        .all();
      if (oldest.length === 0) return 0;
      db.delete(schema.events)
        .where(
          and(
            eq(schema.events.runId, runId),
            inArray(
              schema.events.seq,
              oldest.map((row) => row.seq),
            ),
          ),
        )
        .run();
      return oldest.length;
    },
    lastRunStatus(runId) {
      const row = db
        .select()
        .from(schema.events)
        .where(sql`${schema.events.runId} = ${runId} and ${schema.events.type} = 'run.status'`)
        .orderBy(sql`${schema.events.seq} desc`)
        .limit(1)
        .get();
      return row
        ? RunStatusEventSchema.parse({ ...JSON.parse(row.payload), seq: row.seq })
        : undefined;
    },
  };
}

export function createActivityRepo(db: Db): ActivityRepo {
  const toDomain = (row: typeof schema.activity.$inferSelect): ActivityRow => ({
    id: row.id,
    type: row.type,
    ...(row.projectId === null ? {} : { projectId: row.projectId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
    ...(row.workflowId === null ? {} : { workflowId: row.workflowId }),
    ...(row.payload === null ? {} : { payload: row.payload }),
    createdAt: row.createdAt,
  });

  const DEFAULT_LIMIT = 20;
  const MAX_LIMIT = 100;

  return {
    append(entry) {
      const createdAt = new Date().toISOString();
      const row = db
        .insert(schema.activity)
        .values({
          type: entry.type,
          projectId: entry.projectId ?? null,
          runId: entry.runId ?? null,
          workflowId: entry.workflowId ?? null,
          payload: entry.payload ?? null,
          createdAt,
        })
        .returning()
        .get();
      return toDomain(row);
    },
    list(options) {
      const limit = Math.min(Math.max(options?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      const rows = db
        .select()
        .from(schema.activity)
        .where(
          options?.beforeId === undefined
            ? undefined
            : sql`${schema.activity.id} < ${options.beforeId}`,
        )
        .orderBy(sql`${schema.activity.id} desc`)
        .limit(limit)
        .all();
      return rows.map(toDomain);
    },
    latestForRun(runId) {
      const row = db
        .select()
        .from(schema.activity)
        .where(eq(schema.activity.runId, runId))
        .orderBy(sql`${schema.activity.id} desc`)
        .limit(1)
        .get();
      return row === undefined ? undefined : toDomain(row);
    },
  };
}
