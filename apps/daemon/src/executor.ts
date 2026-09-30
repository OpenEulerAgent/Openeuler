import type { RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import type { AgentHandle, DriverRegistry } from "@openeuler/drivers";
import { createFlowEngine, DEFAULT_DRIVER_ID } from "@openeuler/engine";
import type { WorktreeManager } from "@openeuler/engine";
import type { Logger } from "./logger.js";

export { DEFAULT_DRIVER_ID };

/** Extra per-run execution options not persisted on the Run row (v1). */
export interface StartRunOptions {
  model?: string;
  mode?: "auto" | "ask";
}

/** Outcome of {@link Executor.abortRun}; routes map this to HTTP statuses. */
export type AbortRunResult =
  | { outcome: "aborted" }
  | { outcome: "not_found" }
  | { outcome: "not_abortable"; status: RunStatus };

export interface Executor {
  /**
   * Begins background execution of a queued run. Never throws and never
   * blocks: all failures are captured into the run row (`failed` + error).
   */
  startRun(runId: string, opts?: StartRunOptions): void;
  /**
   * Aborts a queued/running run: calls `handle.abort()` when the agent already
   * started, otherwise marks the run aborted directly. Driver abort failures
   * propagate to the caller (routes map them to 5xx).
   */
  abortRun(runId: string): Promise<AbortRunResult>;
  /** Ids of runs currently executing (queued/running bookkeeping in memory). */
  activeRunIds(): string[];
  /** Best-effort graceful stop: aborts active runs and waits briefly for them. */
  shutdown(): Promise<void>;
}

export interface ExecutorOptions {
  db: Db;
  worktrees: WorktreeManager;
  drivers: DriverRegistry;
  logger: Logger;
  /** Driver used for ad-hoc runs; defaults to `OPENEULER_DRIVER`, then `"fake"`. */
  driverId?: string;
  /** How long {@link Executor.shutdown} waits for active runs to settle. */
  shutdownSettleMs?: number;
}

interface ActiveRun {
  runId: string;
  /** Live driver handle of the step currently executing, if any. */
  handle?: AgentHandle;
  abortRequested: boolean;
  done: Promise<void>;
}

const TERMINAL_STATUSES = new Set<RunStatus>(["success", "failed", "aborted", "interrupted"]);

const isTerminal = (status: RunStatus): boolean => TERMINAL_STATUSES.has(status);

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Schedules runs for background execution and owns the live-run bookkeeping
 * (abort, shutdown, duplicate-start guards). The actual multi-step execution
 * — worktree, prompt templating, step runs, event persistence — lives in the
 * flow engine (`@openeuler/engine`); this wrapper keeps the daemon-specific
 * lifecycle concerns out of the HTTP layer: routes only call
 * `startRun`/`abortRun`, and the engine never throws into callers.
 */
export function createExecutor(options: ExecutorOptions): Executor {
  const { db, worktrees, drivers, logger } = options;
  const driverId = options.driverId ?? process.env["OPENEULER_DRIVER"] ?? DEFAULT_DRIVER_ID;
  const shutdownSettleMs = options.shutdownSettleMs ?? 2_000;
  const active = new Map<string, ActiveRun>();
  const engine = createFlowEngine({ db, worktrees, drivers, logger });

  function failRun(runId: string, message: string): void {
    logger.error({ runId, error: message }, "run failed");
    try {
      const run = db.runs.get(runId);
      if (!run || isTerminal(run.status)) return;
      db.runs.update(runId, { status: "failed", error: message });
    } catch (err) {
      logger.error({ err, runId }, "marking run failed failed");
    }
  }

  async function execute(entry: ActiveRun, opts: StartRunOptions | undefined): Promise<void> {
    const { runId } = entry;
    try {
      await engine.executeRun(
        runId,
        {
          isAbortRequested: () => entry.abortRequested,
          onHandle: (handle) => {
            entry.handle = handle;
          },
        },
        { driverId, ...opts },
      );
    } catch (err) {
      // Belt and braces: the engine funnels failures into the run row itself.
      failRun(runId, describeError(err));
    } finally {
      active.delete(runId);
    }
  }

  function startRun(runId: string, opts?: StartRunOptions): void {
    const existing = active.get(runId);
    if (existing) {
      logger.warn({ runId }, "startRun ignored: run is already executing");
      return;
    }
    const entry: ActiveRun = {
      runId,
      abortRequested: false,
      done: Promise.resolve(),
    };
    // Deferred so the HTTP response for POST /api/runs is not interleaved with
    // the engine's first (synchronous) bookkeeping steps.
    entry.done = Promise.resolve()
      .then(() => execute(entry, opts))
      .catch((err: unknown) => {
        logger.error({ err, runId }, "executor crashed unexpectedly");
        failRun(runId, describeError(err));
        active.delete(runId);
      });
    active.set(runId, entry);
  }

  async function abortRun(runId: string): Promise<AbortRunResult> {
    const run = db.runs.get(runId);
    if (!run) return { outcome: "not_found" };
    if (isTerminal(run.status)) {
      return { outcome: "not_abortable", status: run.status };
    }

    const entry = active.get(runId);
    if (!entry) {
      // Queued but never handed to the executor (or lost across a restart).
      db.runs.updateStatus(runId, "aborted");
      for (const step of db.stepRuns.listByRun(runId)) {
        db.stepRuns.update(step.id, { status: "aborted" });
      }
      logger.info({ runId }, "run aborted before start");
      return { outcome: "aborted" };
    }

    entry.abortRequested = true;
    if (entry.handle) {
      await entry.handle.abort();
    }
    const current = db.runs.get(runId);
    if (current && !isTerminal(current.status)) {
      db.runs.updateStatus(runId, "aborted");
    }
    logger.info({ runId }, "run aborted");
    return { outcome: "aborted" };
  }

  async function shutdown(): Promise<void> {
    const entries = [...active.values()];
    if (entries.length === 0) return;
    logger.info({ runs: entries.map((entry) => entry.runId) }, "executor shutdown: aborting runs");
    for (const entry of entries) {
      entry.abortRequested = true;
      await entry.handle?.abort().catch(() => {});
      const run = db.runs.get(entry.runId);
      if (run && !isTerminal(run.status)) {
        db.runs.updateStatus(entry.runId, "aborted");
      }
    }
    await Promise.race([
      Promise.allSettled(entries.map((entry) => entry.done)),
      delay(shutdownSettleMs),
    ]);
    logger.info("executor shutdown complete");
  }

  return {
    startRun,
    abortRun,
    shutdown,
    activeRunIds: () => [...active.keys()],
  };
}
