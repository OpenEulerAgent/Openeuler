import { z } from "zod";
import { idSchema, timestampSchema } from "./common.js";

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "success",
  "failed",
  "aborted",
  "interrupted",
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * Statuses a run never leaves; the SSE layer closes streams on these.
 * `awaiting_approval` is deliberately NOT here — a run stays `running`
 * while paused at an approval gate (#118).
 */
export const TERMINAL_RUN_STATUSES = ["success", "failed", "aborted", "interrupted"] as const;

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const TerminalRunStatusSchema = z.enum(TERMINAL_RUN_STATUSES);

/**
 * Max ports a run tracks (#107), declared or detected: previews surface a
 * handful of services, not a port scanner.
 */
export const MAX_RUN_PORTS = 3;

const portNumberSchema = z
  .number()
  .int("port must be an integer")
  .min(1, "port must be >= 1")
  .max(65535, "port must be <= 65535");

/**
 * The port list a run carries (#107): unique integers 1..65535, at most
 * {@link MAX_RUN_PORTS}. Shared by run-creation bodies (validated with
 * actionable issues) and the stored `Run` row.
 */
export const RunPortsSchema = z
  .array(portNumberSchema)
  .max(MAX_RUN_PORTS, `at most ${MAX_RUN_PORTS} ports per run`)
  .refine((ports) => new Set(ports).size === ports.length, "ports must be unique (no duplicates)");

/** A run's declared or detected port list; empty is omitted on the row. */
export type RunPorts = number[];

/**
 * Default hosting keep-alive window (#110): how long a successfully hosted
 * run's sandbox stays up past run success (minutes).
 */
export const DEFAULT_HOSTING_KEEP_ALIVE_MINUTES = 60;

/** Smallest accepted `hosting.keepAliveMinutes` (#110). */
export const MIN_HOSTING_KEEP_ALIVE_MINUTES = 5;

/** Largest accepted `hosting.keepAliveMinutes` — 24h (#110). */
export const MAX_HOSTING_KEEP_ALIVE_MINUTES = 24 * 60;

/**
 * Hard ceiling on `hostedUntil` relative to "now" when extending (#110):
 * no amount of extends pushes a hosted sandbox more than 24h out.
 */
export const MAX_HOSTING_EXTEND_MINUTES = 24 * 60;

const keepAliveMinutesSchema = z
  .number()
  .int("keepAliveMinutes must be an integer")
  .min(
    MIN_HOSTING_KEEP_ALIVE_MINUTES,
    `keepAliveMinutes must be >= ${MIN_HOSTING_KEEP_ALIVE_MINUTES}`,
  )
  .max(
    MAX_HOSTING_KEEP_ALIVE_MINUTES,
    `keepAliveMinutes must be <= ${MAX_HOSTING_KEEP_ALIVE_MINUTES} (24h)`,
  );

/**
 * The hosting option of a run-creation body (#110): keep the run's sandbox
 * alive after a SUCCESSFUL sandboxed run that declared ports, so previews
 * stay live for a TTL window. Aborted/failed runs never host — hosting
 * applies to success only.
 */
export const RunHostingOptionsSchema = z.strictObject({
  enabled: z.boolean(),
  /** TTL in minutes; default {@link DEFAULT_HOSTING_KEEP_ALIVE_MINUTES}. */
  keepAliveMinutes: keepAliveMinutesSchema.optional(),
});

/** `hosting` as persisted on the Run row. */
export type RunHostingOptions = z.infer<typeof RunHostingOptionsSchema>;

/** Effective keep-alive window of a hosting option (default 60 minutes). */
export function hostingKeepAliveMinutes(hosting: RunHostingOptions | undefined): number {
  return hosting?.keepAliveMinutes ?? DEFAULT_HOSTING_KEEP_ALIVE_MINUTES;
}

/**
 * A single execution of a workflow (or an ad-hoc task) against a project's
 * working copy on its own branch.
 */
const breadcrumbIterationSchema = z
  .number()
  .int()
  .min(1, "breadcrumb iteration must be an integer >= 1");

/**
 * One step of a graph run's execution breadcrumb (#45): a completed node
 * execution (`kind: "node"`, its 1-based execution number) or a taken edge
 * (`kind: "edge"`, the 1-based execution number of the source node whose
 * output routed). The ordered list on the run row is exactly what replaying
 * the run's `node.completed` + `edge.taken` events reconstructs — it powers
 * the live graph view / replay (#52).
 */
export const BreadcrumbEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("node"),
    nodeId: idSchema,
    iteration: breadcrumbIterationSchema,
  }),
  z.strictObject({
    kind: z.literal("edge"),
    edgeId: idSchema,
    iteration: breadcrumbIterationSchema,
  }),
]);

export type BreadcrumbEntry = z.infer<typeof BreadcrumbEntrySchema>;

export const RunSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  /** Set for workflow runs; absent for ad-hoc runs driven by `task`. */
  workflowId: idSchema.optional(),
  /**
   * Graph revision snapshot this run is pinned to (set at creation); edits to
   * the workflow afterwards never affect the run. Absent for ad-hoc runs and
   * pre-graph legacy runs.
   */
  workflowRevisionId: idSchema.optional(),
  /**
   * Set when this run is the CHILD of a sub-workflow node execution (#117):
   * the id of the parent run whose graph spawned it. Child runs execute
   * INLINE within their parent's execution context (they never occupy their
   * own scheduler slot) but are ordinary rows in every other respect — own
   * worktree/branch, own event log, own StepRuns.
   */
  parentRunId: idSchema.optional(),
  status: RunStatusSchema,
  branch: z.string().min(1, "branch must be a non-empty string"),
  /** Current loop iteration, 0-based (`0` on the first pass). */
  iteration: z.number().int().min(0, "iteration must be an integer >= 0"),
  /** Free-form task/prompt for ad-hoc runs. */
  task: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  /**
   * Ordered execution breadcrumb (graph runs, #45): completed node
   * executions and taken edges in order. Absent/empty for runs that have
   * not traversed a graph yet (legacy/ad-hoc runs never populate it).
   */
  breadcrumb: z.array(BreadcrumbEntrySchema).optional(),
  /**
   * Container ports declared at creation (#107): published by the run's
   * sandbox (`docker -p host::port`) so they are previewable while it
   * lives. Absent = none declared.
   */
  ports: RunPortsSchema.optional(),
  /**
   * Ports auto-detected from step/node outputs during execution (#107),
   * sandboxed runs only; grows as detection progresses. Detection of an
   * UNdeclared port records the number but is not published (v0.2 cut).
   */
  detectedPorts: RunPortsSchema.optional(),
  /**
   * Hosting request persisted at creation (#110): when enabled, a
   * SUCCESSFUL sandboxed run that declared ports keeps its sandbox alive
   * for `keepAliveMinutes` (default 60) past success so previews stay
   * live. Absent = hosting not requested.
   */
  hosting: RunHostingOptionsSchema.optional(),
  /**
   * While the run is hosted (#110): the ISO timestamp the hosted sandbox
   * expires (set when hosting starts, bumped by extends, capped 24h from
   * each extend's "now"). Cleared when hosting ends (expiry, Stop
   * hosting, or the sandbox dying across a daemon restart); the run row
   * itself stays `success`.
   */
  hostedUntil: timestampSchema.optional(),
  /**
   * Set while the run is paused at an approval gate (#118): the id of the
   * APPROVAL node the engine is waiting on. Written when the gate opens,
   * cleared on resolution/timeout/abort; survives a daemon restart (the
   * boot sweep keeps it) so resume re-enters the await without
   * re-executing the node.
   */
  awaitingNodeId: idSchema.optional(),
  /**
   * When the current approval gate opened (#118): ISO timestamp, written
   * alongside `awaitingNodeId`. Powers the run detail banner's "waiting
   * since" line.
   */
  awaitingSince: timestampSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export type Run = z.infer<typeof RunSchema>;

/**
 * Statuses a StepRun row may carry: the run statuses plus
 * `awaiting_approval` (#118) — an approval gate node's execution paused
 * mid-run waiting for a human decision (or its timeout). Additive over
 * {@link RunStatusSchema}; runs themselves never carry this status.
 */
export const StepRunStatusSchema = z.enum([...RunStatusSchema.options, "awaiting_approval"]);

export type StepRunStatus = z.infer<typeof StepRunStatusSchema>;

/**
 * One step's execution inside a run, tied to an agent session when kept.
 * `iteration` is the 1-based loop pass (`1` on the first pass), matching what
 * prompt templates receive via `{{iterations}}`.
 */
export const StepRunSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  stepId: idSchema,
  iteration: z.number().int().min(1, "iteration must be an integer >= 1"),
  sessionId: z.string().optional(),
  status: StepRunStatusSchema,
  output: z.string(),
  diff: z.string().optional(),
  /**
   * Attempt count this execution settled on (#119): 1 (or absent, on
   * pre-#119 rows) when the node ran once; higher when a retry policy
   * re-executed the node. One row per node execution — attempts update it
   * in place.
   */
  attempt: z.number().int().min(1, "attempt must be an integer >= 1").optional(),
});

export type StepRun = z.infer<typeof StepRunSchema>;
