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
export const RunSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  /** Set for workflow runs; absent for ad-hoc runs driven by `task`. */
  workflowId: idSchema.optional(),
  status: RunStatusSchema,
  branch: z.string().min(1, "branch must be a non-empty string"),
  /** Current loop iteration (0 on the first pass). */
  iteration: z.number().int().min(0, "iteration must be an integer >= 0"),
  /** Free-form task/prompt for ad-hoc runs. */
  task: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export type Run = z.infer<typeof RunSchema>;

/** One step's execution inside a run, tied to an agent session when kept. */
export const StepRunSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  stepId: idSchema,
  iteration: z.number().int().min(0, "iteration must be an integer >= 0"),
  sessionId: z.string().optional(),
  status: RunStatusSchema,
  output: z.string(),
  diff: z.string().optional(),
});

export type StepRun = z.infer<typeof StepRunSchema>;
