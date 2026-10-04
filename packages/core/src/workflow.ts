import { z } from "zod";
import { idSchema } from "./common.js";
import { isValidRegex } from "./regex.js";
import { SandboxOverridesSchema } from "./policy.js";

/**
 * Largest accepted `retry.maxAttempts` (#119): five attempts is plenty for a
 * flaky agent, and bounds the worst-case run time a node can accumulate.
 */
export const MAX_RETRY_ATTEMPTS = 5;

/** Largest accepted `retry.backoffMs` (#119) — one minute. */
export const MAX_RETRY_BACKOFF_MS = 60_000;

/**
 * Node retry policy (#119): a flaky agent heals itself. When an attempt
 * fails (`retryOn: "failure"`) — or regardless of outcome
 * (`retryOn: "always"`) — the engine re-executes the node up to
 * `maxAttempts` times, waiting `backoffMs * 2^(attempt-1) + jitter` between
 * attempts. Retries stay INSIDE one node execution: no new StepRun
 * iteration, no edge traversal, no consumption of edge cycle/iteration
 * caps; a `continueSession` node keeps its session across attempts.
 */
export const NodeRetryConfigSchema = z.strictObject({
  /** Total attempts per node execution, 1 (no retry) .. {@link MAX_RETRY_ATTEMPTS}. */
  maxAttempts: z
    .number()
    .int("maxAttempts must be an integer")
    .min(1, "maxAttempts must be >= 1")
    .max(MAX_RETRY_ATTEMPTS, `maxAttempts must be <= ${MAX_RETRY_ATTEMPTS}`),
  /** Base backoff delay; the attempt-N delay is this times 2^(N-1), plus jitter. */
  backoffMs: z
    .number()
    .int("backoffMs must be an integer")
    .min(0, "backoffMs must be >= 0")
    .max(MAX_RETRY_BACKOFF_MS, `backoffMs must be <= ${MAX_RETRY_BACKOFF_MS} (1 minute)`),
  /** `failure` retries failed attempts only; `always` retries any outcome. */
  retryOn: z.enum(["failure", "always"]),
});

export type NodeRetryConfig = z.infer<typeof NodeRetryConfigSchema>;

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
  /**
   * Per-node sandbox overrides (#101), additive: absent on pre-#101
   * revisions, unset fields inherit the project sandbox policy. Validated
   * as part of the graph save (this schema); the merge into a SandboxSpec
   * happens at run time (`buildSandboxSpec`).
   */
  sandboxOverrides: SandboxOverridesSchema.optional(),
  /**
   * Per-node retry policy (#119), additive: absent on pre-#119 revisions =
   * exactly one attempt (the previous behavior, byte-identical).
   */
  retry: NodeRetryConfigSchema.optional(),
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
