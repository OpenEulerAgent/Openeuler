import { randomUUID } from "node:crypto";
import type { PersistedEvent, Run, RunStatus, StepRun, TerminalRunStatus } from "@openeuler/core";
import { TERMINAL_RUN_STATUSES, RunStatusSchema } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { DriverError } from "@openeuler/drivers";
import { ADHOC_STEP_ID, branchForRun } from "@openeuler/engine";
import type { WorktreeManager } from "@openeuler/engine";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import type { Executor } from "../executor.js";
import { HttpError } from "../errors.js";

/**
 * StepRun `stepId` backing ad-hoc runs (no workflow); defined by the engine,
 * which executes ad-hoc runs as a single transient step.
 */
export { ADHOC_STEP_ID };

/**
 * Runs API.
 *
 * ## Concurrency & queueing
 *
 * Runs execute under a global semaphore (`MAX_CONCURRENT_RUNS`, default 2,
 * surfaced in `/health`) and are serialized per project: only one run per
 * project is active at a time — worktrees branch from the same repo HEAD, so
 * siblings wait (status `queued`) until the current run is terminal. Runs for
 * different projects execute in parallel up to the global cap.
 *
 * A queued run's response carries a computed `queuePosition` field (not part
 * of the core `Run`): the number of queued runs created before it, in global
 * `(createdAt, id)` order. The field disappears once the run starts. A
 * project-level toggle for serialization may arrive later.
 */

const CreateRunBodySchema = z.strictObject({
  projectId: z.string().min(1, "projectId must be a non-empty string"),
  prompt: z.string().min(1, "prompt must be a non-empty string"),
  model: z.string().min(1, "model must be a non-empty string").optional(),
  mode: z.enum(["auto", "ask"]).optional(),
});

/** Cursor for SSE resume: `?afterSeq=` or `Last-Event-ID` (a run event seq). */
const EventCursorSchema = z.coerce
  .number()
  .int("afterSeq/Last-Event-ID must be an integer")
  .min(0, "afterSeq/Last-Event-ID must be >= 0");

/** Tunables for `GET /api/runs/:id/events`; overridable for tests. */
export interface EventStreamOptions {
  /** Tail poll interval against the events table. Default 100ms. */
  pollIntervalMs?: number;
  /** Idle heartbeat (`: ping` comment) interval. Default 15s. */
  heartbeatMs?: number;
  /** Max concurrent streams for the same run before 429. Default 5. */
  maxStreamsPerRun?: number;
}

const DEFAULT_EVENT_STREAM: Required<EventStreamOptions> = {
  pollIntervalMs: 100,
  heartbeatMs: 15_000,
  maxStreamsPerRun: 5,
};

const isTerminalRunStatus = (status: RunStatus): status is TerminalRunStatus =>
  (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

/** Run detail payload: the run, its step runs (flat + grouped per iteration), and a small summary. */
export interface RunDetailBody {
  run: RunApiBody;
  steps: StepRun[];
  /** Step runs grouped by 1-based loop pass, ordered by iteration. */
  iterations: Array<{ iteration: number; steps: StepRun[] }>;
  summary: { eventCount: number };
}

/** Run list payload: runs plus computed queue metadata for queued rows. */
export interface RunListBody {
  runs: RunApiBody[];
}

/** Queue summary for dashboards: how many runs are queued vs executing. */
export interface RunStatsBody {
  queued: number;
  running: number;
}

/**
 * A run as returned by the API: the core `Run` plus `queuePosition`, a
 * computed field present only while the run sits in the global queue. It is
 * deliberately NOT part of the persisted core Run schema.
 */
export type RunApiBody = Run & { queuePosition?: number };

/**
 * `queuePosition` per queued run id: how many queued runs were created
 * before it, in global `(createdAt, id)` ascending order (0 = next to
 * start). Computed from the db, so it reflects both live queued runs and
 * rows enqueued by other writers.
 */
function queuePositionsByRunId(db: Db): Map<string, number> {
  const queued = [...db.runs.list(undefined, "queued")].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
  );
  const positions = new Map<string, number>();
  queued.forEach((run, index) => positions.set(run.id, index));
  return positions;
}

/** Attaches `queuePosition` to queued rows (others pass through untouched). */
function withQueuePosition(run: Run, positions: Map<string, number>): RunApiBody {
  if (run.status !== "queued") return run;
  const queuePosition = positions.get(run.id);
  return queuePosition === undefined ? run : { ...run, queuePosition };
}

function requireDb(c: Context<AppEnv>): Db {
  const db = c.get("db");
  if (!db) throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
  return db;
}

function requireExecutor(c: Context<AppEnv>): Executor {
  const executor = c.get("executor");
  if (!executor) throw new HttpError(503, "EXECUTOR_UNAVAILABLE", "executor is not configured");
  return executor;
}

async function parseJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(422, "INVALID_JSON", "request body must be valid JSON");
  }
}

function requireRun(db: Db, id: string): Run {
  const run = db.runs.get(id);
  if (!run) throw new HttpError(404, "RUN_NOT_FOUND", `no run with id ${id}`);
  return run;
}

/**
 * Cancellable delay: resolves after `ms`, or early never (the caller races it
 * against an abort promise and always cancels, so no dangling timers).
 */
function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** Serializes one streamed event as an SSE frame in the documented wire format. */
function sseFrame(event: PersistedEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Groups step runs by iteration (1-based), ordered by iteration. */
function groupByIteration(steps: StepRun[]): Array<{ iteration: number; steps: StepRun[] }> {
  const groups = new Map<number, StepRun[]>();
  for (const step of steps) {
    const bucket = groups.get(step.iteration);
    if (bucket) bucket.push(step);
    else groups.set(step.iteration, [step]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([iteration, grouped]) => ({ iteration, steps: grouped }));
}

// ---------------------------------------------------------------------------
// GET /api/runs/:id/diff — per-step and cumulative diff payloads.
//

/**
 * Server-side cap on returned patch lines: a guard against multi-megabyte
 * payloads from huge generated changes. The response carries
 * `truncated: true` + `totalLines` past the cap; there is deliberately NO
 * `?full=1` escape hatch — the cap IS the guard, and the client banner
 * explains it (`Showing first N of M lines`).
 */
export const MAX_DIFF_PATCH_LINES = 20_000;

/** Query params for `GET /api/runs/:id/diff`. */
const DiffQuerySchema = z.strictObject({
  /** `step` (requires `stepRunId`) or `cumulative` (default). */
  scope: z.enum(["step", "cumulative"]).optional(),
  stepRunId: z.string().min(1, "stepRunId must be a non-empty string").optional(),
});

/** Body of `GET /api/runs/:id/diff` for both scopes. */
export interface RunDiffBody {
  scope: "step" | "cumulative";
  /** `git diff --stat` summary (never truncated — small by construction). */
  stat: string;
  /** Unified patch, capped at {@link MAX_DIFF_PATCH_LINES} lines. */
  patch: string;
  /** True when the patch was cut at the cap. */
  truncated: boolean;
  /** Full patch line count before the cap was applied. */
  totalLines: number;
  /** The cap applied; echoed so clients can label the banner without hardcoding. */
  maxLines: number;
  /** Present for `scope=step`: the StepRun whose stored diff this is. */
  stepRunId?: string;
}

/**
 * Splits a StepRun's stored `diff` column — the engine's `stat\npatch`
 * combination — back into `{ stat, patch }`. The stat block is everything
 * before the first `diff --git` line; a stored value with no patch section
 * (clean tree) is all stat.
 */
export function splitStepDiff(stored: string): { stat: string; patch: string } {
  if (stored.length === 0) return { stat: "", patch: "" };
  const lines = stored.split("\n");
  const firstPatchLine = lines.findIndex((line) => line.startsWith("diff --git "));
  if (firstPatchLine === -1) return { stat: stored.trimEnd(), patch: "" };
  return {
    stat: lines.slice(0, firstPatchLine).join("\n").trimEnd(),
    patch: lines.slice(firstPatchLine).join("\n"),
  };
}

/** Applies the {@link MAX_DIFF_PATCH_LINES} cap to a patch. */
export function capPatchLines(patch: string): {
  patch: string;
  truncated: boolean;
  totalLines: number;
} {
  if (patch.length === 0) return { patch, truncated: false, totalLines: 0 };
  const lines = patch.split("\n");
  if (lines.length <= MAX_DIFF_PATCH_LINES) {
    return { patch, truncated: false, totalLines: lines.length };
  }
  return {
    patch: lines.slice(0, MAX_DIFF_PATCH_LINES).join("\n"),
    truncated: true,
    totalLines: lines.length,
  };
}

export interface CreateRunsRouterOptions {
  /** SSE tuning for `GET /api/runs/:id/events` (tests shrink the timers). */
  eventStream?: EventStreamOptions;
  /**
   * Worktree manager for `GET /api/runs/:id/diff?scope=cumulative` (computed
   * live in the run's worktree). Absent → that scope answers 503; the
   * per-step scope only reads stored rows and works without it.
   */
  worktrees?: WorktreeManager;
}

export function createRunsRouter(options: CreateRunsRouterOptions = {}): Hono<AppEnv> {
  const runs = new Hono<AppEnv>();
  const streamOptions: Required<EventStreamOptions> = {
    ...DEFAULT_EVENT_STREAM,
    ...options.eventStream,
  };
  /** Active SSE stream count per run id; guards the concurrent-stream cap. */
  const activeStreams = new Map<string, number>();

  runs.post("/", async (c) => {
    const db = requireDb(c);
    const executor = requireExecutor(c);
    const body = CreateRunBodySchema.parse(await parseJsonBody(c));

    const project = db.projects.get(body.projectId);
    if (!project) {
      throw new HttpError(
        404,
        "PROJECT_NOT_FOUND",
        `no project with id ${body.projectId}; register it via POST /api/projects first`,
      );
    }

    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: Run = {
      id: runId,
      projectId: project.id,
      status: "queued",
      branch: branchForRun(runId),
      iteration: 0,
      task: body.prompt,
      createdAt: now,
      updatedAt: now,
    };
    db.runs.create(run);
    // No StepRun row here: the flow engine executes ad-hoc runs as a single
    // transient step (ADHOC_STEP_ID) and creates its StepRun when it starts.

    c.get("logger").info({ runId, projectId: project.id }, "run accepted");
    // Background execution; never blocks the response.
    executor.startRun(runId, {
      ...(body.model === undefined ? {} : { model: body.model }),
      mode: body.mode ?? "auto",
    });

    return c.json({ run }, 202);
  });

  runs.get("/", (c) => {
    const db = requireDb(c);
    const statusRaw = c.req.query("status");
    let status: Run["status"] | undefined;
    if (statusRaw !== undefined) {
      const parsed = RunStatusSchema.safeParse(statusRaw);
      if (!parsed.success) {
        throw new HttpError(
          422,
          "INVALID_STATUS",
          `status must be one of queued|running|success|failed|aborted|interrupted, got ${JSON.stringify(statusRaw)}`,
        );
      }
      status = parsed.data;
    }
    const runs = db.runs.list(c.req.query("projectId") || undefined, status);
    const positions = queuePositionsByRunId(db);
    const body: RunListBody = { runs: runs.map((run) => withQueuePosition(run, positions)) };
    return c.json(body);
  });

  // Registered before `/:id` so "stats" is not captured as a run id.
  runs.get("/stats", (c) => {
    const db = requireDb(c);
    const body: RunStatsBody = {
      queued: db.runs.list(undefined, "queued").length,
      running: db.runs.list(undefined, "running").length,
    };
    return c.json(body);
  });

  runs.get("/:id", (c) => {
    const db = requireDb(c);
    const run = requireRun(db, c.req.param("id"));
    const steps = db.stepRuns.listByRun(run.id);
    // Within an iteration, order steps like the workflow definition when the
    // run has one (rows themselves only carry iteration + id ordering).
    let order = new Map<string, number>();
    if (run.workflowId) {
      const workflow = db.workflows.get(run.workflowId);
      if (workflow) {
        order = new Map(workflow.steps.map((step, index) => [step.id, index]));
      }
    }
    const sorted = [...steps].sort((a, b) => {
      const ai = order.get(a.stepId) ?? Number.MAX_SAFE_INTEGER;
      const bi = order.get(b.stepId) ?? Number.MAX_SAFE_INTEGER;
      return ai === bi ? a.stepId.localeCompare(b.stepId) : ai - bi;
    });
    const body: RunDetailBody = {
      run: withQueuePosition(run, queuePositionsByRunId(db)),
      steps: sorted,
      iterations: groupByIteration(sorted),
      summary: { eventCount: db.events.count(run.id) },
    };
    return c.json(body);
  });

  // Diff payloads for the run detail page's Diffs tab. Two scopes:
  //
  // - `?scope=step&stepRunId=<id>` — THAT StepRun's stored diff (the engine
  //   snapshots a tree after every step, so the stored patch is incremental:
  //   only that step's changes, even mid-workflow). Works for any run,
  //   including cleaned-up ones — no worktree needed.
  // - `?scope=cumulative` (default) — everything the run changed vs its base
  //   branch, computed LIVE in the run's worktree (`git diff <merge-base of
  //   base branch and HEAD>` covering staged, unstaged, and untracked
  //   changes). Needs the worktree to still exist: gone (run cleaned up,
  //   worktree pruned) → 410 WORKTREE_GONE; per-step scope still works.
  //
  // Both responses cap the patch at MAX_DIFF_PATCH_LINES lines
  // (`truncated: true` + `totalLines` past the cap).
  runs.get("/:id/diff", async (c) => {
    const db = requireDb(c);
    const run = requireRun(db, c.req.param("id"));

    const query = DiffQuerySchema.parse({
      scope: c.req.query("scope") ?? undefined,
      stepRunId: c.req.query("stepRunId") ?? undefined,
    });
    const scope = query.scope ?? "cumulative";

    if (scope === "step") {
      if (query.stepRunId === undefined) {
        throw new HttpError(
          422,
          "STEP_RUN_ID_REQUIRED",
          "scope=step requires a stepRunId query parameter",
        );
      }
      // listByRun both checks existence AND ownership (a stepRunId from
      // another run is indistinguishable from a missing one — no leaking).
      const stepRun = db.stepRuns.listByRun(run.id).find((step) => step.id === query.stepRunId);
      if (!stepRun) {
        throw new HttpError(
          404,
          "STEP_RUN_NOT_FOUND",
          `run ${run.id} has no step run with id ${query.stepRunId}`,
        );
      }
      const { stat, patch } = splitStepDiff(stepRun.diff ?? "");
      const capped = capPatchLines(patch);
      const body: RunDiffBody = {
        scope,
        stat,
        ...capped,
        maxLines: MAX_DIFF_PATCH_LINES,
        stepRunId: stepRun.id,
      };
      return c.json(body);
    }

    // scope=cumulative — needs the live worktree.
    const worktrees = options.worktrees ?? c.get("worktrees");
    if (!worktrees) {
      throw new HttpError(
        503,
        "WORKTREES_UNAVAILABLE",
        "worktree manager is not configured; cumulative diffs are unavailable",
      );
    }
    const info = worktrees.existing(run.id);
    if (info === null) {
      throw new HttpError(
        410,
        "WORKTREE_GONE",
        `the worktree for run ${run.id} no longer exists (run cleaned up or worktree pruned); the cumulative diff cannot be computed — per-step diffs (?scope=step&stepRunId=…) are still available`,
      );
    }
    const project = db.projects.get(run.projectId);
    const baseBranch = project?.defaultBranch ?? "HEAD";
    const { stat, patch } = await worktrees.diffVsBase(info.path, baseBranch);
    const capped = capPatchLines(patch);
    const body: RunDiffBody = { scope, stat, ...capped, maxLines: MAX_DIFF_PATCH_LINES };
    return c.json(body);
  });

  // SSE live stream: replay persisted events (from the cursor) in seq order,
  // then tail the events table until the run ends. The engine persists its own
  // lifecycle events (`run.status`, `step.started`, `step.completed`) into the
  // same log, so replay naturally ends with the terminal `run.status` event —
  // the stream closes on it without synthesizing anything. The synthetic
  // terminal `run.status` (lastSeq+1) remains only as a fallback for runs that
  // ended without a persisted terminal event (rows written before engine
  // events, or aborts handled outside the engine).
  runs.get("/:id/events", (c) => {
    const db = requireDb(c);
    const runId = c.req.param("id");
    requireRun(db, runId);

    // `?afterSeq=` wins over `Last-Event-ID` when both are present.
    const rawCursor = c.req.query("afterSeq") ?? c.req.header("Last-Event-ID");
    let cursor = 0;
    if (rawCursor !== undefined && rawCursor !== "") {
      const parsed = EventCursorSchema.safeParse(rawCursor);
      if (!parsed.success) {
        throw new HttpError(
          422,
          "INVALID_CURSOR",
          `afterSeq/Last-Event-ID must be a non-negative integer, got ${JSON.stringify(rawCursor)}`,
        );
      }
      cursor = parsed.data;
    }

    const active = activeStreams.get(runId) ?? 0;
    if (active >= streamOptions.maxStreamsPerRun) {
      throw new HttpError(
        429,
        "TOO_MANY_STREAMS",
        `run ${runId} already has ${active} concurrent event streams (max ${streamOptions.maxStreamsPerRun})`,
      );
    }
    activeStreams.set(runId, active + 1);

    return streamSSE(c, async (stream) => {
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        const current = activeStreams.get(runId) ?? 1;
        if (current <= 1) activeStreams.delete(runId);
        else activeStreams.set(runId, current - 1);
      };

      let stopped = false;
      const stop = (): void => {
        stopped = true;
      };
      let wake: (() => void) | null = null;
      const aborted = new Promise<void>((resolve) => {
        wake = resolve;
      });
      // Client disconnect reaches us two ways: the request abort signal
      // (node-server aborts it on socket close) and the response stream
      // cancel (reader.cancel() / pipe teardown).
      stream.onAbort(() => {
        stop();
        wake?.();
      });
      const signal = c.req.raw.signal;
      const onSignalAbort = (): void => {
        stop();
        wake?.();
      };
      if (signal.aborted) onSignalAbort();
      else signal.addEventListener("abort", onSignalAbort, { once: true });

      try {
        let lastSeq = cursor;
        let lastWrite = Date.now();

        for (;;) {
          if (stopped) return;

          // Replay/tail: everything past the cursor, in seq order.
          for (const event of db.events.getSince(runId, lastSeq)) {
            if (stopped) return;
            await stream.write(sseFrame(event));
            lastSeq = event.seq;
            lastWrite = Date.now();
            // Persisted terminal run.status: the engine's own closing event.
            if (event.type === "run.status" && isTerminalRunStatus(event.status)) {
              return;
            }
          }

          // Terminal run row without a persisted terminal run.status event
          // (legacy rows / aborts outside the engine): synthetic close.
          const run = db.runs.get(runId);
          if (run && isTerminalRunStatus(run.status)) {
            const lastStatus = db.events.lastRunStatus(runId);
            if (!(lastStatus && isTerminalRunStatus(lastStatus.status))) {
              if (!stopped) {
                await stream.write(
                  sseFrame({ type: "run.status", seq: lastSeq + 1, status: run.status }),
                );
              }
            }
            return;
          }

          // Interruptible poll sleep; heartbeat comments keep proxies from
          // reaping a quiet connection (fake driver runs can be silent).
          const sleep = delay(streamOptions.pollIntervalMs);
          try {
            await Promise.race([sleep.promise, aborted]);
          } finally {
            sleep.cancel();
          }
          if (stopped) return;
          if (Date.now() - lastWrite >= streamOptions.heartbeatMs) {
            await stream.write(": ping\n\n");
            lastWrite = Date.now();
          }
        }
      } finally {
        // Every exit path — normal close, throw, disconnect mid-sleep —
        // releases the concurrency slot and drops all timers/listeners.
        signal.removeEventListener("abort", onSignalAbort);
        release();
      }
    });
  });

  runs.post("/:id/abort", async (c) => {
    const db = requireDb(c);
    const executor = requireExecutor(c);
    const id = c.req.param("id");
    requireRun(db, id);

    let result;
    try {
      result = await executor.abortRun(id);
    } catch (err) {
      if (err instanceof DriverError) {
        throw new HttpError(
          500,
          "ABORT_FAILED",
          `driver failed to abort run ${id}: ${err.message}`,
        );
      }
      throw err;
    }

    if (result.outcome === "not_found") {
      throw new HttpError(404, "RUN_NOT_FOUND", `no run with id ${id}`);
    }
    if (result.outcome === "not_abortable") {
      throw new HttpError(
        409,
        "RUN_TERMINAL",
        `run ${id} already finished with status ${result.status}`,
      );
    }
    return c.json({ run: db.runs.get(id) });
  });

  // Resume an interrupted run in place: the engine continues from the current
  // step/iteration, restarting the interrupted step with its recorded
  // sessionId and reusing the existing worktree. Only possible when every
  // started StepRun recorded a sessionId — otherwise the agent context is
  // gone and only a retry can help.
  runs.post("/:id/resume", async (c) => {
    const db = requireDb(c);
    const executor = requireExecutor(c);
    const id = c.req.param("id");
    const run = requireRun(db, id);

    if (run.status !== "interrupted") {
      throw new HttpError(
        409,
        "RUN_NOT_INTERRUPTED",
        `run ${id} has status ${run.status}; only interrupted runs can be resumed`,
      );
    }
    const withoutSession = db.stepRuns.listByRun(id).filter((step) => step.sessionId === undefined);
    if (withoutSession.length > 0) {
      throw new HttpError(
        409,
        "RUN_RESUME_NOT_POSSIBLE",
        `run ${id} cannot be resumed: ${withoutSession.length} step run(s) (e.g. ${withoutSession[0]?.stepId}) recorded no sessionId, so the agent context is lost; retry the run instead via POST /api/runs/${id}/retry`,
      );
    }

    db.runs.updateStatus(id, "queued");
    c.get("logger").info({ runId: id }, "run resumed after interruption");
    executor.startRun(id);
    return c.json({ run: db.runs.get(id) }, 202);
  });

  // Retry any finished (terminal or interrupted) run as a NEW run: same
  // workflow (or ad-hoc task copy), same project, but a fresh runId — and
  // with it a fresh worktree/branch — enqueued through the normal scheduler.
  runs.post("/:id/retry", async (c) => {
    const db = requireDb(c);
    const executor = requireExecutor(c);
    const id = c.req.param("id");
    const run = requireRun(db, id);

    if (run.status === "queued" || run.status === "running") {
      throw new HttpError(
        409,
        "RUN_NOT_FINISHED",
        `run ${id} is still ${run.status}; abort it first if you want to retry`,
      );
    }
    if (!db.projects.get(run.projectId)) {
      throw new HttpError(
        409,
        "RETRY_PROJECT_MISSING",
        `project ${run.projectId} of run ${id} no longer exists; re-register it before retrying`,
      );
    }
    if (run.workflowId && !db.workflows.get(run.workflowId)) {
      throw new HttpError(
        409,
        "RETRY_WORKFLOW_MISSING",
        `workflow ${run.workflowId} of run ${id} no longer exists; re-create it before retrying`,
      );
    }

    const runId = randomUUID();
    const now = new Date().toISOString();
    const retry: Run = {
      id: runId,
      projectId: run.projectId,
      ...(run.workflowId === undefined ? {} : { workflowId: run.workflowId }),
      status: "queued",
      branch: branchForRun(runId),
      iteration: 0,
      ...(run.task === undefined ? {} : { task: run.task }),
      createdAt: now,
      updatedAt: now,
    };
    db.runs.create(retry);
    c.get("logger").info({ runId, sourceRunId: id }, "run retried as a new run");
    executor.startRun(runId);
    return c.json({ run: db.runs.get(runId) }, 202);
  });

  return runs;
}
