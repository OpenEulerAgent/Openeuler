import { z } from "zod";
import { idSchema } from "./common.js";
import { isValidRegex } from "./regex.js";

/** A single, fully user-defined agent invocation inside a workflow. */
export const StepSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1, "step name must be a non-empty string"),
  /** Agent driver id, e.g. "opencode" or "claude". */
  driver: z.string().min(1, "driver must be a non-empty string"),
  model: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  mode: z.enum(["auto", "ask"]),
  promptTemplate: z.string().min(1, "promptTemplate must be a non-empty string"),
  continueSession: z.boolean(),
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

/** Jump back to an earlier step while `when` holds, bounded by maxIterations. */
export const LoopBackSchema = z.strictObject({
  toStepIndex: z.number().int().min(0, "toStepIndex must be an integer >= 0"),
  when: ExitConditionSchema,
  maxIterations: z.number().int().min(1, "maxIterations must be an integer >= 1"),
});

export type LoopBack = z.infer<typeof LoopBackSchema>;

export const WorkflowSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  name: z.string().min(1, "workflow name must be a non-empty string"),
  steps: z.array(StepSchema).min(1, "a workflow needs at least one step"),
  loopBack: LoopBackSchema.optional(),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
