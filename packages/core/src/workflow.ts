import { z } from "zod";
import { idSchema } from "./common.js";
import { isValidRegex } from "./regex.js";

/**
 * Invocation config shared by linear steps and graph nodes: which driver
 * (optionally model/agent) to talk to, in which mode, with what prompt
 * template and session-chaining behavior.
 */
export const StepConfigSchema = z.strictObject({
  /** Agent driver id, e.g. "opencode" or "claude". */
  driver: z.string().min(1, "driver must be a non-empty string"),
  model: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  mode: z.enum(["auto", "ask"]),
  promptTemplate: z.string().min(1, "promptTemplate must be a non-empty string"),
  continueSession: z.boolean(),
});

export type StepConfig = z.infer<typeof StepConfigSchema>;

/** A single, fully user-defined agent invocation inside a workflow. */
export const StepSchema = StepConfigSchema.extend({
  id: idSchema,
  name: z.string().min(1, "step name must be a non-empty string"),
});

export type Step = z.infer<typeof StepSchema>;

export const AlwaysConditionSchema = z.strictObject({
  type: z.literal("always"),
});

export type AlwaysCondition = z.infer<typeof AlwaysConditionSchema>;

export const OutputContainsConditionSchema = z.strictObject({
  type: z.literal("outputContains"),
  pattern: z.string().min(1, "pattern must be a non-empty string"),
});

export type OutputContainsCondition = z.infer<typeof OutputContainsConditionSchema>;

export const OutputNotContainsConditionSchema = z.strictObject({
  type: z.literal("outputNotContains"),
  pattern: z.string().min(1, "pattern must be a non-empty string"),
});

export type OutputNotContainsCondition = z.infer<typeof OutputNotContainsConditionSchema>;

const regexFlagsSchema = z.string().regex(/^[dgimsuvy]*$/, {
  message: "flags may only contain the characters: d g i m s u v y",
});

export const OutputMatchesConditionSchema = z
  .strictObject({
    type: z.literal("outputMatches"),
    regex: z.string().min(1, "regex must be a non-empty string"),
    flags: regexFlagsSchema.optional(),
  })
  .refine(({ regex, flags }) => isValidRegex(regex, flags), {
    message: "invalid regular expression: regex/flags do not compile",
  });

export type OutputMatchesCondition = z.infer<typeof OutputMatchesConditionSchema>;

/** Condition evaluated against a step's output to decide control flow. */
export const ExitConditionSchema = z.discriminatedUnion("type", [
  AlwaysConditionSchema,
  OutputContainsConditionSchema,
  OutputNotContainsConditionSchema,
  OutputMatchesConditionSchema,
]);

export type ExitCondition = z.infer<typeof ExitConditionSchema>;

/** Jump back to an earlier step until `when` is met (exit condition), bounded by maxIterations. */
export const LoopBackSchema = z.strictObject({
  toStepIndex: z.number().int().min(0, "toStepIndex must be an integer >= 0"),
  when: ExitConditionSchema,
  maxIterations: z.number().int().min(1, "maxIterations must be an integer >= 1"),
});

export type LoopBack = z.infer<typeof LoopBackSchema>;

/** Structural workflow shape, before the cross-field loopBack refinement. */
export const WorkflowShapeSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  name: z.string().min(1, "workflow name must be a non-empty string"),
  steps: z.array(StepSchema).min(1, "a workflow needs at least one step"),
  loopBack: LoopBackSchema.optional(),
});

/**
 * Cross-field check (shared by {@link WorkflowSchema} and API bodies):
 * `loopBack.toStepIndex` must reference an existing step. Returns the issue
 * message, or `undefined` when the bounds hold.
 */
export function loopBackToStepIndexIssue(workflow: {
  steps: readonly unknown[];
  loopBack?: { toStepIndex: number } | undefined;
}): string | undefined {
  const loopBack = workflow.loopBack;
  if (loopBack === undefined) return undefined;
  if (loopBack.toStepIndex >= workflow.steps.length) {
    return `loopBack.toStepIndex must be < steps.length (got ${loopBack.toStepIndex}, but the workflow has ${workflow.steps.length} step(s))`;
  }
  return undefined;
}

/**
 * A workflow as persisted: the legacy linear mirror (`steps` + optional
 * `loopBack`) plus the latest graph revision number, when the workflow has
 * revisions. The graph itself is immutable per revision
 * (`workflow_revisions`); this mirror is what pre-graph consumers (the web
 * builder) keep editing.
 */
export const WorkflowSchema = WorkflowShapeSchema.extend({
  latestRevisionNumber: z.number().int().min(1).optional(),
}).superRefine((workflow, ctx) => {
  const issue = loopBackToStepIndexIssue(workflow);
  if (issue !== undefined) {
    ctx.addIssue({ code: "custom", path: ["loopBack", "toStepIndex"], message: issue });
  }
});

export type Workflow = z.infer<typeof WorkflowSchema>;
