import type { RunStatus } from "@openeuler/core";
import type { Db, StepRunPatch } from "@openeuler/db";
import type { AgentDriver, AgentHandle, AgentMode, DriverRegistry } from "@openeuler/drivers";
import type { WorktreeManager } from "@openeuler/engine";
import type { Logger } from "./logger.js";

/** Default driver id; the real opencode driver lands later (env-overridable). */
export const DEFAULT_DRIVER_ID = "fake";

/** Extra per-run execution options not persisted on the Run row (v1). */
export interface StartRunOptions {
  model?: string;
  mode?: AgentMode;
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
  /** Driver used for runs; defaults to `OPENEULER_DRIVER`, then `"fake"`. */
  driverId?: string;
  /** How long {@link Executor.shutdown} waits for active runs to settle. */
  shutdownSettleMs?: number;
}

interface ActiveRun {
  runId: string;
  /** StepRun row being driven; set once execution begins. */
  stepRunId?: string;
  handle?: AgentHandle;
  abortRequested: boolean;
  done: Promise<void>;
}

const TERMINAL_STATUSES = new Set<RunStatus>(["success", "failed", "aborted", "interrupted"]);

const isTerminal = (status: RunStatus): boolean => TERMINAL_STATUSES.has(status);

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs single-step agent runs end to end: DB row → worktree → driver → event
 * persistence → diff capture → terminal state. Every failure path lands in the
 * run row (`failed` + error message); nothing ever throws into callers, so the
 * daemon stays alive. Kept out of the HTTP layer on purpose: routes only call
 * `startRun`/`abortRun`.
 */
export function createExecutor(options: ExecutorOptions): Executor {
  const { db, worktrees, drivers, logger } = options;
  const driverId = options.driverId ?? process.env["OPENEULER_DRIVER"] ?? DEFAULT_DRIVER_ID;
  const shutdownSettleMs = options.shutdownSettleMs ?? 2_000;
  const active = new Map<string, ActiveRun>();

  function patchStepRun(stepRunId: string | undefined, patch: StepRunPatch): void {
    if (!stepRunId) return;
    try {
      db.stepRuns.update(stepRunId, patch);
    } catch (err) {
      logger.error({ err, stepRunId }, "step run patch failed");
    }
  }

  function failRun(entry: ActiveRun, message: string): void {
    logger.error({ runId: entry.runId, error: message }, "run failed");
    try {
      const run = db.runs.get(entry.runId);
      if (!run || isTerminal(run.status)) return;
      db.runs.update(entry.runId, { status: "failed", error: message });
    } catch (err) {
      logger.error({ err, runId: entry.runId }, "marking run failed failed");
    }
    patchStepRun(entry.stepRunId, { status: "failed" });
  }

  async function captureDiff(worktreePath: string): Promise<string> {
    try {
      const { stat, patch } = await worktrees.diff(worktreePath);
      return [stat.trim(), patch].filter((part) => part.length > 0).join("\n");
    } catch (err) {
      logger.warn({ err, worktreePath }, "diff capture failed (continuing without diff)");
      return "";
    }
  }

  async function execute(entry: ActiveRun, opts: StartRunOptions | undefined): Promise<void> {
    const { runId } = entry;
    try {
      const run = db.runs.get(runId);
      if (!run) {
        logger.warn({ runId }, "startRun called for unknown run");
        return;
      }
      if (run.status !== "queued") {
        logger.warn({ runId, status: run.status }, "startRun ignored: run is not queued");
        return;
      }
      if (entry.abortRequested) {
        db.runs.updateStatus(runId, "aborted");
        patchStepRun(entry.stepRunId, { status: "aborted" });
        return;
      }

      db.runs.updateStatus(runId, "running");
      const stepRun = db.stepRuns.listByRun(runId)[0];
      entry.stepRunId = stepRun?.id;
      patchStepRun(entry.stepRunId, { status: "running" });
      logger.info({ runId, projectId: run.projectId, driverId }, "run started");

      const project = db.projects.get(run.projectId);
      if (!project) {
        throw new Error(`project ${run.projectId} not found`);
      }

      const worktree = await worktrees.create(runId, project);
      const worktreePath = worktree.path;
      logger.info({ runId, worktreePath, branch: worktree.branch }, "worktree created");

      // An abort may have arrived while the worktree was being created.
      if (entry.abortRequested) {
        db.runs.updateStatus(runId, "aborted");
        patchStepRun(entry.stepRunId, { status: "aborted" });
        return;
      }

      const driver: AgentDriver = drivers.getDriver(driverId);
      const handle = driver.start({
        cwd: worktreePath,
        prompt: run.task ?? "",
        mode: opts?.mode ?? "auto",
        ...(opts?.model === undefined ? {} : { model: opts.model }),
      });
      entry.handle = handle;

      let lastErrorMessage: string | undefined;
      try {
        for await (const event of handle.events) {
          db.events.append(runId, event);
          if (event.type === "session") {
            patchStepRun(entry.stepRunId, { sessionId: event.sessionId });
          }
          if (event.type === "error") {
            lastErrorMessage = event.message;
          }
        }
      } catch (err) {
        await handle.abort().catch(() => {});
        throw err;
      }

      const exit = await handle.exited;
      const diff = await captureDiff(worktreePath);

      let status: RunStatus;
      let error: string | undefined;
      if (exit.reason === "exit" && exit.code === 0) {
        status = "success";
      } else if (exit.reason === "aborted" && entry.abortRequested) {
        status = "aborted";
      } else {
        status = "failed";
        error =
          exit.reason === "error"
            ? (lastErrorMessage ?? "agent run errored")
            : exit.reason === "aborted"
              ? "agent run aborted unexpectedly"
              : `agent exited with code ${exit.code ?? "unknown"}`;
      }

      patchStepRun(entry.stepRunId, {
        status,
        output: exit.output,
        ...(diff.length > 0 ? { diff } : {}),
      });

      // The abort API marks the run aborted the moment the driver confirms;
      // only overwrite when the run is still in a live state.
      const current = db.runs.get(runId);
      if (current && !isTerminal(current.status)) {
        db.runs.update(runId, {
          status,
          output: exit.output,
          ...(error === undefined ? {} : { error }),
        });
      } else if (current && (exit.output.length > 0 || error !== undefined)) {
        db.runs.update(runId, {
          ...(exit.output.length > 0 ? { output: exit.output } : {}),
          ...(error === undefined ? {} : { error }),
        });
      }

      const finalRun = db.runs.get(runId);
      logger.info({ runId, status: finalRun?.status, exitReason: exit.reason }, "run finished");
    } catch (err) {
      failRun(entry, describeError(err));
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
    // the executor's first (synchronous) bookkeeping steps.
    entry.done = Promise.resolve()
      .then(() => execute(entry, opts))
      .catch((err: unknown) => {
        // Belt and braces: execute() already catches everything.
        logger.error({ err, runId }, "executor crashed unexpectedly");
        failRun(entry, describeError(err));
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
