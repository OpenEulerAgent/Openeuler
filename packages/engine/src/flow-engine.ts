import { randomUUID } from "node:crypto";
import { renderPromptTemplate } from "@openeuler/core";
import type {
  ExitCondition,
  LoopBack,
  LoopVerdict,
  Run,
  RunStatus,
  StepRun,
} from "@openeuler/core";
import type { Db } from "@openeuler/db";
import type { AgentDriver, AgentHandle, AgentMode, DriverRegistry } from "@openeuler/drivers";
import type { WorktreeManager } from "./worktree.js";

/** Default driver id for ad-hoc runs (override per run via `OPENEULER_DRIVER`). */
export const DEFAULT_DRIVER_ID = "fake";

/** StepRun `stepId` backing ad-hoc runs executed without a workflow. */
export const ADHOC_STEP_ID = "adhoc";

/**
 * Hard ceiling on loop iterations, regardless of what `loopBack.maxIterations`
 * configures: the engine clamps `effective = min(configured, 25)` so a loop
 * whose exit condition never becomes met cannot run forever.
 */
export const MAX_LOOP_ITERATIONS = 25;

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
   * order, chaining outputs/sessions via prompt templates; loopBack edges
   * repeat from `toStepIndex` until the exit condition is met or the
   * iteration cap — hard-capped at {@link MAX_LOOP_ITERATIONS} — is reached)
   * → diff capture → final status. Persists engine events (`run.status`,
   * `step.started`, `step.completed`, `loop.iteration`) into the run's event
   * log around the driver events. Never throws: every failure lands in the
   * run row (`failed` + error).
   *
   * Resumable: when the run already has StepRun rows (a run re-queued after
   * an interruption), execution continues from the first non-successful step
   * in the latest iteration — restarting it with its recorded sessionId,
   * reusing the existing worktree, and reconstructing loop position from the
   * rows plus the workflow config.
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

/** Execution plan for a run: its steps plus the workflow's loopBack edge. */
interface RunPlan {
  steps: StepDefinition[];
  /** Set for workflow runs with a loopBack edge; ad-hoc runs run one pass. */
  loopBack: LoopBack | undefined;
}

const TERMINAL_STATUSES = new Set<RunStatus>(["success", "failed", "aborted", "interrupted"]);

const isTerminal = (status: RunStatus): boolean => TERMINAL_STATUSES.has(status);

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Human-readable form of an exit condition, for event details and errors. */
function describeCondition(when: ExitCondition): string {
  switch (when.type) {
    case "always":
      return "always";
    case "outputContains":
      return `outputContains ${JSON.stringify(when.pattern)}`;
    case "outputNotContains":
      return `outputNotContains ${JSON.stringify(when.pattern)}`;
    case "outputMatches":
      return `outputMatches /${when.regex}/${when.flags ?? ""}`;
  }
}

/**
 * Exit condition evaluation state, compiled once per run so `outputMatches`
 * regexes are a single `new RegExp` per execution.
 */
interface ExitEvaluator {
  when: ExitCondition;
  /** Pre-compiled regex for `outputMatches` conditions. */
  regex: RegExp | undefined;
}

/**
 * Compiles a loopBack exit condition once per run. `outputMatches` regexes are
 * validated at workflow save time; a compile failure here (data that bypassed
 * the schema) is surfaced as a clear error instead of a crash.
 */
function compileExitCondition(loopBack: LoopBack): ExitEvaluator | Error {
  const { when } = loopBack;
  if (when.type !== "outputMatches") {
    return { when, regex: undefined };
  }
  try {
    return { when, regex: new RegExp(when.regex, when.flags ?? "") };
  } catch (err) {
    return new Error(
      `loopBack.when outputMatches regex ${describeCondition(when)} does not compile: ${describeError(err)}`,
    );
  }
}

/**
 * Evaluates an exit condition against the final step's output. `always` is
 * trivially true; `outputContains`/`outputNotContains` are substring checks;
 * `outputMatches` uses the pre-compiled regex (the pattern controls its own
 * anchoring via `^`/`$`/`m`). `lastIndex` is reset so `g`/`y` flags cannot
 * make repeated evaluation stateful.
 */
function evaluateExitCondition(evaluator: ExitEvaluator, output: string): boolean {
  switch (evaluator.when.type) {
    case "always":
      return true;
    case "outputContains":
      return output.includes(evaluator.when.pattern);
    case "outputNotContains":
      return !output.includes(evaluator.when.pattern);
    case "outputMatches": {
      const regex = evaluator.regex;
      if (regex === undefined) return false;
      regex.lastIndex = 0;
      return regex.test(output);
    }
  }
}

/**
 * Multi-step workflow engine. Pure with respect to drivers and storage: the
 * db, worktree manager and driver registry are injected, so tests run the
 * real execution path against a temp database/store and scripted fake
 * drivers. Steps run in workflow order; when the workflow has a `loopBack`
 * edge, the engine evaluates its exit condition against the final step's
 * output after every iteration and jumps back to `steps[toStepIndex]` while
 * the condition is unmet and iterations remain (`{{iterations}}` is 1-based,
 * `prevOutput` flows across the jump, `continueSession` steps resume the
 * previous iteration's same-step session). The iteration count is clamped by
 * the hard cap {@link MAX_LOOP_ITERATIONS}; each iteration's verdict is
 * persisted as a `loop.iteration` event.
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

  /**
   * Captures one step's incremental diff (`stat\npatch` combined, the stored
   * StepRun.diff shape) against `base.ref` and advances `base.ref` to the
   * fresh snapshot tree. Failing to capture never fails the run: the step
   * just stores no diff (and the base stays put).
   */
  async function captureDiff(worktreePath: string, base: { ref: string }): Promise<string> {
    try {
      const { stat, patch, tree } = await worktrees.stepDiff(worktreePath, base.ref);
      base.ref = tree;
      return [stat.trim(), patch].filter((part) => part.length > 0).join("\n");
    } catch (err) {
      log.warn({ err, worktreePath }, "diff capture failed (continuing without diff)");
      return "";
    }
  }

  function resolvePlan(run: Run, opts: ExecuteRunOptions | undefined): RunPlan {
    if (run.workflowId) {
      const workflow = db.workflows.get(run.workflowId);
      if (!workflow) {
        throw new Error(`workflow ${run.workflowId} not found for run ${run.id}`);
      }
      return {
        steps: workflow.steps.map((step) => ({
          stepId: step.id,
          stepName: step.name,
          driver: step.driver,
          promptTemplate: step.promptTemplate,
          ...(step.model === undefined ? {} : { model: step.model }),
          ...(step.agent === undefined ? {} : { agent: step.agent }),
          mode: step.mode,
          continueSession: step.continueSession,
        })),
        loopBack: workflow.loopBack,
      };
    }
    // Ad-hoc run: a single transient step rendering the task verbatim. The
    // template is the literal `{{task}}` token, so a task containing
    // mustache-like text is substituted verbatim, never re-scanned.
    return {
      steps: [
        {
          stepId: ADHOC_STEP_ID,
          stepName: "ad-hoc",
          driver: opts?.driverId ?? process.env["OPENEULER_DRIVER"] ?? DEFAULT_DRIVER_ID,
          promptTemplate: "{{task}}",
          ...(opts?.model === undefined ? {} : { model: opts.model }),
          mode: opts?.mode ?? "auto",
          continueSession: false,
        },
      ],
      loopBack: undefined,
    };
  }

  /**
   * Reuses a pre-existing queued — or interrupted (resume) — StepRun for this
   * (step, iteration), or creates a fresh running row. Reuse keeps exactly one
   * row per (step, iteration) across a resume and preserves the recorded
   * sessionId for the restart.
   */
  function beginStepRun(runId: string, step: StepDefinition, iteration: number): StepRun {
    const existing = db.stepRuns
      .listByRun(runId)
      .find(
        (row) =>
          row.stepId === step.stepId &&
          row.iteration === iteration &&
          (row.status === "queued" || row.status === "interrupted"),
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

  /**
   * Session a `continueSession` step should resume. Across loop iterations the
   * previous iteration's SAME-STEP StepRun wins (the reviewer keeps its own
   * full context, including what it said last pass); within the first
   * iteration — or when the same-step row recorded no session — the previous
   * step's session in flow order is used, matching linear chaining.
   */
  function inheritedSessionFor(
    runId: string,
    step: StepDefinition,
    iteration: number,
    prevSessionId: string | undefined,
  ): string | undefined {
    if (!step.continueSession) return undefined;
    if (iteration > 1) {
      const prior = db.stepRuns
        .listByRun(runId)
        .find((row) => row.stepId === step.stepId && row.iteration === iteration - 1);
      if (prior?.sessionId !== undefined) return prior.sessionId;
    }
    return prevSessionId;
  }

  /**
   * SessionId recorded on an interrupted StepRun at exactly this (step,
   * iteration) — the step restarts in its own context on resume — or null
   * when there is nothing to restart from.
   */
  function restartSessionFor(
    runId: string,
    step: StepDefinition,
    iteration: number,
  ): string | undefined {
    const row = db.stepRuns
      .listByRun(runId)
      .find(
        (row) =>
          row.stepId === step.stepId && row.iteration === iteration && row.status === "interrupted",
      );
    return row?.sessionId;
  }

  /**
   * Where a resumed run continues from, reconstructed from the recorded
   * StepRun rows plus the (workflow-configured) step order: the first step
   * that did NOT succeed — in iteration order, then workflow order — is the
   * restart point; `startIndex === steps.length` means every recorded step
   * succeeded and only the loop verdict / finalize remains to be re-run.
   * Returns undefined for runs that never started a step (fresh execution).
   */
  function reconstructResume(
    runId: string,
    steps: readonly StepDefinition[],
  ):
    | {
        iteration: number;
        startIndex: number;
        prevOutput: string;
        prevSessionId: string | undefined;
      }
    | undefined {
    const rows = db.stepRuns.listByRun(runId);
    if (rows.length === 0) return undefined;
    const byKey = new Map(rows.map((row) => [`${row.iteration}#${row.stepId}`, row]));
    const maxIteration = rows.reduce((max, row) => Math.max(max, row.iteration), 1);
    let prevOutput = "";
    let prevSessionId: string | undefined;
    for (let iteration = 1; iteration <= maxIteration; iteration += 1) {
      for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
        const row = byKey.get(`${iteration}#${steps[stepIndex]?.stepId}`);
        if (row !== undefined && row.status === "success") {
          prevOutput = row.output;
          if (row.sessionId !== undefined) prevSessionId = row.sessionId;
          continue;
        }
        return { iteration, startIndex: stepIndex, prevOutput, prevSessionId };
      }
    }
    return { iteration: maxIteration, startIndex: steps.length, prevOutput, prevSessionId };
  }

  async function runStep(
    runId: string,
    worktreePath: string,
    step: StepDefinition,
    iteration: number,
    vars: { task: string; prevOutput: string },
    inheritedSessionId: string | undefined,
    restartSessionId: string | undefined,
    control: RunControl,
    diffBase: { ref: string },
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
    // A restarted (resumed) step continues its own recorded session even when
    // the step is not configured continueSession; otherwise normal chaining.
    const sessionId = restartSessionId ?? (step.continueSession ? inheritedSessionId : undefined);
    const handle = driver.start({
      cwd: worktreePath,
      prompt,
      mode: step.mode,
      ...(step.model === undefined ? {} : { model: step.model }),
      ...(step.agent === undefined ? {} : { agent: step.agent }),
      ...(sessionId === undefined ? {} : { sessionId }),
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
    const diff = await captureDiff(worktreePath, diffBase);

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
    // step continued (restarted or inherited — drivers may not re-emit
    // `session` when resuming).
    const effectiveSessionId = sessionFromEvents ?? restartSessionId ?? inheritedSessionId;

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

    let plan: RunPlan;
    try {
      plan = resolvePlan(run, opts);
    } catch (err) {
      finalizeRun(runId, "failed", { error: describeError(err) });
      return;
    }

    const { steps, loopBack } = plan;

    // Defensive runtime bound (the schema already rejects this at save time,
    // but the row may predate the refinement or be written around it).
    if (loopBack !== undefined && loopBack.toStepIndex >= steps.length) {
      finalizeRun(runId, "failed", {
        error: `loopBack.toStepIndex must be < steps.length (got ${loopBack.toStepIndex}, but the workflow has ${steps.length} step(s))`,
      });
      return;
    }

    // Exit condition compiled once per run.
    let exitEvaluator: ExitEvaluator | undefined;
    if (loopBack !== undefined) {
      const compiled = compileExitCondition(loopBack);
      if (compiled instanceof Error) {
        finalizeRun(runId, "failed", { error: compiled.message });
        return;
      }
      exitEvaluator = compiled;
    }

    // Loop bound: the configured cap, clamped by the hard cap. `hitHardCap`
    // records whether the clamp changed anything (for the event verdict).
    const configuredMaxIterations = loopBack?.maxIterations ?? 1;
    const maxIterations = Math.min(configuredMaxIterations, MAX_LOOP_ITERATIONS);
    const hitHardCap = configuredMaxIterations > MAX_LOOP_ITERATIONS;

    const project = db.projects.get(run.projectId);
    if (!project) {
      finalizeRun(runId, "failed", { error: `project ${run.projectId} not found` });
      return;
    }

    let worktreePath: string;
    // A resumed run keeps its existing worktree (uncommitted agent changes
    // included); only a fresh execution creates one.
    const existingWorktree = worktrees.existing(runId);
    if (existingWorktree !== null) {
      worktreePath = existingWorktree.path;
      log.info({ runId, worktreePath }, "reusing existing worktree (resumed run)");
    } else {
      try {
        const worktree = await worktrees.create(runId, project);
        worktreePath = worktree.path;
        log.info({ runId, worktreePath, workflowId: run.workflowId ?? null }, "worktree created");
      } catch (err) {
        finalizeRun(runId, "failed", { error: describeError(err) });
        return;
      }
    }

    // An abort may have arrived while the worktree was being created. Nothing
    // has run in it yet, so remove it instead of leaving an orphan behind.
    if (control.isAbortRequested()) {
      abortRun(runId);
      if (existingWorktree === null) {
        try {
          await worktrees.remove(runId);
        } catch (err) {
          log.warn({ err, runId }, "worktree cleanup after pre-start abort failed");
        }
      }
      return;
    }

    const task = run.task ?? "";
    // Per-step diff base: starts at HEAD (the worktree branch point), then
    // advances to each completed step's snapshot tree so every StepRun.diff
    // stores only THAT step's changes. Resumed runs restart at HEAD — the
    // first step after a resume captures everything since HEAD (the snapshot
    // trees of earlier steps are not persisted); later steps are incremental
    // again. The cumulative view (daemon `?scope=cumulative`) is unaffected.
    const diffBase = { ref: "HEAD" };
    // Resume position from the recorded StepRun rows: steps before it already
    // succeeded (their outputs/sessions seed the chaining context); the loop
    // counter continues at the interrupted iteration.
    const resume = reconstructResume(runId, steps);
    let runOutput = resume?.prevOutput ?? "";
    // Context that flows along the whole run, across loop-back jumps: after a
    // jump the first re-run step receives the previous iteration's LAST step
    // output as `{{prevOutput}}` (and, when it continues a session and has no
    // same-step session of its own, the previous iteration's last session).
    let prevOutput = resume?.prevOutput ?? "";
    let prevSessionId = resume?.prevSessionId;
    // Steps before `loopBack.toStepIndex` do not re-run after a jump; on
    // resume it is the restart step's index instead.
    let startIndex = resume?.startIndex ?? 0;

    for (let iteration = resume?.iteration ?? 1; ; iteration += 1) {
      const rowIteration = iteration - 1; // Run.iteration stays 0-based.
      const currentRow = db.runs.get(runId);
      if (currentRow !== undefined && currentRow.iteration !== rowIteration) {
        db.runs.update(runId, { iteration: rowIteration });
      }

      for (let stepIndex = startIndex; stepIndex < steps.length; stepIndex += 1) {
        if (control.isAbortRequested()) {
          abortRun(runId);
          return;
        }

        const step = steps[stepIndex] as StepDefinition;
        const outcome = await runStep(
          runId,
          worktreePath,
          step,
          iteration,
          { task, prevOutput },
          inheritedSessionFor(runId, step, iteration, prevSessionId),
          restartSessionFor(runId, step, iteration),
          control,
          diffBase,
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

      // No loopBack edge: a single pass (loop-aware code paths stay dormant).
      if (loopBack === undefined || exitEvaluator === undefined) {
        break;
      }

      // LoopBack edge: evaluate `when` against the FINAL step's output and
      // decide whether another iteration starts at `toStepIndex`.
      const conditionMet = evaluateExitCondition(exitEvaluator, runOutput);
      const description = describeCondition(exitEvaluator.when);
      let verdict: LoopVerdict;
      let detail: string;
      if (conditionMet) {
        verdict = "exit-condition-met";
        detail = `${description} met after iteration ${iteration}`;
      } else if (hitHardCap && iteration >= maxIterations) {
        verdict = "hard-cap";
        detail = `${description} unmet; stopped at the hard iteration cap ${MAX_LOOP_ITERATIONS} (maxIterations=${configuredMaxIterations} clamped)`;
      } else if (iteration >= maxIterations) {
        verdict = "max-iterations";
        detail = `${description} unmet; stopped at maxIterations=${maxIterations}`;
      } else {
        verdict = "continue";
        detail = `${description} unmet; jumping back to step ${loopBack.toStepIndex + 1} of ${steps.length}`;
      }

      db.events.append(runId, {
        type: "loop.iteration",
        iteration,
        verdict,
        detail,
      });
      log.info({ runId, iteration, verdict }, "loop iteration evaluated");

      if (verdict !== "continue") {
        break;
      }

      startIndex = loopBack.toStepIndex;
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
