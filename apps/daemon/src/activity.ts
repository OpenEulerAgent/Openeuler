import type { Project, RunStatus, Workflow } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { TERMINAL_RUN_STATUSES } from "@openeuler/core";

/**
 * Activity feed writers (#51). The feed is an append-only `activity` table
 * (see `@openeuler/db`) with one row per interesting cross-entity
 * transition; this module is the single place that decides WHICH transitions
 * are interesting and WHAT payload each carries. Reads live in
 * `routes/activity.ts`.
 */

export type ActivityType =
  | "project.created"
  | "workflow.created"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.aborted"
  | "run.interrupted";

/** Map a run status to its feed type; `queued` never enters the feed. */
export function runActivityType(status: RunStatus): ActivityType | null {
  switch (status) {
    case "running":
      return "run.started";
    case "success":
      return "run.completed";
    case "failed":
      return "run.failed";
    case "aborted":
      return "run.aborted";
    case "interrupted":
      return "run.interrupted";
    default:
      return null;
  }
}

export function isTerminalStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * Records a run transition when it is feed-worthy (started or terminal).
 * Reads the run row for denormalized ids + a small payload snapshot
 * (branch/task), so the feed survives later run-row mutations. A terminal
 * transition equal to the run's latest feed entry is skipped: the executor
 * terminalizes the row directly when an abort races the engine (e.g. the
 * driver stalls mid-stream), and the engine's later closing event must not
 * duplicate the feed entry. Never throws into the caller: a failed append
 * is a lost feed entry, not a lost run.
 */
export function recordRunStatusActivity(db: Db, runId: string, status: RunStatus): void {
  const type = runActivityType(status);
  if (type === null) return;
  try {
    const run = db.runs.get(runId);
    if (run === undefined) return;
    if (isTerminalStatus(status)) {
      const latest = db.activity.latestForRun(runId);
      if (latest !== undefined && latest.type === type) return;
    }
    db.activity.append({
      type,
      projectId: run.projectId,
      runId: run.id,
      ...(run.workflowId === undefined ? {} : { workflowId: run.workflowId }),
      payload: {
        status,
        branch: run.branch,
        ...(run.task === undefined || run.task.length === 0 ? {} : { task: run.task }),
      },
    });
  } catch {
    // Feed appends must never break the transition itself.
  }
}

/**
 * Records the project registration. Never throws into the caller (same
 * guard as {@link recordRunStatusActivity}): a failed append is a lost feed
 * entry, not a lost project.
 */
export function recordProjectCreatedActivity(db: Db, project: Project): void {
  try {
    db.activity.append({ type: "project.created", projectId: project.id });
  } catch {
    // Feed appends must never break the registration itself.
  }
}

/**
 * Records the workflow creation. Never throws into the caller (same guard
 * as {@link recordRunStatusActivity}): a failed append is a lost feed
 * entry, not a lost workflow.
 */
export function recordWorkflowCreatedActivity(db: Db, workflow: Workflow): void {
  try {
    db.activity.append({
      type: "workflow.created",
      projectId: workflow.projectId,
      workflowId: workflow.id,
    });
  } catch {
    // Feed appends must never break the workflow creation itself.
  }
}
