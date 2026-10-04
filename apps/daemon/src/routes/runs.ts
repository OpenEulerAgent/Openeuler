import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type {
  PersistedEvent,
  Run,
  RunStatus,
  StepRun,
  TerminalRunStatus,
  Workflow,
} from "@openeuler/core";
import {
  TERMINAL_RUN_STATUSES,
  RunHostingOptionsSchema,
  RunPortsSchema,
  RunStatusSchema,
  WorkflowGraphSchema,
} from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { DriverError } from "@openeuler/drivers";
import { ADHOC_STEP_ID, branchForRun } from "@openeuler/engine";
import type { ArtifactStore, WorktreeManager } from "@openeuler/engine";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import type { Executor, RunStatusNotification } from "../executor.js";
import { buildRunPortViews, buildRunHostingView } from "../executor.js";
import type { RunPortView, RunHostingView } from "../executor.js";
import { HttpError } from "../errors.js";
import { redactorForProject } from "../secrets.js";
import { realpathWithinRoot, resolveWithinRoot } from "./files.js";
import { ensureLatestRevision } from "./workflows.js";

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
  /**
   * Container ports the run declares (#107): unique integers 1..65535, at
   * most 3, published by a sandboxed run's sandbox while it lives.
   */
  ports: RunPortsSchema.optional(),
  /**
   * Keep-alive hosting request (#110): on a SUCCESSFUL sandboxed run that
   * declared ports, the sandbox stays up (previews live) for
   * `keepAliveMinutes` (default 60, 5..1440). Aborted/failed runs never
   * host; hosting applies to success only.
   */
  hosting: RunHostingOptionsSchema.optional(),
});

/**
 * `POST /api/runs/:id/hosting/extend` body (#110): whole minutes to add to
 * the hosted TTL (1..1440; the result is capped 24h from "now").
 */
const ExtendHostingBodySchema = z.strictObject({
  minutes: z
    .number({ message: "minutes must be a number" })
    .int("minutes must be an integer")
    .min(1, "minutes must be >= 1")
    .max(1440, "minutes must be <= 1440 (24h)"),
});

/**
 * `POST /api/runs/:id/approvals/:nodeId` body (#118): the decision plus an
 * optional note (≤2000 chars) recorded on the `node.approved` event and,
 * on approve, used as the node's output.
 */
const ApprovalBodySchema = z.strictObject({
  approve: z.boolean(),
  note: z
    .string({
      message: "note must be a string of at most 2000 characters (use an empty value to omit it)",
    })
    .max(2000, "note must be at most 2000 characters")
    .optional(),
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

/** Tunables for the global `GET /api/runs/stream`; overridable for tests. */
export interface GlobalStreamOptions {
  /** Idle heartbeat (`: ping` comment) interval. Default 15s. */
  heartbeatMs?: number;
  /** Max concurrent global streams before 429. Default 20. */
  maxStreams?: number;
}

const DEFAULT_EVENT_STREAM: Required<EventStreamOptions> = {
  pollIntervalMs: 100,
  heartbeatMs: 15_000,
  maxStreamsPerRun: 5,
};

const DEFAULT_GLOBAL_STREAM: Required<GlobalStreamOptions> = {
  heartbeatMs: 15_000,
  maxStreams: 20,
};

/** Serializes one global run-status transition as an SSE frame (#51). */
function globalRunStatusFrame(event: RunStatusNotification): string {
  return `event: run.status\ndata: ${JSON.stringify(event)}\n\n`;
}

const isTerminalRunStatus = (status: RunStatus): status is TerminalRunStatus =>
  (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

/**
 * A StepRun as served by `GET /api/runs/:id`: the core row plus display
 * enrichment (#113) — the node/step NAME and, for graph runs, the driver
 * duration from the run's `node.completed` event (linear `step.completed`
 * events carry no duration, so those steps keep `durationMs` unset).
 * Deliberately NOT part of the persisted core StepRun schema.
 */
export type StepRunApiBody = StepRun & {
  name?: string;
  durationMs?: number;
};

/** Run detail payload: the run, its step runs (flat + grouped per iteration), and a small summary. */
export interface RunDetailBody {
  run: RunApiBody;
  steps: StepRunApiBody[];
  /** Step runs grouped by 1-based loop pass, ordered by iteration. */
  iterations: Array<{ iteration: number; steps: StepRunApiBody[] }>;
  summary: { eventCount: number };
  /**
   * Live sandbox of the run, when it has one (#102): present only while the
   * run executes sandboxed (the sandbox is destroyed at terminal).
   */
  sandbox?: { id: string; image: string; status: string };
  /**
   * The run's previewable ports (#107): declared first (with a live host
   * mapping while the sandbox is alive), then detected-undeclared ones
   * (with the declare-to-preview hint). Absent when the run tracks none.
   */
  ports?: RunPortView[];
  /**
   * Hosting view while the run is hosted (#110): expiry timestamp + live
   * host mappings of the kept sandbox. `null`/absent when not hosted.
   */
  hosting?: RunHostingView | null;
  /**
   * The approval gate the run is currently waiting on (#118), when its row
   * carries `awaitingNodeId`: which node, the prompt shown to the
   * approver, and when the wait opened. Absent when the run is not
   * paused at a gate.
   */
  awaiting?: { nodeId: string; nodeName?: string; prompt: string; since: string };
}

/** Run list payload: runs plus computed queue metadata for queued rows. */
export interface RunListBody {
  runs: RunApiBody[];
  /**
   * Keyset cursor (`<createdAt>,<id>` of the last row) while another page may
   * exist — pass back as `?before=` (#62).
   */
  nextCursor?: string;
}

/** Page size bounds for `GET /api/runs`: responses stay bounded (#62). */
export const DEFAULT_RUNS_LIMIT = 50;
export const MAX_RUNS_LIMIT = 200;

/** Parses + clamps `?limit=` for the run list; default 50, clamped to 1..200. */
export function parseRunsLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RUNS_LIMIT;
  const parsed = z.coerce.number().int().safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      422,
      "INVALID_LIMIT",
      `limit must be an integer, got ${JSON.stringify(raw)}`,
    );
  }
  return Math.min(Math.max(parsed.data, 1), MAX_RUNS_LIMIT);
}

/**
 * Parses the run list's keyset cursor `?before=<createdAt>,<id>`: the last
 * row of the previous page, in the list's `(createdAt desc, id asc)` order.
 */
export function parseRunsCursor(
  raw: string | undefined,
): { createdAt: string; id: string } | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parts = raw.split(",");
  const createdAt = parts[0];
  const id = parts[1];
  if (
    parts.length !== 2 ||
    createdAt === undefined ||
    id === undefined ||
    createdAt === "" ||
    id === ""
  ) {
    throw new HttpError(
      422,
      "INVALID_CURSOR",
      `before must be "<createdAt>,<id>" of a run row, got ${JSON.stringify(raw)}`,
    );
  }
  return { createdAt, id };
}

/** Queue summary for dashboards: how many runs are queued vs executing. */
export interface RunStatsBody {
  queued: number;
  running: number;
  /** Echoed when `?projectId=` scopes the counts to one project (#51). */
  projectId?: string;
}

/**
 * A run as returned by the API: the core `Run` plus `queuePosition`, a
 * computed field present only while the run sits in the global queue, and
 * `workflowRevision` `{ id, number }`, resolved for runs pinned to a graph
 * revision snapshot. `project`/`workflow` carry resolved names for table
 * rendering (#51). `childRunIds` lists the sub-workflow child runs this
 * run spawned (#117), in spawn order. All are deliberately NOT part of the
 * persisted core Run schema.
 */
export type RunApiBody = Run & {
  queuePosition?: number;
  workflowRevision?: { id: string; number: number };
  project?: { id: string; name: string };
  workflow?: { id: string; name: string };
  /** Sub-workflow child runs spawned by this run (#117), spawn order. */
  childRunIds?: string[];
};

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

/** Attaches resolved names + revision/queue metadata to a run row. */
function decorateRun(db: Db, run: Run, positions?: Map<string, number>): RunApiBody {
  return decorateRuns(db, [run], positions)[0] as RunApiBody;
}

/**
 * Bulk {@link decorateRun} for list pages (#62): projects, workflows and
 * revisions are resolved with one query per kind over the page's unique
 * ids instead of per row.
 */
function decorateRuns(db: Db, rows: readonly Run[], positions?: Map<string, number>): RunApiBody[] {
  const unique = (ids: Array<string | undefined>): string[] => [
    ...new Set(ids.filter((id): id is string => id !== undefined)),
  ];
  const projects = new Map(
    db.projects
      .getMany(unique(rows.map((run) => run.projectId)))
      .map((project) => [project.id, project]),
  );
  const workflows = new Map(
    db.workflows
      .getMany(unique(rows.map((run) => run.workflowId)))
      .map((workflow) => [workflow.id, workflow]),
  );
  const revisions = new Map(
    db.workflowRevisions
      .getMany(unique(rows.map((run) => run.workflowRevisionId)))
      .map((revision) => [revision.id, revision]),
  );
  return rows.map((run) => {
    let body: RunApiBody = run;
    const project = projects.get(run.projectId);
    if (project !== undefined) {
      body = { ...body, project: { id: project.id, name: project.name } };
    }
    if (run.workflowId !== undefined) {
      const workflow = workflows.get(run.workflowId);
      if (workflow !== undefined) {
        body = { ...body, workflow: { id: workflow.id, name: workflow.name } };
      }
    }
    if (run.workflowRevisionId !== undefined) {
      const revision = revisions.get(run.workflowRevisionId);
      if (revision !== undefined) {
        body = { ...body, workflowRevision: { id: revision.id, number: revision.number } };
      }
    }
    // #117: sub-workflow children (spawn order) — present only when the run
    // spawned any, so ordinary runs keep their shape.
    const children = db.runs.listByParentRun(run.id);
    if (children.length > 0) {
      body = { ...body, childRunIds: children.map((child) => child.id) };
    }
    if (run.status === "queued" && positions !== undefined) {
      const queuePosition = positions.get(run.id);
      if (queuePosition !== undefined) body = { ...body, queuePosition };
    }
    return body;
  });
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
 * The run's open approval gate (#118), as served by `GET /api/runs/:id`:
 * `{nodeId, nodeName?, prompt, since}` from the run row
 * (`awaitingNodeId`/`awaitingSince`) plus the last persisted
 * `node.awaiting` event (prompt + node name; falls back to the pinned
 * graph's node config). Undefined when the run waits on nothing.
 */
export function buildRunAwaitingView(
  db: Db,
  run: Run,
): { nodeId: string; nodeName?: string; prompt: string; since: string } | undefined {
  if (run.awaitingNodeId === undefined) return undefined;
  const nodeId = run.awaitingNodeId;
  let prompt: string | undefined;
  let nodeName: string | undefined;
  const events = db.events.getSince(run.id);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && event.type === "node.awaiting" && event.nodeId === nodeId) {
      prompt = event.prompt;
      nodeName = event.nodeName;
      break;
    }
  }
  if (prompt === undefined && run.workflowRevisionId !== undefined) {
    const revision = db.workflowRevisions.get(run.workflowRevisionId);
    const parsed =
      revision === undefined ? undefined : WorkflowGraphSchema.safeParse(revision.graph);
    if (parsed !== undefined && parsed.success) {
      const node = parsed.data.nodes.find((candidate) => candidate.id === nodeId);
      if (node !== undefined && node.type === "approval") {
        prompt = node.config.prompt;
        nodeName = node.name;
      }
    }
  }
  return {
    nodeId,
    ...(nodeName === undefined ? {} : { nodeName }),
    prompt: prompt ?? "",
    since: run.awaitingSince ?? run.updatedAt,
  };
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
function groupByIteration(
  steps: StepRunApiBody[],
): Array<{ iteration: number; steps: StepRunApiBody[] }> {
  const groups = new Map<number, StepRunApiBody[]>();
  for (const step of steps) {
    const bucket = groups.get(step.iteration);
    if (bucket) bucket.push(step);
    else groups.set(step.iteration, [step]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([iteration, grouped]) => ({ iteration, steps: grouped }));
}

/** Cache key of a step run enrichment: `<stepId|nodeId>#<iteration>`. */
const stepEnrichmentKey = (stepId: string, iteration: number): string => `${stepId}#${iteration}`;

/** Per-step-run display fields joined in from the event log (#113). */
export interface StepRunEnrichment {
  name?: string;
  durationMs?: number;
}

/**
 * Per-step-run display enrichment (#113) off the run's persisted event log:
 * graph runs' `node.completed` events carry the node name AND the driver
 * duration; linear runs' `step.completed` events carry the step name only.
 * Keyed `${stepId}#${iteration}` — exactly how graph StepRun rows store
 * `stepId = nodeId` with the per-node 1-based execution number.
 */
export function stepEnrichments(events: readonly PersistedEvent[]): Map<string, StepRunEnrichment> {
  const byStepRun = new Map<string, StepRunEnrichment>();
  for (const event of events) {
    if (event.type === "node.completed") {
      byStepRun.set(stepEnrichmentKey(event.nodeId, event.iteration), {
        name: event.nodeName,
        durationMs: event.durationMs,
      });
    } else if (event.type === "step.completed") {
      const key = stepEnrichmentKey(event.stepId, event.iteration);
      const existing = byStepRun.get(key);
      byStepRun.set(key, { ...existing, name: event.stepName });
    }
  }
  return byStepRun;
}

/** Attaches {@link stepEnrichments} lookups to each step run row (#113). */
function enrichStepRuns(
  steps: readonly StepRun[],
  events: readonly PersistedEvent[],
): StepRunApiBody[] {
  const enrichments = stepEnrichments(events);
  return steps.map((step) => {
    const extra = enrichments.get(stepEnrichmentKey(step.stepId, step.iteration));
    return extra === undefined ? (step as StepRunApiBody) : { ...step, ...extra };
  });
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
  /** SSE tuning for the global `GET /api/runs/stream` (tests shrink the timers). */
  globalStream?: GlobalStreamOptions;
  /**
   * Worktree manager for `GET /api/runs/:id/diff?scope=cumulative` (computed
   * live in the run's worktree). Absent → that scope answers 503; the
   * per-step scope only reads stored rows and works without it.
   */
  worktrees?: WorktreeManager;
  /**
   * Artifact store for the run artifacts API (#122). Falls back to the
   * app-scoped instance from the context; absent → 503 ARTIFACTS_UNAVAILABLE.
   */
  artifacts?: ArtifactStore;
}

export function createRunsRouter(options: CreateRunsRouterOptions = {}): Hono<AppEnv> {
  const runs = new Hono<AppEnv>();
  const streamOptions: Required<EventStreamOptions> = {
    ...DEFAULT_EVENT_STREAM,
    ...options.eventStream,
  };
  const globalStreamOptions: Required<GlobalStreamOptions> = {
    ...DEFAULT_GLOBAL_STREAM,
    ...options.globalStream,
  };
  /** Active SSE stream count per run id; guards the concurrent-stream cap. */
  const activeStreams = new Map<string, number>();
  /** Active global stream count; guards the global-stream cap. */
  const activeGlobalStreams = { count: 0 };

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
      // #93 redacted-at-rest: the task is free text a secret can be pasted
      // into, and the row is served back verbatim by the API — so values are
      // swapped for ***NAME*** markers BEFORE the row is written. Run detail
      // (and the driver prompt, which renders this same text) therefore
      // shows the redacted task; agents consume secret values via env, not
      // via the prompt.
      task: redactorForProject(db, c.get("secretsKey"), project.id)(body.prompt),
      // #107: declared container ports, persisted on the row; the run's
      // sandbox publishes them for its lifetime.
      ...(body.ports === undefined || body.ports.length === 0 ? {} : { ports: body.ports }),
      // #110: hosting request, persisted on the row; the executor arms it
      // when the run turns success sandboxed with declared ports.
      ...(body.hosting === undefined ? {} : { hosting: body.hosting }),
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
    // `status` accepts a comma-separated list (dashboard multi-select, #51):
    // every value must be a valid status; an empty segment is rejected.
    const statusRaw = c.req.query("status");
    let statuses: RunStatus[] | undefined;
    if (statusRaw !== undefined && statusRaw !== "") {
      const parsed = statusRaw.split(",").map((value) => RunStatusSchema.safeParse(value));
      const invalid = parsed.findIndex((result) => !result.success);
      if (invalid !== -1) {
        throw new HttpError(
          422,
          "INVALID_STATUS",
          `status must be one of queued|running|success|failed|aborted|interrupted, got ${JSON.stringify(statusRaw.split(",")[invalid])}`,
        );
      }
      statuses = parsed.map((result) => {
        if (!result.success) throw new Error("unreachable");
        return result.data;
      });
    }
    const all = db.runs.list(c.req.query("projectId") || undefined);
    const filtered =
      statuses === undefined ? all : all.filter((run) => statuses.includes(run.status));
    const limit = parseRunsLimit(c.req.query("limit"));
    const before = parseRunsCursor(c.req.query("before"));
    // `all` is `(createdAt desc, id asc)`; the cursor keeps that order
    // stable across pages (no offset drift as new runs arrive).
    const afterCursor = filtered.filter(
      (run) =>
        before === undefined ||
        run.createdAt < before.createdAt ||
        (run.createdAt === before.createdAt && run.id > before.id),
    );
    const hasMore = afterCursor.length > limit;
    const page = hasMore ? afterCursor.slice(0, limit) : afterCursor;
    const last = page[page.length - 1];
    const positions = queuePositionsByRunId(db);
    const body: RunListBody = {
      runs: decorateRuns(db, page, positions),
      ...(hasMore && last !== undefined ? { nextCursor: `${last.createdAt},${last.id}` } : {}),
    };
    return c.json(body);
  });

  // Registered before `/:id` so "stats" is not captured as a run id.
  runs.get("/stats", (c) => {
    const db = requireDb(c);
    const projectId = c.req.query("projectId") || undefined;
    const body: RunStatsBody = {
      queued: db.runs.list(projectId, "queued").length,
      running: db.runs.list(projectId, "running").length,
      ...(projectId === undefined ? {} : { projectId }),
    };
    return c.json(body);
  });

  // Global run-status stream (#51): one subscription covers every run on the
  // daemon. Pushes a `run.status` frame whenever ANY run transitions
  // (queued admission, running start, terminal) — live-only, no replay:
  // latest state comes from the runs table, the stream is for changes.
  // Quiet connections get `: ping` heartbeats so proxies do not reap them.
  runs.get("/stream", (c) => {
    const executor = requireExecutor(c);

    const active = activeGlobalStreams;
    if (active.count >= globalStreamOptions.maxStreams) {
      throw new HttpError(
        429,
        "TOO_MANY_STREAMS",
        `the daemon already has ${active.count} global run streams (max ${globalStreamOptions.maxStreams})`,
      );
    }
    active.count += 1;

    return streamSSE(c, async (stream) => {
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        active.count -= 1;
      };

      let stopped = false;
      const stop = (): void => {
        stopped = true;
      };
      let wake: (() => void) | null = null;
      const notified = new Promise<void>((resolve) => {
        wake = resolve;
      });
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

      // Frames land in a queue from the listener (sync), and the loop below
      // is the only writer — frames never interleave mid-write.
      const frames: string[] = [];
      let onEvent: (() => void) | null = null;
      const unsubscribe = executor.onRunStatus((event) => {
        frames.push(globalRunStatusFrame(event));
        onEvent?.();
      });

      try {
        for (;;) {
          while (frames.length > 0) {
            const frame = frames.shift() as string;
            if (stopped) return;
            await stream.write(frame);
          }
          if (stopped) return;

          const pulse = delay(globalStreamOptions.heartbeatMs);
          const eventGate = new Promise<void>((resolve) => {
            onEvent = resolve;
          });
          try {
            await Promise.race([pulse.promise, eventGate, notified]);
          } finally {
            pulse.cancel();
          }
          if (stopped) return;
          if (frames.length === 0) {
            await stream.write(": ping\n\n");
          }
        }
      } finally {
        unsubscribe();
        signal.removeEventListener("abort", onSignalAbort);
        release();
      }
    });
  });

  runs.get("/:id", async (c) => {
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
    const sorted = enrichStepRuns(
      [...steps].sort((a, b) => {
        const ai = order.get(a.stepId) ?? Number.MAX_SAFE_INTEGER;
        const bi = order.get(b.stepId) ?? Number.MAX_SAFE_INTEGER;
        return ai === bi ? a.stepId.localeCompare(b.stepId) : ai - bi;
      }),
      db.events.getSince(run.id, 0),
    );
    // #102: live sandbox snapshot while the run executes sandboxed; absent
    // for local runs and after the sandbox's dispose.
    const executor = c.get("executor");
    const sandbox = executor === undefined ? undefined : await executor.sandboxInfo(run.id);
    // #107: port views. While the sandbox lives they carry live host
    // mappings (from sandboxInfo); afterwards (or for local runs) the same
    // list renders without hosts — declared ports keep the declare flag,
    // detected-undeclared ones keep the hint.
    const ports = sandbox?.ports ?? buildRunPortViews(run.ports, run.detectedPorts, {});
    // #110: hosting view — expiry + live host mappings while the hosted
    // sandbox lives (null when the run is not hosted).
    const hosting = buildRunHostingView(run, sandbox);
    // #118: the open approval gate, when the run is paused at one.
    const awaiting = buildRunAwaitingView(db, run);
    const body: RunDetailBody = {
      run: decorateRun(db, run, queuePositionsByRunId(db)),
      steps: sorted,
      iterations: groupByIteration(sorted),
      summary: { eventCount: db.events.count(run.id) },
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(ports.length === 0 ? {} : { ports }),
      hosting,
      ...(awaiting === undefined ? {} : { awaiting }),
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
    // #93: the cumulative diff is computed live from the worktree on disk —
    // the one diff surface that never passes through the engine's
    // redacted-before-persist writes — so scrub it (stat too: a secret
    // pasted into a file name would otherwise survive in the summary)
    // before responding. Redact before capping so the cap counts the
    // served lines.
    const redact = redactorForProject(db, c.get("secretsKey"), run.projectId);
    const capped = capPatchLines(redact(patch));
    const body: RunDiffBody = {
      scope,
      stat: redact(stat),
      ...capped,
      maxLines: MAX_DIFF_PATCH_LINES,
    };
    return c.json(body);
  });

  // ---------------------------------------------------------------------------
  // GET /api/runs/:id/artifacts[/:file] — durable run artifacts (#122).
  //
  // The engine copies pattern-matched files out of a terminal run's worktree
  // into the artifact store (data/artifacts/<runId>/, manifest.json
  // alongside); the copy survives worktree cleanup. Listing and download are
  // TERMINAL-ONLY — nothing exists to show before the run finishes.

  /** Resolves the artifact store; 503 when the daemon runs without one. */
  const requireArtifacts = (c: Context<AppEnv>): ArtifactStore => {
    const artifacts = options.artifacts ?? c.get("artifacts");
    if (!artifacts) {
      throw new HttpError(
        503,
        "ARTIFACTS_UNAVAILABLE",
        "artifact store is not configured; run artifacts are unavailable",
      );
    }
    return artifacts;
  };

  /**
   * The run's capture manifest — 409 while the run is live (artifacts are
   * captured at terminal), 409 when a capture directory exists but its
   * manifest has not landed yet, and 404 when no capture exists.
   */
  const requireArtifactManifest = (
    artifacts: ArtifactStore,
    run: Run,
  ): NonNullable<ReturnType<ArtifactStore["manifest"]>> => {
    if (!isTerminalRunStatus(run.status)) {
      throw new HttpError(
        409,
        "RUN_NOT_TERMINAL",
        `run ${run.id} is still ${run.status}; artifacts are captured when the run finishes`,
      );
    }
    const manifest = artifacts.manifest(run.id);
    if (manifest === null) {
      if (existsSync(artifacts.dirFor(run.id))) {
        throw new HttpError(
          409,
          "ARTIFACTS_PENDING",
          `run ${run.id} is terminal but its artifact capture has not finished yet`,
        );
      }
      throw new HttpError(
        404,
        "ARTIFACTS_NOT_FOUND",
        `run ${run.id} has no captured artifacts — its workflow revision declared no artifact patterns, or the capture matched no files`,
      );
    }
    return manifest;
  };

  runs.get("/:id/artifacts", (c) => {
    const db = requireDb(c);
    const artifacts = requireArtifacts(c);
    const run = requireRun(db, c.req.param("id"));
    const manifest = requireArtifactManifest(artifacts, run);
    return c.json(manifest);
  });

  runs.get("/:id/artifacts/:file{.+}", async (c) => {
    const db = requireDb(c);
    const artifacts = requireArtifacts(c);
    const run = requireRun(db, c.req.param("id"));
    const manifest = requireArtifactManifest(artifacts, run);

    const file = c.req.param("file") ?? "";
    // Defense in depth (and no filesystem probing): only files the manifest
    // recorded are servable, so a stray leftover cannot be probed.
    if (!manifest.files.some((entry) => entry.path === file)) {
      throw new HttpError(
        404,
        "ARTIFACT_NOT_FOUND",
        `artifact "${file}" is not part of run ${run.id}'s captured set`,
      );
    }
    // Two independent guards (#122): lexical containment (resolveWithinRoot
    // → 403 PATH_ESCAPE on `..`/absolute traversal) and realpath containment
    // (a symlink planted in the store cannot serve bytes from outside it).
    const resolved = resolveWithinRoot(artifacts.dirFor(run.id), file, "artifact store");
    const real = await realpathWithinRoot(artifacts.dirFor(run.id), resolved, "artifact store");

    let stats;
    try {
      stats = await stat(real);
    } catch {
      throw new HttpError(
        404,
        "ARTIFACT_NOT_FOUND",
        `artifact "${file}" of run ${run.id} is not on disk (its capture may have been pruned)`,
      );
    }
    if (!stats.isFile()) {
      throw new HttpError(422, "ARTIFACT_NOT_FILE", `artifact "${file}" is not a regular file`);
    }

    let bytes;
    try {
      bytes = await readFile(real);
    } catch {
      throw new HttpError(
        404,
        "ARTIFACT_NOT_FOUND",
        `artifact "${file}" of run ${run.id} disappeared while being read`,
      );
    }
    const basename = file.split("/").pop() ?? "artifact";
    const safeName = basename.replace(/[^\w.-]+/g, "_") || "artifact";
    c.header("Content-Type", "application/octet-stream");
    c.header(
      "Content-Disposition",
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(basename)}`,
    );
    return c.body(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), 200);
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
    return c.json({ run: decorateRun(db, db.runs.get(id) as Run) });
  });

  // Stop hosting NOW (#110): destroys the hosted sandbox, clears
  // `hostedUntil` (the run stays `success` — previews die with the
  // sandbox). 409 when the run is not currently hosted.
  runs.post("/:id/hosting/stop", async (c) => {
    const db = requireDb(c);
    const executor = requireExecutor(c);
    const id = c.req.param("id");
    const run = requireRun(db, id);

    const result = await executor.stopHosting(id);
    if (result.outcome === "not_hosted") {
      throw new HttpError(
        409,
        "RUN_NOT_HOSTED",
        `run ${id} (status ${run.status}) is not currently hosted; only hosted runs can stop hosting`,
      );
    }
    return c.json({ run: decorateRun(db, db.runs.get(id) as Run) });
  });

  // Extend a hosted run's TTL (#110): `hostedUntil += minutes`, capped 24h
  // from now and never shrinking. 409 when the run is not currently
  // hosted; 422 on invalid minutes.
  runs.post("/:id/hosting/extend", async (c) => {
    const db = requireDb(c);
    const executor = requireExecutor(c);
    const id = c.req.param("id");
    const run = requireRun(db, id);
    const body = ExtendHostingBodySchema.parse(await parseJsonBody(c));

    const result = await executor.extendHosting(id, body.minutes);
    if (result.outcome === "not_hosted") {
      throw new HttpError(
        409,
        "RUN_NOT_HOSTED",
        `run ${id} (status ${run.status}) is not currently hosted; only hosted runs can extend hosting`,
      );
    }
    const sandbox = await executor.sandboxInfo(id);
    return c.json({ hosting: buildRunHostingView(db.runs.get(id) as Run, sandbox) });
  });

  // Resolve an approval gate (#118): `POST /api/runs/:id/approvals/:nodeId`
  // with `{approve: boolean, note?}`. 404 when the run or the node (in the
  // run's pinned graph) does not exist; 409 when the run is not currently
  // awaiting THAT node (already resolved, different node, restarted
  // daemon, or the node is not an approval node). Resolving wakes the run
  // in place — it continues on the normal execution path.
  runs.post("/:id/approvals/:nodeId", async (c) => {
    const db = requireDb(c);
    const executor = requireExecutor(c);
    const id = c.req.param("id");
    const nodeId = c.req.param("nodeId");
    const run = requireRun(db, id);
    const body = ApprovalBodySchema.parse(await parseJsonBody(c));

    // The node must exist in the run's pinned graph revision.
    if (run.workflowRevisionId === undefined) {
      throw new HttpError(
        404,
        "NODE_NOT_FOUND",
        `run ${id} has no graph revision, so it has no node ${nodeId}`,
      );
    }
    const revision = db.workflowRevisions.get(run.workflowRevisionId);
    const parsed =
      revision === undefined ? undefined : WorkflowGraphSchema.safeParse(revision.graph);
    const node =
      parsed !== undefined && parsed.success
        ? parsed.data.nodes.find((candidate) => candidate.id === nodeId)
        : undefined;
    if (node === undefined) {
      throw new HttpError(
        404,
        "NODE_NOT_FOUND",
        `node ${nodeId} does not exist in the graph revision pinned by run ${id}`,
      );
    }

    const result = executor.resolveApproval(id, nodeId, body.approve, body.note);
    if (result.outcome === "not_awaiting") {
      throw new HttpError(
        409,
        "RUN_NOT_AWAITING",
        `run ${id} (status ${run.status}) is not currently awaiting approval on node ${nodeId}`,
      );
    }
    c.get("logger").info({ runId: id, nodeId, approved: body.approve }, "approval resolved");
    return c.json({ run: decorateRun(db, db.runs.get(id) as Run) });
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
    // Sub-workflow node executions (#117) never record a sessionId (the
    // child run's own StepRuns carry the sessions) — and neither do
    // approval gates (#118, a human wait, no driver) — only AGENT rows
    // need one for context-preserving resume. Look up the pinned graph's
    // node kinds to exempt them from the guard.
    const sessionlessStepIds = new Set<string>();
    if (run.workflowRevisionId !== undefined) {
      const revision = db.workflowRevisions.get(run.workflowRevisionId);
      const parsed =
        revision === undefined ? undefined : WorkflowGraphSchema.safeParse(revision.graph);
      if (parsed !== undefined && parsed.success) {
        for (const node of parsed.data.nodes) {
          if (node.type === "subworkflow" || node.type === "approval") {
            sessionlessStepIds.add(node.id);
          }
        }
      }
    }
    const withoutSession = db.stepRuns
      .listByRun(id)
      .filter((step) => step.sessionId === undefined && !sessionlessStepIds.has(step.stepId));
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
    return c.json({ run: decorateRun(db, db.runs.get(id) as Run) }, 202);
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
    // A retried workflow run pins the workflow's CURRENT latest revision
    // (same rule as a fresh run creation), not the original run's snapshot.
    let pinnedRevisionId: string | undefined;
    if (run.workflowId !== undefined) {
      const workflow = db.workflows.get(run.workflowId) as Workflow;
      pinnedRevisionId = ensureLatestRevision(db, workflow).id;
    }
    const retry: Run = {
      id: runId,
      projectId: run.projectId,
      ...(run.workflowId === undefined ? {} : { workflowId: run.workflowId }),
      ...(pinnedRevisionId === undefined ? {} : { workflowRevisionId: pinnedRevisionId }),
      status: "queued",
      branch: branchForRun(runId),
      iteration: 0,
      // #93: re-redact the copied task — normally already redacted at rest,
      // but rows written before redaction-at-rest (or a secret added after
      // the original run was stored) still get scrubbed on copy.
      ...(run.task === undefined
        ? {}
        : { task: redactorForProject(db, c.get("secretsKey"), run.projectId)(run.task) }),
      // #107: declared ports carry over to the retry (detection restarts).
      ...(run.ports === undefined || run.ports.length === 0 ? {} : { ports: run.ports }),
      // #110: the hosting request carries over too (hostedUntil does NOT —
      // the new run hosts fresh on its own success).
      ...(run.hosting === undefined ? {} : { hosting: run.hosting }),
      createdAt: now,
      updatedAt: now,
    };
    db.runs.create(retry);
    c.get("logger").info({ runId, sourceRunId: id }, "run retried as a new run");
    executor.startRun(runId);
    return c.json({ run: decorateRun(db, db.runs.get(runId) as Run) }, 202);
  });

  return runs;
}
