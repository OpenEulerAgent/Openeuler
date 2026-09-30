import { randomUUID } from "node:crypto";
import { renderPromptTemplate } from "@openeuler/core";
import type { Run, RunStatus, StepRun } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import type { AgentDriver, AgentHandle, AgentMode, DriverRegistry } from "@openeuler/drivers";
import type { WorktreeManager } from "./worktree.js";

/** Default driver id for ad-hoc runs; the real opencode driver lands later. */
export const DEFAULT_DRIVER_ID = "fake";

/** StepRun `stepId` backing ad-hoc runs executed without a workflow. */
export const ADHOC_STEP_ID = "adhoc";

/** Structural slice of a pino-style logger; the daemon passes its real one. */
export interface FlowLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** A single agent invocation inside a run, resolved from a workflow or ad-hoc. */
export interface StepDefinition {
  stepId: string;
  stepName: string;
  /** Driver registry id (`Step.driver` for workflow steps, the default for ad-hoc). */
  driver: string;
  promptTemplate: string;
  model?: string;
  agent?: string;
  mode: AgentMode;
  continueSession: boolean;
}

/** Per-run execution options (ad-hoc prompts; driver fallback selection). */
export interface ExecuteRunOptions {
  /** Driver for ad-hoc runs; defaults to `OPENEULER_DRIVER`, then `"fake"`. */
  driverId?: string;
  /** Model override for ad-hoc runs. */
  model?: string;
  /** Interaction mode for ad-hoc runs; defaults to `"auto"`. */
  mode?: AgentMode;
}

/**
 * Hooks the caller (e.g. the daemon executor) uses to steer a live run:
 * abort signaling and driver-handle tracking.
 */
export interface RunControl {
  /** Returns true once an abort was requested for the run. */
  isAbortRequested(): boolean;
  /** Called with the live driver handle (and `undefined` when it settles). */
  onHandle?(handle: AgentHandle | undefined): void;
}

export interface FlowEngineOptions {
  db: Db;
  worktrees: WorktreeManager;
  drivers: DriverRegistry;
  logger?: FlowLogger;
}

export interface FlowEngine {
  /**
   * Drives a queued run to a terminal state: worktree → steps (in workflow
   * order, chaining outputs/sessions via prompt templates) → diff capture →
   * final status. Persists engine events (`run.status`, `step.started`,
   * `step.completed`) into the run's event log around the driver events.
   * Never throws: every failure lands in the run row (`failed` + error).
   */
  executeRun(runId: string, control: RunControl, opts?: ExecuteRunOptions): Promise<void>;
}

/** Terminal outcome of one step, fed into the next step's prompt/session. */
interface StepOutcome {
  status: RunStatus;
  output: string;
  error: string | undefined;
  /** Session this step ran in (from its `session` event or the one it continued). */
  sessionId: string | undefined;
}

const TERMINAL_STATUSES = new Set<RunStatus>(["success", "failed", "aborted", "interrupted"]);

const isTerminal = (status: RunStatus): boolean => TERMINAL_STATUSES.has(status);

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Multi-step workflow engine. Pure with respect to drivers and storage: the
 * db, worktree manager and driver registry are injected, so tests run the
 * real execution path against a temp database/store and scripted fake
 * drivers. Runs execute a single pass today; the step loop below is already
 * wrapped in an iteration loop (1-based, matching `{{iterations}}`) so
 * loop-back (#16) only needs to extend the loop bound and reset `stepIndex`.
 */
export function createFlowEngine(options: FlowEngineOptions): FlowEngine {
  const { db, worktrees, drivers } = options;
  const logger = options.logger;

  const log = {
    info: (obj: object, msg: string): void => logger?.info(obj, msg),
    warn: (obj: object, msg: string): void => logger?.warn(obj, msg),
    error: (obj: object, msg: string): void => logger?.error(obj, msg),
  };

  function emitRunStatus(runId: string, status: RunStatus, error?: string): void {
    db.events.append(runId, {
      type: "run.status",
      status,
      ...(error === undefined ? {} : { error }),
    });
  }

  /** Moves queued/live step runs to a terminal status (run-level failure). */
  function settleStepRuns(runId: string, status: RunStatus): void {
    for (const stepRun of db.stepRuns.listByRun(runId)) {
      if (!isTerminal(stepRun.status)) {
        db.stepRuns.update(stepRun.id, { status });
      }
    }
  }

  function abortRun(runId: string): void {
    const run = db.runs.get(runId);
    if (!run) return;
    if (!isTerminal(run.status)) {
      db.runs.updateStatus(runId, "aborted");
    }
    // The abort API may have terminalized the row already; step runs still
    // need to settle either way.
    settleStepRuns(runId, "aborted");
    emitRunStatus(runId, "aborted");
    log.info({ runId }, "run aborted");
  }

  /**
   * Final run transition. The row is the source of truth for status (an abort
   * via the API may have terminalized it already); output/error are still
   * backfilled so late evidence is not lost. Emits exactly one terminal
   * `run.status` event per execution.
   */
  function finalizeRun(
    runId: string,
    status: RunStatus,
    patch: { output?: string; error?: string },
  ): void {
    const run = db.runs.get(runId);
    if (!run) return;
    const finalStatus = isTerminal(run.status) ? run.status : status;
    if (!isTerminal(run.status)) {
      db.runs.update(runId, {
        status,
        ...(patch.output === undefined || patch.output.length === 0
          ? {}
          : { output: patch.output }),
        ...(patch.error === undefined ? {} : { error: patch.error }),
      });
      settleStepRuns(runId, status);
    } else if (patch.output !== undefined && patch.output.length > 0) {
      db.runs.update(runId, { output: patch.output });
    }
    emitRunStatus(runId, finalStatus, patch.error);
    log.info({ runId, status: finalStatus }, "run finished");
  }

  async function captureDiff(worktreePath: string): Promise<string> {
    try {
      const { stat, patch } = await worktrees.diff(worktreePath);
      return [stat.trim(), patch].filter((part) => part.length > 0).join("\n");
    } catch (err) {
      log.warn({ err, worktreePath }, "diff capture failed (continuing without diff)");
      return "";
    }
  }

  function resolveSteps(run: Run, opts: ExecuteRunOptions | undefined): StepDefinition[] {
    if (run.workflowId) {
      const workflow = db.workflows.get(run.workflowId);
      if (!workflow) {
        throw new Error(`workflow ${run.workflowId} not found for run ${run.id}`);
      }
      return workflow.steps.map((step) => ({
        stepId: step.id,
        stepName: step.name,
        driver: step.driver,
        promptTemplate: step.promptTemplate,
        ...(step.model === undefined ? {} : { model: step.model }),
        ...(step.agent === undefined ? {} : { agent: step.agent }),
        mode: step.mode,
        continueSession: step.continueSession,
      }));
    }
    // Ad-hoc run: a single transient step rendering the task verbatim. The
    // template is the literal `{{task}}` token, so a task containing
    // mustache-like text is substituted verbatim, never re-scanned.
    return [
      {
        stepId: ADHOC_STEP_ID,
        stepName: "ad-hoc",
        driver: opts?.driverId ?? process.env["OPENEULER_DRIVER"] ?? DEFAULT_DRIVER_ID,
        promptTemplate: "{{task}}",
        ...(opts?.model === undefined ? {} : { model: opts.model }),
        mode: opts?.mode ?? "auto",
        continueSession: false,
      },
    ];
  }

  /**
   * Reuses a pre-existing queued StepRun for this (step, iteration) — created
   * ahead of execution by older writers — or creates a fresh running row.
   */
  function beginStepRun(runId: string, step: StepDefinition, iteration: number): StepRun {
    const existing = db.stepRuns
      .listByRun(runId)
      .find(
        (row) =>
          row.stepId === step.stepId && row.iteration === iteration && row.status === "queued",
      );
    if (existing) {
      return db.stepRuns.update(existing.id, { status: "running" }) ?? existing;
    }
    return db.stepRuns.create({
      id: randomUUID(),
      runId,
      stepId: step.stepId,
      iteration,
      status: "running",
      output: "",
    });
  }

  async function runStep(
    runId: string,
    worktreePath: string,
    step: StepDefinition,
    iteration: number,
    vars: { task: string; prevOutput: string },
    inheritedSessionId: string | undefined,
    control: RunControl,
  ): Promise<StepOutcome> {
    const prompt = renderPromptTemplate(step.promptTemplate, {
      task: vars.task,
      prevOutput: vars.prevOutput,
      iterations: iteration,
    });

    const stepRun = beginStepRun(runId, step, iteration);
    db.events.append(runId, {
      type: "step.started",
      stepId: step.stepId,
      stepName: step.stepName,
      iteration,
    });
    log.info({ runId, stepId: step.stepId, iteration }, "step started");

    const driver: AgentDriver = drivers.getDriver(step.driver);
    const handle = driver.start({
      cwd: worktreePath,
      prompt,
      mode: step.mode,
      ...(step.model === undefined ? {} : { model: step.model }),
      ...(step.agent === undefined ? {} : { agent: step.agent }),
      ...(step.continueSession && inheritedSessionId !== undefined
        ? { sessionId: inheritedSessionId }
        : {}),
    });
    control.onHandle?.(handle);

    let lastErrorMessage: string | undefined;
    let sessionFromEvents: string | undefined;
    try {
      for await (const event of handle.events) {
        db.events.append(runId, event);
        if (event.type === "session") {
          sessionFromEvents = event.sessionId;
          db.stepRuns.update(stepRun.id, { sessionId: event.sessionId });
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
    control.onHandle?.(undefined);
    const diff = await captureDiff(worktreePath);

    let status: RunStatus;
    let error: string | undefined;
    if (exit.reason === "exit" && exit.code === 0) {
      status = "success";
    } else if (exit.reason === "aborted" && control.isAbortRequested()) {
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

    // The effective session: the one the driver announced, else the one this
    // step continued (drivers may not re-emit `session` when resuming).
    const effectiveSessionId = sessionFromEvents ?? inheritedSessionId;

    db.stepRuns.update(stepRun.id, {
      status,
      output: exit.output,
      ...(diff.length > 0 ? { diff } : {}),
    });
    db.events.append(runId, {
      type: "step.completed",
      stepId: step.stepId,
      stepName: step.stepName,
      iteration,
      status,
    });
    log.info({ runId, stepId: step.stepId, iteration, status }, "step finished");

    const outcome: StepOutcome = {
      status,
      output: exit.output,
      error,
      sessionId: effectiveSessionId,
    };
    return outcome;
  }

  async function execute(
    runId: string,
    control: RunControl,
    opts: ExecuteRunOptions | undefined,
  ): Promise<void> {
    const run = db.runs.get(runId);
    if (!run) {
      log.warn({ runId }, "executeRun called for unknown run");
      return;
    }
    if (run.status !== "queued") {
      log.warn({ runId, status: run.status }, "executeRun ignored: run is not queued");
      return;
    }
    if (control.isAbortRequested()) {
      abortRun(runId);
      return;
    }

    db.runs.updateStatus(runId, "running");
    emitRunStatus(runId, "running");

    let steps: StepDefinition[];
    try {
      steps = resolveSteps(run, opts);
    } catch (err) {
      finalizeRun(runId, "failed", { error: describeError(err) });
      return;
    }

    const project = db.projects.get(run.projectId);
    if (!project) {
      finalizeRun(runId, "failed", { error: `project ${run.projectId} not found` });
      return;
    }

    let worktreePath: string;
    try {
      const worktree = await worktrees.create(runId, project);
      worktreePath = worktree.path;
    } catch (err) {
      finalizeRun(runId, "failed", { error: describeError(err) });
      return;
    }
    log.info({ runId, worktreePath, workflowId: run.workflowId ?? null }, "worktree created");

    // An abort may have arrived while the worktree was being created.
    if (control.isAbortRequested()) {
      abortRun(runId);
      return;
    }

    const task = run.task ?? "";
    // Single pass today (#16 adds loop-back); the counter is already flowing
    // so templates and StepRun rows are iteration-aware.
    const iterations = 1;
    let runOutput = "";

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const rowIteration = iteration - 1; // Run.iteration stays 0-based.
      if (run.iteration !== rowIteration) {
        db.runs.update(runId, { iteration: rowIteration });
      }

      let prevOutput = "";
      let prevSessionId: string | undefined;

      for (const step of steps) {
        if (control.isAbortRequested()) {
          abortRun(runId);
          return;
        }

        const outcome = await runStep(
          runId,
          worktreePath,
          step,
          iteration,
          { task, prevOutput },
          prevSessionId,
          control,
        );

        if (outcome.status === "success") {
          prevOutput = outcome.output;
          prevSessionId = outcome.sessionId;
          runOutput = outcome.output;
          continue;
        }

        finalizeRun(runId, outcome.status, {
          output: outcome.output,
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        });
        return;
      }
    }

    finalizeRun(runId, "success", { output: runOutput });
  }

  return {
    async executeRun(runId, control, opts) {
      try {
        await execute(runId, control, opts);
      } catch (err) {
        // Belt and braces: execute() already funnels every failure into the
        // run row; a crash in the engine itself must never take the daemon down.
        const message = describeError(err);
        log.error({ err, runId }, "flow engine crashed unexpectedly");
        const run = db.runs.get(runId);
        if (run && !isTerminal(run.status)) {
          db.runs.update(runId, { status: "failed", error: message });
          settleStepRuns(runId, "failed");
          emitRunStatus(runId, "failed", message);
        }
      }
    },
  };
}
