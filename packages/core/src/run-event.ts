import { z } from "zod";
import { AgentEventSchema, seqSchema } from "./agent-event.js";
import { idSchema } from "./common.js";
import { RunStatusSchema } from "./run.js";

/**
 * Engine-emitted run lifecycle event, persisted into the run's event log on
 * every status transition (`running` when execution begins, then exactly one
 * terminal status). Clients that only care about the outcome can wait for the
 * terminal variant; the SSE layer closes streams on it.
 */
export const RunStatusEventSchema = z.strictObject({
  type: z.literal("run.status"),
  seq: seqSchema,
  status: RunStatusSchema,
  /** Failure message carried on `failed` transitions. */
  error: z.string().optional(),
});

export type RunStatusEvent = z.infer<typeof RunStatusEventSchema>;

/** 1-based loop pass the step event belongs to (`1` on the first pass). */
const iterationSchema = z.number().int().min(1, "iteration must be an integer >= 1");

/** Engine-emitted event: a workflow step started executing. */
export const StepStartedEventSchema = z.strictObject({
  type: z.literal("step.started"),
  seq: seqSchema,
  stepId: idSchema,
  stepName: z.string().min(1, "stepName must be a non-empty string"),
  iteration: iterationSchema,
});

export type StepStartedEvent = z.infer<typeof StepStartedEventSchema>;

/** Engine-emitted event: a workflow step reached a terminal status. */
export const StepCompletedEventSchema = z.strictObject({
  type: z.literal("step.completed"),
  seq: seqSchema,
  stepId: idSchema,
  stepName: z.string().min(1, "stepName must be a non-empty string"),
  iteration: iterationSchema,
  status: RunStatusSchema,
});

export type StepCompletedEvent = z.infer<typeof StepCompletedEventSchema>;

/**
 * Verdict of one completed loop pass: why the engine continued or stopped.
 * `continue` means another iteration starts at `loopBack.toStepIndex`; every
 * other verdict is terminal for the loop (the run itself still ends
 * `success` — the exit condition only decides whether to keep looping).
 */
export const LoopVerdictSchema = z.enum([
  "continue",
  "exit-condition-met",
  "max-iterations",
  "hard-cap",
]);

export type LoopVerdict = z.infer<typeof LoopVerdictSchema>;

/**
 * Engine-emitted event: iteration `iteration` finished and the loopBack exit
 * condition was evaluated against the final step's output. Emitted once per
 * iteration of a workflow with a `loopBack`, persisted between iterations.
 */
export const LoopIterationEventSchema = z.strictObject({
  type: z.literal("loop.iteration"),
  seq: seqSchema,
  iteration: iterationSchema,
  verdict: LoopVerdictSchema,
  /** Human-readable reason (e.g. which condition was met or unmet). */
  detail: z.string().optional(),
});

export type LoopIterationEvent = z.infer<typeof LoopIterationEventSchema>;

// -------------------------------------------------------------------------
// Graph events (#45). Graph-revision runs emit these INSTEAD of the step.*
// events: `node.*` for agent-node executions, `edge.*` for routing
// transitions. They fully describe a serial graph execution (together with
// run.status) and power the live graph view / replay (#52).
//

/** Engine-emitted event: a graph node execution was scheduled next. */
export const NodeQueuedEventSchema = z.strictObject({
  type: z.literal("node.queued"),
  seq: seqSchema,
  nodeId: idSchema,
  nodeName: z.string().min(1, "nodeName must be a non-empty string"),
  /** 1-based execution number of THIS node (per-node, not global). */
  iteration: iterationSchema,
});

export type NodeQueuedEvent = z.infer<typeof NodeQueuedEventSchema>;

/** Engine-emitted event: a graph node execution started (driver invoked). */
export const NodeStartedEventSchema = z.strictObject({
  type: z.literal("node.started"),
  seq: seqSchema,
  nodeId: idSchema,
  nodeName: z.string().min(1, "nodeName must be a non-empty string"),
  iteration: iterationSchema,
});

export type NodeStartedEvent = z.infer<typeof NodeStartedEventSchema>;

/**
 * Engine-emitted event: a graph node execution reached a terminal status.
 * `output` is the node's final output (what routing evaluated against);
 * `durationMs` covers the driver invocation.
 */
export const NodeCompletedEventSchema = z.strictObject({
  type: z.literal("node.completed"),
  seq: seqSchema,
  nodeId: idSchema,
  nodeName: z.string().min(1, "nodeName must be a non-empty string"),
  iteration: iterationSchema,
  status: RunStatusSchema,
  output: z.string(),
  durationMs: z.number().int().min(0, "durationMs must be an integer >= 0"),
  /** Failure message on non-success statuses. */
  error: z.string().optional(),
});

export type NodeCompletedEvent = z.infer<typeof NodeCompletedEventSchema>;

/**
 * Engine-emitted event: an outgoing edge was traversed after its source
 * node completed. `iteration` is the source node's 1-based execution number
 * whose output routed; `matchedCondition` describes the condition that
 * decided the traversal (e.g. `always`, `outputContains "bug"`).
 */
export const EdgeTakenEventSchema = z.strictObject({
  type: z.literal("edge.taken"),
  seq: seqSchema,
  edgeId: idSchema,
  source: idSchema,
  target: idSchema,
  matchedCondition: z.string().min(1, "matchedCondition must be a non-empty string"),
  iteration: iterationSchema,
});

export type EdgeTakenEvent = z.infer<typeof EdgeTakenEventSchema>;

// -------------------------------------------------------------------------
// Sandbox log events (#104). While a run's sandbox exists, its container
// stdout/stderr lines are appended into the run's event log as first-class
// history (`sandbox.log`), one event per line, bounded to the last
// SANDBOX_LOG_CAP lines per run (drop-oldest; a single
// `sandbox.log-truncated` marker records what fell out). The executor (which
// owns the sandbox lifecycle) appends these; the web feed renders them as
// mono gray lines under "All" only, and the graph fold ignores them.
//

/**
 * Engine-emitted event: one sandbox log line, in emission order (per-stream
 * order pinned; cross-stream interleaving is provider-dependent).
 */
export const SandboxLogEventSchema = z.strictObject({
  type: z.literal("sandbox.log"),
  seq: seqSchema,
  /** Provider-scoped id of the sandbox the line came from. */
  sandboxId: z.string().min(1, "sandboxId must be a non-empty string"),
  stream: z.enum(["stdout", "stderr"]),
  /** The raw line (secret-redacted before persistence). */
  line: z.string(),
});

export type SandboxLogEvent = z.infer<typeof SandboxLogEventSchema>;

/**
 * Engine-emitted event: emitted at most ONCE per run (when the sandbox log
 * tailer stops) when `sandbox.log` events were evicted to keep the run's log
 * bounded — the ring keeps the LAST `kept` lines.
 */
export const SandboxLogTruncatedEventSchema = z.strictObject({
  type: z.literal("sandbox.log-truncated"),
  seq: seqSchema,
  sandboxId: z.string().min(1, "sandboxId must be a non-empty string"),
  /** Total lines evicted (dropped from the front of the ring) for the run. */
  dropped: z.number().int().min(1, "dropped must be an integer >= 1"),
  /** Lines the ring kept (the persisted `sandbox.log` event count). */
  kept: z.number().int().min(0, "kept must be an integer >= 0"),
});

export type SandboxLogTruncatedEvent = z.infer<typeof SandboxLogTruncatedEventSchema>;

/**
 * Engine-emitted event: a conditional cycle edge's condition matched but its
 * iteration guard blocked the traversal. `taken` counts the edge's matched
 * attempts (the blocked one included); the run then follows the source
 * node's `always` fallback edge, or fails when there is none.
 */
export const EdgeCapReachedEventSchema = z.strictObject({
  type: z.literal("edge.cap-reached"),
  seq: seqSchema,
  edgeId: idSchema,
  source: idSchema,
  target: idSchema,
  taken: z.number().int().min(1, "taken must be an integer >= 1"),
  maxIterations: z.number().int().min(1, "maxIterations must be an integer >= 1"),
  /** Human-readable reason (clamp/failure detail). */
  detail: z.string().optional(),
});

export type EdgeCapReachedEvent = z.infer<typeof EdgeCapReachedEventSchema>;

/** Engine-emitted (non-driver) event. All variants are JSON-serializable. */
export const RunEventSchema = z.discriminatedUnion("type", [
  RunStatusEventSchema,
  StepStartedEventSchema,
  StepCompletedEventSchema,
  LoopIterationEventSchema,
  NodeQueuedEventSchema,
  NodeStartedEventSchema,
  NodeCompletedEventSchema,
  EdgeTakenEventSchema,
  EdgeCapReachedEventSchema,
  SandboxLogEventSchema,
  SandboxLogTruncatedEventSchema,
]);

export type RunEvent = z.infer<typeof RunEventSchema>;

/**
 * Anything persistable into a run's event log: streamed driver events plus
 * the engine's own lifecycle events. The events table stores payloads as JSON
 * and parses them back through this union.
 */
export const PersistedEventSchema = z.union([AgentEventSchema, RunEventSchema]);

export type PersistedEvent = z.infer<typeof PersistedEventSchema>;
