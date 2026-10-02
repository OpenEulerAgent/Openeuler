export const PACKAGE_NAME = "@openeuler/core";

export function ping(): "pong" {
  return "pong";
}

export { idSchema, timestampSchema } from "./common.js";

export { ProjectSchema } from "./project.js";
export type { Project } from "./project.js";

export { AgentPresetSchema } from "./preset.js";
export type { AgentPreset } from "./preset.js";

export { FileContentSchema, FileNodeSchema, FileTypeSchema } from "./file.js";
export type { FileContent, FileNode, FileType } from "./file.js";

export {
  AlwaysConditionSchema,
  ExitConditionSchema,
  LoopBackSchema,
  OutputContainsConditionSchema,
  OutputMatchesConditionSchema,
  OutputNotContainsConditionSchema,
  StepConfigSchema,
  StepSchema,
  WorkflowSchema,
  WorkflowShapeSchema,
  loopBackToStepIndexIssue,
} from "./workflow.js";
export type {
  AlwaysCondition,
  ExitCondition,
  LoopBack,
  OutputContainsCondition,
  OutputMatchesCondition,
  OutputNotContainsCondition,
  Step,
  StepConfig,
  Workflow,
} from "./workflow.js";

export {
  AgentGraphNodeSchema,
  DEFAULT_EDGE_MAX_ITERATIONS,
  ExitGraphNodeSchema,
  GraphEdgeSchema,
  GraphNodePositionSchema,
  GraphNodeSchema,
  WorkflowGraphSchema,
  WorkflowGraphShapeSchema,
  graphToLinear,
  linearToGraph,
  summarizeGraph,
  validateWorkflowGraph,
} from "./graph.js";
export type {
  AgentGraphNode,
  ExitGraphNode,
  GraphEdge,
  GraphNode,
  GraphNodePosition,
  GraphSummary,
  GraphToLinearResult,
  GraphValidationIssue,
  WorkflowGraph,
  WorkflowGraphShape,
} from "./graph.js";

export {
  RunSchema,
  RunStatusSchema,
  StepRunSchema,
  BreadcrumbEntrySchema,
  TERMINAL_RUN_STATUSES,
  TerminalRunStatusSchema,
} from "./run.js";
export type { Run, RunStatus, StepRun, BreadcrumbEntry, TerminalRunStatus } from "./run.js";

export {
  AgentDoneEventSchema,
  AgentErrorEventSchema,
  AgentEventSchema,
  AgentMessageDeltaEventSchema,
  AgentSessionEventSchema,
  AgentStartedEventSchema,
  AgentToolCallEventSchema,
  AgentToolOutputEventSchema,
  seqSchema,
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

export {
  EdgeCapReachedEventSchema,
  EdgeTakenEventSchema,
  LoopIterationEventSchema,
  LoopVerdictSchema,
  NodeCompletedEventSchema,
  NodeQueuedEventSchema,
  NodeStartedEventSchema,
  PersistedEventSchema,
  RunEventSchema,
  RunStatusEventSchema,
  StepCompletedEventSchema,
  StepStartedEventSchema,
} from "./run-event.js";
export type {
  EdgeCapReachedEvent,
  EdgeTakenEvent,
  LoopIterationEvent,
  LoopVerdict,
  NodeCompletedEvent,
  NodeQueuedEvent,
  NodeStartedEvent,
  PersistedEvent,
  RunEvent,
  RunStatusEvent,
  StepCompletedEvent,
  StepStartedEvent,
} from "./run-event.js";

export {
  PROMPT_TEMPLATE_VARIABLES,
  extractOutputReferences,
  renderPromptTemplate,
} from "./prompt.js";
export type { PromptTemplateVariable, PromptTemplateVars } from "./prompt.js";

export { isValidRegex } from "./regex.js";
