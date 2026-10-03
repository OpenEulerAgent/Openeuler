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
  | "run.interrupted"
  | OpsActivityType;

/**
 * Daemon-level ops events (#94): system lines in the feed (no project, no
 * run) emitted by boot/recovery/GC machinery. `ops.gc` is written by M6's
 * sandbox GC; the helper exists so the feed rendering is final now.
 * `ops.image-pull` / `ops.image-build` (#100) record image-job completions.
 */
export type OpsActivityType =
  | "ops.daemon-boot"
  | "ops.recovery-sweep"
  | "ops.gc"
  | "ops.image-pull"
  | "ops.image-build"
  | "ops.sandbox-kept";

/** True for `ops.*` rows: rendered as small gray system lines in the web feed. */
export function isOpsActivityType(type: ActivityType): type is OpsActivityType {
  return type.startsWith("ops.");
}

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
 *
 * `redact` (#93), when provided, scrubs secret values from the payload's
 * free text (`task`) before it is persisted.
 */
export function recordRunStatusActivity(
  db: Db,
  runId: string,
  status: RunStatus,
  redact?: (text: string) => string,
): void {
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
        ...(run.task === undefined || run.task.length === 0
          ? {}
          : { task: redact === undefined ? run.task : redact(run.task) }),
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

/**
 * Records the daemon boot (`ops.daemon-boot`, #94) with the running
 * version. Never throws into the caller: a failed append is a lost feed
 * entry, not a lost boot.
 */
export function recordDaemonBootActivity(db: Db, version: string): void {
  try {
    db.activity.append({ type: "ops.daemon-boot", payload: { version } });
  } catch {
    // Feed appends must never break the boot itself.
  }
}

/** Payload snapshot of {@link recordRecoverySweepActivity}. */
export interface RecoverySweepActivityPayload {
  /** Runs the sweep transitioned to `interrupted`. */
  interrupted: number;
  /** Orphaned worktree paths reported (report-only, nothing deleted). */
  orphanedWorktrees: number;
}

/**
 * Records the boot recovery sweep outcome (`ops.recovery-sweep`, #94).
 * Same never-throw guard as the other writers.
 */
export function recordRecoverySweepActivity(db: Db, payload: RecoverySweepActivityPayload): void {
  try {
    db.activity.append({ type: "ops.recovery-sweep", payload: { ...payload } });
  } catch {
    // Feed appends must never break the sweep itself.
  }
}

/**
 * Records a garbage-collection pass (`ops.gc`, #94/#105): sandbox counts
 * (`destroyed`/`kept`/`orphans`/`cacheVolumesPruned`), a disk-pressure
 * `warning`, or a project-delete cache-volume cleanup (`reason`:
 * "project-delete"). Same never-throw guard as the other writers.
 */
export function recordGcActivity(db: Db, payload: Record<string, unknown> = {}): void {
  try {
    db.activity.append({ type: "ops.gc", payload });
  } catch {
    // Feed appends must never break the GC pass itself.
  }
}

/** Payload of {@link recordSandboxKeptActivity} (#102). */
export interface SandboxKeptActivityPayload {
  /** Run whose sandbox was kept. */
  runId: string;
  /** Container id/name to remove manually when debugging is done. */
  container: string;
  /** Image the sandbox runs. */
  image: string;
}

/**
 * Records that a run's sandbox was kept for debugging (`ops.sandbox-kept`,
 * #102 `policy.keepForDebug`) — the feed is the reminder to remove the
 * container manually. Same never-throw guard as the other writers.
 */
export function recordSandboxKeptActivity(db: Db, payload: SandboxKeptActivityPayload): void {
  try {
    db.activity.append({ type: "ops.sandbox-kept", runId: payload.runId, payload: { ...payload } });
  } catch {
    // Feed appends must never break the run's terminal transition.
  }
}

/** Payload of an image-job completion event (#100). */
export interface ImageJobActivityPayload {
  /** Pulled ref or built `openeuler/<name>:latest` tag. */
  ref: string;
  /** Build name (`ops.image-build` only). */
  name?: string;
  /** True when the job finished successfully. */
  done: boolean;
  /** Failure message when `done` is false. */
  error?: string;
}

/**
 * Records an image pull/build completion (`ops.image-pull` / `ops.image-build`,
 * #100). One event per job, emitted at completion (no per-line progress).
 * Same never-throw guard as the other writers.
 */
export function recordImageJobActivity(
  db: Db | undefined,
  type: "ops.image-pull" | "ops.image-build",
  payload: ImageJobActivityPayload,
): void {
  if (db === undefined) return;
  try {
    db.activity.append({
      type,
      payload: { ...payload, ...(payload.error === undefined ? {} : { error: payload.error }) },
    });
  } catch {
    // Feed appends must never break the image job itself.
  }
}
