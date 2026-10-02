import { TERMINAL_RUN_STATUSES } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import type { WorktreeManager } from "@openeuler/engine";
import { recordRecoverySweepActivity, recordRunStatusActivity } from "./activity.js";
import type { Executor } from "./executor.js";
import type { Logger } from "./logger.js";
import { redactorForProject } from "./secrets.js";

/** What {@link sweepInterruptedRuns} found and settled on this boot. */
export interface SweepResult {
  /** Runs transitioned to `interrupted`, in sweep order. */
  interruptedRunIds: string[];
  /** Orphaned worktree paths reported by `WorktreeManager.pruneAll()` (report-only). */
  orphanedWorktrees: string[];
}

export interface SweepOptions {
  db: Db;
  worktrees: WorktreeManager;
  executor: Executor;
  logger: Logger;
  /**
   * Master key for per-project secrets (#93). When set, the sweep's
   * activity payloads are redacted against the run's project secrets;
   * unset = no secrets configured, payloads pass through unchanged.
   */
  secretsKey?: Buffer;
}

/**
 * Crash-safety boot sweep: any run left `running`/`queued` by a previous
 * daemon process (its executor — and every child process — is gone by
 * definition after a restart) is marked `interrupted`, its non-terminal
 * StepRuns settle to `interrupted`, and a `run.status` event is persisted so
 * SSE replay shows the transition. Runs still live in THIS executor (the
 * sweep also runs in tests against a warm executor) are left alone.
 *
 * Also prunes git worktree metadata across every referenced repo and reports
 * orphaned worktree paths in the log — report-only, nothing is deleted; a
 * later `WorktreeManager.remove(runId)` can still clean them up.
 */
export async function sweepInterruptedRuns(options: SweepOptions): Promise<SweepResult> {
  const { db, worktrees, executor, logger } = options;
  const active = new Set(executor.activeRunIds());

  const interruptedRunIds: string[] = [];
  for (const status of ["running", "queued"] as const) {
    for (const run of db.runs.list(undefined, status)) {
      if (active.has(run.id)) continue;
      db.runs.update(run.id, { status: "interrupted" });
      for (const stepRun of db.stepRuns.listByRun(run.id)) {
        if (!(TERMINAL_RUN_STATUSES as readonly string[]).includes(stepRun.status)) {
          db.stepRuns.update(stepRun.id, { status: "interrupted" });
        }
      }
      db.events.append(run.id, { type: "run.status", status: "interrupted" });
      // #93: the activity payload snapshots the run's task — rows written
      // before redaction-at-rest may still carry a secret, so scrub it.
      // Transform construction never throws; a decrypt failure surfaces
      // inside the activity writer's own never-throw guard (the feed entry
      // is lost, never persisted raw — fail-closed).
      recordRunStatusActivity(
        db,
        run.id,
        "interrupted",
        redactorForProject(db, options.secretsKey, run.projectId),
      );
      logger.info({ runId: run.id, priorStatus: status }, "run interrupted by daemon restart");
      interruptedRunIds.push(run.id);
    }
  }

  const orphanedWorktrees = await worktrees.pruneAll();
  if (orphanedWorktrees.length > 0) {
    logger.warn(
      { orphanedWorktrees },
      "orphaned worktrees detected (report-only; not removed automatically)",
    );
  }

  // #94: the sweep itself is an ops event — the feed shows every boot's
  // recovery outcome, zero counts included.
  recordRecoverySweepActivity(db, {
    interrupted: interruptedRunIds.length,
    orphanedWorktrees: orphanedWorktrees.length,
  });

  return { interruptedRunIds, orphanedWorktrees };
}
