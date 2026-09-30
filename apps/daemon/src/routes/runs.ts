import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  Run,
  RunStatus,
  RunStatusEvent,
  StepRun,
  TerminalRunStatus,
} from "@openeuler/core";
import { TERMINAL_RUN_STATUSES, RunStatusSchema } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { DriverError } from "@openeuler/drivers";
import { branchForRun } from "@openeuler/engine";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import type { Executor } from "../executor.js";
import { HttpError } from "../errors.js";

/** Synthetic step concept backing ad-hoc runs (no workflow yet). */
export const ADHOC_STEP_ID = "adhoc";

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

/** Run detail payload: the run, its step runs, and a small summary. */
export interface RunDetailBody {
  run: Run;
  steps: StepRun[];
  summary: { eventCount: number };
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
function sseFrame(event: AgentEvent | RunStatusEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface CreateRunsRouterOptions {
  /** SSE tuning for `GET /api/runs/:id/events` (tests shrink the timers). */
  eventStream?: EventStreamOptions;
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
    db.stepRuns.create({
      id: randomUUID(),
      runId,
      stepId: ADHOC_STEP_ID,
      iteration: 1,
      status: "queued",
      output: "",
    });

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
    return c.json({ runs: db.runs.list(c.req.query("projectId") || undefined, status) });
  });

  runs.get("/:id", (c) => {
    const db = requireDb(c);
    const run = requireRun(db, c.req.param("id"));
    const body: RunDetailBody = {
      run,
      steps: db.stepRuns.listByRun(run.id),
      summary: { eventCount: db.events.count(run.id) },
    };
    return c.json(body);
  });

  // SSE live stream: replay persisted events (from the cursor) in seq order,
  // then tail the events table until the run reaches a terminal status, emit a
  // final synthetic `run.status` event, and close. The `run.status` event is
  // stream-only (never persisted — persisted events stay driver-only until
  // engine events land with #15) and reuses the per-run seq space (lastSeq+1)
  // so clients keep a monotonic cursor for Last-Event-ID reconnects.
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
          }

          // Terminal → final synthetic run.status, then close the stream.
          const run = db.runs.get(runId);
          if (run && isTerminalRunStatus(run.status)) {
            if (!stopped) {
              await stream.write(
                sseFrame({ type: "run.status", seq: lastSeq + 1, status: run.status }),
              );
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

  return runs;
}
