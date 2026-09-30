import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  AgentEventSchema,
  ProjectSchema,
  RunSchema,
  RunStatusSchema,
  StepRunSchema,
  WorkflowSchema,
} from "@openeuler/core";
import type { AgentEvent, Project, Run, RunStatus, StepRun, Workflow } from "@openeuler/core";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * An `AgentEvent` without its `seq` — the database owns sequence assignment.
 * Values of type `AgentEvent` remain assignable (the extra `seq` key is simply
 * ignored), so transport events can be passed straight through.
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type AgentEventInput = DistributiveOmit<AgentEvent, "seq">;

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
  list(): Project[];
  /** Deletes the project; returns true when a row was removed. */
  delete(id: string): boolean;
}

export interface WorkflowRepo {
  create(workflow: Workflow): Workflow;
  get(id: string): Workflow | undefined;
  /** Workflows for a project, ordered by name. */
  list(projectId?: string): Workflow[];
}

export interface RunRepo {
  create(run: Run): Run;
  get(id: string): Run | undefined;
  /** Runs for a project (all projects when omitted), newest first. */
  list(projectId?: string): Run[];
  updateStatus(id: string, status: RunStatus): Run | undefined;
}

export interface StepRunRepo {
  create(stepRun: StepRun): StepRun;
  update(id: string, patch: StepRunPatch): StepRun | undefined;
}

export interface EventRepo {
  /** Assigns `seq = max(seq) + 1` for the run atomically; returns the stored event. */
  append(runId: string, event: AgentEventInput): AgentEvent;
  /** Events for the run with `seq > afterSeq`, in seq order. */
  getSince(runId: string, afterSeq?: number): AgentEvent[];
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
          createdAt: value.createdAt,
        })
        .run();
      return value;
    },
    get(id) {
      const row = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
      return row ? toDomain(row) : undefined;
    },
    list() {
      const rows = db.select().from(schema.projects).orderBy(schema.projects.createdAt).all();
      return rows.map(toDomain);
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
    list(projectId) {
      const rows = db
        .select()
        .from(schema.workflows)
        .where(projectId ? eq(schema.workflows.projectId, projectId) : undefined)
        .orderBy(schema.workflows.name)
        .all();
      return rows.map(toDomain);
    },
  };
}

export function createRunRepo(db: Db): RunRepo {
  const toDomain = (row: typeof schema.runs.$inferSelect): Run =>
    RunSchema.parse({
      id: row.id,
      projectId: row.projectId,
      ...(row.workflowId === null ? {} : { workflowId: row.workflowId }),
      status: row.status,
      branch: row.branch,
      iteration: row.iteration,
      ...(row.task === null ? {} : { task: row.task }),
      ...(row.output === null ? {} : { output: row.output }),
      ...(row.error === null ? {} : { error: row.error }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });

  const toRow = (run: Run) => ({
    id: run.id,
    projectId: run.projectId,
    workflowId: run.workflowId ?? null,
    status: run.status,
    branch: run.branch,
    iteration: run.iteration,
    task: run.task ?? null,
    output: run.output ?? null,
    error: run.error ?? null,
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
    list(projectId) {
      const rows = db
        .select()
        .from(schema.runs)
        .where(projectId ? eq(schema.runs.projectId, projectId) : undefined)
        .orderBy(sql`${schema.runs.createdAt} desc`, schema.runs.id)
        .all();
      return rows.map(toDomain);
    },
    updateStatus(id, status) {
      const value = RunStatusSchema.parse(status);
      const row = db
        .update(schema.runs)
        .set({ status: value, updatedAt: new Date().toISOString() })
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
        const stored = AgentEventSchema.parse({ ...body, seq });
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
        AgentEventSchema.parse({ ...JSON.parse(row.payload), seq: row.seq }),
      );
    },
  };
}
