export const PACKAGE_NAME = "@openeuler/core";

export function ping(): "pong" {
  return "pong";
}

export { idSchema, timestampSchema } from "./common.js";

export { ProjectSchema } from "./project.js";
export type { Project } from "./project.js";

export {
  AlwaysConditionSchema,
  ExitConditionSchema,
  LoopBackSchema,
  OutputContainsConditionSchema,
  OutputMatchesConditionSchema,
  OutputNotContainsConditionSchema,
  StepSchema,
  WorkflowSchema,
} from "./workflow.js";
export type {
  AlwaysCondition,
  ExitCondition,
  LoopBack,
  OutputContainsCondition,
  OutputMatchesCondition,
  OutputNotContainsCondition,
  Step,
  Workflow,
} from "./workflow.js";

export { RunSchema, RunStatusSchema, StepRunSchema } from "./run.js";
export type { Run, RunStatus, StepRun } from "./run.js";

export {
  AgentDoneEventSchema,
  AgentErrorEventSchema,
  AgentEventSchema,
  AgentMessageDeltaEventSchema,
  AgentSessionEventSchema,
  AgentStartedEventSchema,
  AgentToolCallEventSchema,
  AgentToolOutputEventSchema,
} from "./agent-event.js";
export type {
  AgentDoneEvent,
  AgentErrorEvent,
  AgentEvent,
  AgentMessageDeltaEvent,
  AgentSessionEvent,
  AgentStartedEvent,
  AgentToolCallEvent,
  AgentToolOutputEvent,
} from "./agent-event.js";

export { PROMPT_TEMPLATE_VARIABLES, renderPromptTemplate } from "./prompt.js";
export type { PromptTemplateVariable, PromptTemplateVars } from "./prompt.js";

export { isValidRegex } from "./regex.js";
