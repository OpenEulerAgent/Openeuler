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

/** Statuses a run never leaves; the SSE layer closes streams on these. */
export const TERMINAL_RUN_STATUSES = ["success", "failed", "aborted", "interrupted"] as const;

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const TerminalRunStatusSchema = z.enum(TERMINAL_RUN_STATUSES);

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
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export type Run = z.infer<typeof RunSchema>;

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
  status: RunStatusSchema,
  output: z.string(),
  diff: z.string().optional(),
});

export type StepRun = z.infer<typeof StepRunSchema>;
