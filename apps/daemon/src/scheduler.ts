import { nextCronRunMs, parseCron } from "@openeuler/core";
import type { Db, WorkflowScheduleRow } from "@openeuler/db";
import type { Logger } from "./logger.js";
import { recordScheduleSkippedActivity } from "./activity.js";
import type { Executor } from "./executor.js";
import { createAndStartWorkflowRun } from "./routes/workflows.js";
import type { Workflow } from "@openeuler/core";

/**
 * Workflow schedule ticker (#121): every minute, advance each enabled
 * schedule's missed-tick cursor and mint at most one run per due schedule.
 *
 * Semantics (explicit, on purpose):
 *
 * - **Due slots.** A slot is the newest scheduled minute that is `>
 *   lastFiredAt` (or the schedule's creation time, for a fresh schedule)
 *   and `<= now`. Multiple missed minutes coalesce into ONE run — the
 *   newest slot fires, older slots are deliberately dropped (a daemon that
 *   was down for an hour fires once, not once per missed tick).
 * - **Fresh schedules never backfill.** With no `lastFiredAt`, the cursor
 *   starts at the schedule's `createdAt`, so a schedule created at 09:37
 *   for `30 9 * * *` first fires the NEXT day, not for this morning.
 * - **Active-run skip.** When the workflow has a run in `queued`/`running`
 *   (a run paused at an approval gate is still `running`), the slot is
 *   dropped with an `ops.schedule-skipped` feed event and the cursor still
 *   advances — the next scheduled minute gets its chance.
 * - **Timezone.** The cron is evaluated in the schedule's IANA zone's wall
 *   clock via `Intl`; DST gap wall times never match (see core/cron).
 * - **Restart + shutdown.** The cursor is persisted, so a restart resumes
 *   exactly where the previous process left off (with the one-run
 *   coalescing above). `stop()` just clears the timer; runs already handed
 *   to the executor are ordinary runs and survive like any other.
 */

/** Tick interval. Default 1min (#121). */
export const DEFAULT_SCHEDULE_TICK_MS = 60_000;

/** One tick outcome. */
export interface ScheduleTickCounts {
  /** Runs minted for due slots. */
  fired: number;
  /** Due slots dropped because the workflow had an active run. */
  skipped: number;
  /** Enabled schedules with no slot due. */
  idle: number;
}

export interface ScheduleTickerDeps {
  db: Db;
  executor: Executor;
  logger: Logger;
  /** Secret master key (#93): scheduled runs redact like any other. */
  secretsKey: Buffer | undefined;
  /** Injectable clock (fake clock in tests); default `Date.now`. */
  now?: () => number;
}

/** Runs the workflow if it has no queued/running run; returns the active run otherwise. */
function activeRunOf(db: Db, workflowId: string): { id: string } | undefined {
  for (const run of db.runs.listByWorkflow(workflowId)) {
    if (run.status === "queued" || run.status === "running") return run;
  }
  return undefined;
}

/**
 * Finds the slot to act on: the NEWEST scheduled minute in
 * `(cursor, currentMinute]`, or undefined when the schedule is not due.
 */
export function dueSlotMs(
  schedule: Pick<WorkflowScheduleRow, "cron" | "timezone" | "lastFiredAt" | "createdAt">,
  currentMinuteMs: number,
): number | undefined {
  const parsed = parseCron(schedule.cron);
  if (!parsed.ok) return undefined;
  const cursorMs = Date.parse(schedule.lastFiredAt ?? schedule.createdAt);
  if (!Number.isFinite(cursorMs)) return undefined;
  let slot: number | undefined;
  let probe = cursorMs;
  for (let guard = 0; guard < 10_000; guard++) {
    const next = nextCronRunMs(parsed.value, probe, schedule.timezone);
    if (next === null || next > currentMinuteMs) break;
    slot = next;
    probe = next;
  }
  return slot;
}

/** One ticker pass over every enabled schedule. Never throws. */
export function runScheduleTick(deps: ScheduleTickerDeps): ScheduleTickCounts {
  const now = deps.now ?? Date.now;
  const counts: ScheduleTickCounts = { fired: 0, skipped: 0, idle: 0 };
  const currentMinute = Math.floor(now() / 60_000) * 60_000;
  let schedules: WorkflowScheduleRow[];
  try {
    schedules = deps.db.workflowSchedules.listEnabled();
  } catch (err) {
    deps.logger.warn({ err }, "schedule tick: listing schedules failed");
    return counts;
  }
  for (const schedule of schedules) {
    try {
      const slot = dueSlotMs(schedule, currentMinute);
      if (slot === undefined) {
        counts.idle += 1;
        continue;
      }
      const workflow: Workflow | undefined = deps.db.workflows.get(schedule.workflowId);
      if (workflow === undefined) {
        deps.logger.warn(
          { scheduleId: schedule.id, workflowId: schedule.workflowId },
          "schedule tick: workflow missing — schedule skipped",
        );
        continue;
      }
      const slotIso = new Date(slot).toISOString();
      const active = activeRunOf(deps.db, workflow.id);
      if (active !== undefined) {
        recordScheduleSkippedActivity(deps.db, {
          workflowId: workflow.id,
          cron: schedule.cron,
          minute: slotIso,
          activeRunId: active.id,
        });
        deps.db.workflowSchedules.update(schedule.id, { lastFiredAt: slotIso });
        counts.skipped += 1;
        deps.logger.info(
          {
            workflowId: workflow.id,
            scheduleId: schedule.id,
            minute: slotIso,
            activeRunId: active.id,
          },
          "scheduled run skipped — workflow still has an active run",
        );
        continue;
      }
      const { run } = createAndStartWorkflowRun({
        db: deps.db,
        executor: deps.executor,
        secretsKey: deps.secretsKey,
        workflow,
        task: schedule.taskTemplate,
      });
      deps.db.workflowSchedules.update(schedule.id, { lastFiredAt: slotIso });
      counts.fired += 1;
      deps.logger.info(
        { workflowId: workflow.id, scheduleId: schedule.id, runId: run.id, minute: slotIso },
        "scheduled run started",
      );
    } catch (err) {
      // One bad schedule must never kill the tick for the others; the
      // cursor stays put, so the slot retries next tick.
      deps.logger.warn(
        { err, scheduleId: schedule.id, workflowId: schedule.workflowId },
        "schedule tick: handling a schedule failed",
      );
    }
  }
  return counts;
}

export interface ScheduleTickerOptions extends ScheduleTickerDeps {
  /** Tick interval. Default {@link DEFAULT_SCHEDULE_TICK_MS}. */
  intervalMs?: number;
}

export interface ScheduleTicker {
  /** One immediate tick (tests + manual triggers). */
  runNow(): ScheduleTickCounts;
  /** Clears the interval timer; idempotent, registered on shutdown. */
  stop(): void;
}

/**
 * Starts the periodic schedule ticker (#121): every `intervalMs` (default
 * 1min, timer unref'd) one {@link runScheduleTick} pass. Overlapping ticks
 * are skipped (a slow pass must not pile up on itself).
 */
export function startScheduleTicker(options: ScheduleTickerOptions): ScheduleTicker {
  const intervalMs = options.intervalMs ?? DEFAULT_SCHEDULE_TICK_MS;
  let running = true;
  let inFlight = false;
  const tick = (): ScheduleTickCounts => {
    if (!running || inFlight) return { fired: 0, skipped: 0, idle: 0 };
    inFlight = true;
    try {
      return runScheduleTick(options);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => {
    tick();
  }, intervalMs);
  timer.unref?.();
  return {
    runNow: tick,
    stop: () => {
      if (!running) return;
      running = false;
      clearInterval(timer);
    },
  };
}
