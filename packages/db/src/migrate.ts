import { linearToGraph } from "@openeuler/core";
import type { Db } from "./index.js";

export interface LinearMigrationResult {
  /** Workflows that got their first graph revision snapshot. */
  migrated: string[];
  /** Workflows skipped because they already have revisions (idempotency). */
  skipped: string[];
}

/**
 * Legacy → graph migration, invoked at daemon startup: every workflow that
 * still has no revisions gets revision 1 — its `steps` + optional `loopBack`
 * translated by {@link linearToGraph} into an equivalent chain graph with a
 * conditional loop-back edge. Idempotent: workflows with revisions are
 * untouched, so re-running against a migrated db changes nothing.
 */
export function migrateLinearWorkflowsToGraphs(db: Db): LinearMigrationResult {
  const migrated: string[] = [];
  const skipped: string[] = [];
  for (const workflow of db.workflows.list()) {
    if (db.workflowRevisions.list(workflow.id).length > 0) {
      skipped.push(workflow.id);
      continue;
    }
    db.workflowRevisions.create(
      workflow.id,
      linearToGraph({ steps: workflow.steps, loopBack: workflow.loopBack }),
    );
    migrated.push(workflow.id);
  }
  return { migrated, skipped };
}
