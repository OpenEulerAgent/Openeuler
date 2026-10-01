import type { RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import type { AgentHandle, DriverRegistry } from "@openeuler/drivers";
import { createFlowEngine, DEFAULT_DRIVER_ID } from "@openeuler/engine";
import type { WorktreeManager } from "@openeuler/engine";
import pLimit from "p-limit";
import { recordRunStatusActivity } from "./activity.js";
import { DEFAULT_MAX_CONCURRENT_RUNS, resolveMaxConcurrentRuns } from "./concurrency.js";
import type { Logger } from "./logger.js";

export { DEFAULT_DRIVER_ID };

export { DEFAULT_MAX_CONCURRENT_RUNS, resolveMaxConcurrentRuns };

/**
 * One global run-status transition, broadcast on the executor's listener
 * bus (#51): pushed on `GET /api/runs/stream`, recorded into the activity
 * feed when feed-worthy. `projectId` lets dashboards bucket without a row
 * fetch; `workflowRevision` resolves the run's pinned graph snapshot.
 */
export interface RunStatusNotification {
  runId: string;
  status: RunStatus;
  projectId: string;
  workflowRevision?: { id: string; number: number };
}

export type RunStatusListener = (event: RunStatusNotification) => void;

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
   * The run waits in the scheduler (staying `queued`) until both its
   * project's turn and a global concurrency slot are free.
   */
  startRun(runId: string, opts?: StartRunOptions): void;
  /**
   * Aborts a queued/running run: calls `handle.abort()` when the agent already
   * started, otherwise marks the run aborted directly (a run still waiting in
   * the scheduler is dropped from the queue without ever starting). Driver
   * abort failures propagate to the caller (routes map them to 5xx).
   */
  abortRun(runId: string): Promise<AbortRunResult>;
  /** Ids of runs currently executing or queued in the scheduler (in memory). */
  activeRunIds(): string[];
  /**
   * Subscribes to every global run-status transition (queued admission,
   * running start, terminal) — the bus behind `GET /api/runs/stream` (#51).
   * Returns an unsubscribe function.
   */
  onRunStatus(listener: RunStatusListener): () => void;
  /** Configured global concurrency cap (`MAX_CONCURRENT_RUNS`). */
  maxConcurrentRuns: number;
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
  /**
   * How many runs may execute at once (global semaphore). Defaults to
   * `$MAX_CONCURRENT_RUNS` (integer >= 1), then
   * {@link DEFAULT_MAX_CONCURRENT_RUNS}.
   */
  maxConcurrentRuns?: number;
  /** How long {@link Executor.shutdown} waits for active runs to settle. */
  shutdownSettleMs?: number;
}

interface ActiveRun {
  runId: string;
  /** Project whose gate serializes this run against siblings. */
  projectId: string;
  /** Live driver handle of the step currently executing, if any. */
  handle?: AgentHandle;
  abortRequested: boolean;
  done: Promise<void>;
}

/**
 * Per-project serialization gate: at most one run per project is scheduled at
 * a time. `holderRunId` is the run currently occupying the project's turn;
 * `waiters` are later runs for the same project, FIFO by start order.
 */
interface ProjectGate {
  holderRunId: string;
  waiters: Array<{ runId: string; resolve: () => void }>;
}

const TERMINAL_STATUSES = new Set<RunStatus>(["success", "failed", "aborted", "interrupted"]);

const isTerminal = (status: RunStatus): boolean => TERMINAL_STATUSES.has(status);

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `{ workflowRevision: { id, number } }` slice for a pinned run, if resolvable. */
function revisionRef(
  db: Db,
  workflowRevisionId: string | undefined,
): { workflowRevision?: { id: string; number: number } } {
  if (workflowRevisionId === undefined) return {};
  const revision = db.workflowRevisions.get(workflowRevisionId);
  return revision === undefined
    ? {}
    : { workflowRevision: { id: revision.id, number: revision.number } };
}

/**
 * Schedules runs for background execution and owns the live-run bookkeeping
 * (abort, shutdown, duplicate-start guards) plus the concurrency scheduler:
 *
 * - **Global semaphore** — a `p-limit(concurrency)` gate caps how many runs
 *   execute at once (`MAX_CONCURRENT_RUNS`, default 2). Runs awaiting a slot
 *   simply stay `queued` in the db; the engine only flips them to `running`
 *   once the slot is acquired and execution starts.
 * - **Per-project serialization** — before joining the global queue a run
 *   must also hold its project's gate (only one active run per project at a
 *   time; a second run for the same project waits — `queued` — until the
 *   first is terminal). The gate is a `Map<projectId, gate>` released when
 *   the run leaves the scheduler, so different projects still run in
 *   parallel up to the global cap.
 *
 * Lock order is always project-gate → global-slot (executing runs never wait
 * on a gate), so the two layers cannot deadlock. The actual multi-step
 * execution — worktree, prompt templating, step runs, event persistence —
 * lives in the flow engine (`@openeuler/engine`) and stays isolated per
 * runId (one worktree/branch per run, no shared mutable executor state);
 * this wrapper keeps the daemon-specific lifecycle concerns out of the HTTP
 * layer: routes only call `startRun`/`abortRun`, and the engine never throws
 * into callers.
 */
export function createExecutor(options: ExecutorOptions): Executor {
  const { db, worktrees, drivers, logger } = options;
  const driverId = options.driverId ?? process.env["OPENEULER_DRIVER"] ?? DEFAULT_DRIVER_ID;
  const maxConcurrentRuns =
    options.maxConcurrentRuns ?? resolveMaxConcurrentRuns(process.env["MAX_CONCURRENT_RUNS"]);
  if (maxConcurrentRuns < 1 || !Number.isInteger(maxConcurrentRuns)) {
    throw new Error(`maxConcurrentRuns must be an integer >= 1 (got ${maxConcurrentRuns})`);
  }
  const shutdownSettleMs = options.shutdownSettleMs ?? 2_000;
  const active = new Map<string, ActiveRun>();
  const runStatusListeners = new Set<RunStatusListener>();
  /**
   * Last status broadcast per run id: the stalled-driver abort race
   * terminalizes the row both in the executor and (later) in the engine,
   * and identical consecutive frames would leak to every stream client —
   * the same dedupe the activity writer gets from `latestForRun`.
   */
  const lastPublishedStatus = new Map<string, RunStatus>();

  /**
   * Broadcasts one transition on the bus (never throws into callers; a dead
   * listener is dropped, not fatal). Identical consecutive per-run frames
   * are suppressed.
   */
  function publishRunStatus(event: RunStatusNotification): void {
    if (lastPublishedStatus.get(event.runId) === event.status) return;
    lastPublishedStatus.delete(event.runId);
    lastPublishedStatus.set(event.runId, event.status);
    if (lastPublishedStatus.size > 4_096) {
      const oldest = lastPublishedStatus.keys().next().value;
      if (oldest !== undefined) lastPublishedStatus.delete(oldest);
    }
    for (const listener of [...runStatusListeners]) {
      try {
        listener(event);
      } catch (err) {
        logger.error({ err, runId: event.runId }, "run-status listener failed");
      }
    }
  }

  /**
   * Records the feed entry (when feed-worthy) and broadcasts the transition
   * for a run whose row already carries the new status. Used both from the
   * engine's `run.status` hook and the executor's own out-of-engine
   * terminalizations (abort before start, belt-and-braces failure, shutdown).
   */
  function notifyRunStatus(runId: string): void {
    try {
      const run = db.runs.get(runId);
      if (run === undefined) return;
      recordRunStatusActivity(db, runId, run.status);
      publishRunStatus({
        runId,
        status: run.status,
        projectId: run.projectId,
        ...revisionRef(db, run.workflowRevisionId),
      });
    } catch (err) {
      logger.error({ err, runId }, "run-status notification failed");
    }
  }

  const engine = createFlowEngine({
    db,
    worktrees,
    drivers,
    logger,
    onRunStatus: (runId) => notifyRunStatus(runId),
  });

  /** Global semaphore: at most `maxConcurrentRuns` runs execute at once. */
  const limit = pLimit(maxConcurrentRuns);
  /** Per-project gates: projectId → the run holding the project's turn + waiters. */
  const projectGates = new Map<string, ProjectGate>();

  /** Resolves when it is this run's turn for the project; FIFO per project. */
  function acquireProjectGate(projectId: string, runId: string): Promise<void> {
    const gate = projectGates.get(projectId);
    if (gate === undefined) {
      projectGates.set(projectId, { holderRunId: runId, waiters: [] });
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      gate.waiters.push({ runId, resolve });
    });
  }

  /**
   * Hands the project's turn to the next waiter (if any). Only the current
   * holder may release; anything else is a no-op (e.g. a cancelled waiter
   * that was never the holder).
   */
  function releaseProjectGate(projectId: string, runId: string): void {
    const gate = projectGates.get(projectId);
    if (gate === undefined || gate.holderRunId !== runId) return;
    const next = gate.waiters.shift();
    if (next === undefined) {
      projectGates.delete(projectId);
      return;
    }
    gate.holderRunId = next.runId;
    next.resolve();
  }

  /**
   * Drops a queued waiter (abort before start). Its acquire promise is
   * resolved anyway so the run's `done` bookkeeping settles; the scheduler
   * skip-check then finishes it without executing or touching the gate.
   */
  function cancelProjectWaiter(projectId: string, runId: string): void {
    const gate = projectGates.get(projectId);
    if (gate === undefined) return;
    const index = gate.waiters.findIndex((waiter) => waiter.runId === runId);
    if (index === -1) return;
    const [waiter] = gate.waiters.splice(index, 1) as [{ runId: string; resolve: () => void }];
    waiter.resolve();
  }

  function failRun(runId: string, message: string): void {
    logger.error({ runId, error: message }, "run failed");
    try {
      const run = db.runs.get(runId);
      if (!run || isTerminal(run.status)) return;
      db.runs.update(runId, { status: "failed", error: message });
      notifyRunStatus(runId);
    } catch (err) {
      logger.error({ err, runId }, "marking run failed failed");
    }
  }

  /** Moves queued/live step runs to a terminal status (abort before engine start). */
  function settleStepRuns(runId: string, status: RunStatus): void {
    for (const step of db.stepRuns.listByRun(runId)) {
      if (!isTerminal(step.status)) {
        db.stepRuns.update(step.id, { status });
      }
    }
  }

  /** Aborts a run the engine never started: row + step runs, no engine events. */
  function abortBeforeStart(runId: string, projectId: string): void {
    cancelProjectWaiter(projectId, runId);
    db.runs.updateStatus(runId, "aborted");
    settleStepRuns(runId, "aborted");
    notifyRunStatus(runId);
    logger.info({ runId }, "run aborted before start");
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
    const run = db.runs.get(runId);
    if (!run) {
      logger.warn({ runId }, "startRun ignored: unknown run");
      return;
    }
    const entry: ActiveRun = {
      runId,
      projectId: run.projectId,
      abortRequested: false,
      done: Promise.resolve(),
    };
    active.set(runId, entry);
    // Queued admission is itself a transition the dashboard cares about
    // (queue badges / new table rows). No feed entry: `queued` is not
    // feed-worthy — the feed starts at run.started.
    publishRunStatus({
      runId,
      status: "queued",
      projectId: run.projectId,
      ...revisionRef(db, run.workflowRevisionId),
    });
    // Deferred so the HTTP response for POST /api/runs is not interleaved with
    // the engine's first (synchronous) bookkeeping steps. The run then waits
    // for its project's turn, joins the global semaphore queue, executes, and
    // releases the project turn on the way out (terminal, one way or another).
    entry.done = Promise.resolve()
      .then(async () => {
        await acquireProjectGate(run.projectId, runId);
        const row = db.runs.get(runId);
        if (entry.abortRequested || row === undefined || isTerminal(row.status)) {
          // Aborted while queued (or lost): never hand it to the engine. The
          // gate release is a no-op unless this run held the project turn.
          releaseProjectGate(run.projectId, runId);
          active.delete(runId);
          return;
        }
        try {
          await limit(() => execute(entry, opts));
        } finally {
          releaseProjectGate(run.projectId, runId);
        }
      })
      .catch((err: unknown) => {
        logger.error({ err, runId }, "executor crashed unexpectedly");
        failRun(runId, describeError(err));
        releaseProjectGate(run.projectId, runId);
        active.delete(runId);
      });
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
      abortBeforeStart(runId, run.projectId);
      return { outcome: "aborted" };
    }

    entry.abortRequested = true;
    if (run.status === "queued" && entry.handle === undefined) {
      // Still waiting in the scheduler: drop it from the queue and finalize
      // directly; the engine no-ops if a slot is acquired afterwards.
      abortBeforeStart(runId, entry.projectId);
      return { outcome: "aborted" };
    }

    if (entry.handle) {
      await entry.handle.abort();
    }
    const current = db.runs.get(runId);
    if (current && !isTerminal(current.status)) {
      db.runs.updateStatus(runId, "aborted");
      settleStepRuns(runId, "aborted");
      // The engine emits (and records) the terminal transition itself when
      // its event loop observes the abort; when the driver stalls mid-stream
      // it may not settle within any useful window, so record here too —
      // the activity writer dedupes an identical terminal entry.
      notifyRunStatus(runId);
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
      const run = db.runs.get(entry.runId);
      if (run && !isTerminal(run.status)) {
        if (run.status === "queued") {
          // Scheduler-queued: drop from the queue and finalize without start.
          cancelProjectWaiter(entry.projectId, entry.runId);
          db.runs.updateStatus(entry.runId, "aborted");
          settleStepRuns(entry.runId, "aborted");
          notifyRunStatus(entry.runId);
        } else {
          db.runs.updateStatus(entry.runId, "aborted");
        }
      }
      await entry.handle?.abort().catch(() => {});
    }
    await Promise.race([
      Promise.allSettled(entries.map((entry) => entry.done)),
      delay(shutdownSettleMs),
    ]);
    // Final settle pass: step rows the engine could not settle within the
    // window (abort race lost to a slow driver) must not linger as zombies —
    // the run row is already `aborted`, never `interrupted` (that status is
    // reserved for the boot sweep of a dead daemon).
    for (const entry of entries) {
      const run = db.runs.get(entry.runId);
      if (run && run.status === "aborted") {
        settleStepRuns(entry.runId, "aborted");
      }
    }
    logger.info("executor shutdown complete");
  }

  return {
    startRun,
    abortRun,
    shutdown,
    activeRunIds: () => [...active.keys()],
    onRunStatus: (listener: RunStatusListener): (() => void) => {
      runStatusListeners.add(listener);
      return () => {
        runStatusListeners.delete(listener);
      };
    },
    maxConcurrentRuns,
  };
}
