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

/**
 * Engine-emitted event: a graph node execution was scheduled next. Emitted
 * at SCHEDULING time (when the execution enters the run's ready queue), so
 * a parallel branch (#115) shows up as queued while it waits for an inner
 * concurrency slot.
 */
export const NodeQueuedEventSchema = z.strictObject({
  type: z.literal("node.queued"),
  seq: seqSchema,
  nodeId: idSchema,
  nodeName: z.string().min(1, "nodeName must be a non-empty string"),
  /** 1-based execution number of THIS node (per-node, not global). */
  iteration: iterationSchema,
  /**
   * The branch edge (#115): for a fan-out branch execution, the always edge
   * whose fan-out started this branch. Absent on serial/router-scheduled
   * executions (their traversal is reported by `edge.taken`) and on join
   * executions.
   */
  edgeId: idSchema.optional(),
  /**
   * Fan-out lineage (#115): the stack of `<sourceNodeId>#<sourceExecNumber>`
   * tokens for every fan-out spawn this execution descends from (["root"]
   * before any fan-out). Join single-trigger bookkeeping and resume
   * reconstruction derive per-join round keys from it.
   */
  rounds: z.array(z.string().min(1)).optional(),
});

export type NodeQueuedEvent = z.infer<typeof NodeQueuedEventSchema>;

/** Engine-emitted event: a graph node execution started (driver invoked). */
export const NodeStartedEventSchema = z.strictObject({
  type: z.literal("node.started"),
  seq: seqSchema,
  nodeId: idSchema,
  nodeName: z.string().min(1, "nodeName must be a non-empty string"),
  iteration: iterationSchema,
  /** The branch edge this execution runs on (#115), when known. */
  edgeId: idSchema.optional(),
  /** Fan-out lineage (#115) — see NodeQueuedEventSchema.rounds. */
  rounds: z.array(z.string().min(1)).optional(),
});

export type NodeStartedEvent = z.infer<typeof NodeStartedEventSchema>;

/**
 * Engine-emitted event: a graph node execution reached a terminal status.
 * `output` is the node's final output (what routing evaluated against);
 * `durationMs` covers the driver invocation. Join nodes (#115) execute
 * instantly (no driver): their `output` is the JSON map of the arrived
 * branch outputs and `durationMs` is 0. Sub-workflow nodes (#117) execute
 * a child run: their `output` is the child run's final output and
 * `childRunId` links the run that produced it.
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
  /** The branch edge this execution runs on (#115), when known. */
  edgeId: idSchema.optional(),
  /** The child run this sub-workflow node executed (#117), when known. */
  childRunId: idSchema.optional(),
  /**
   * Attempt this execution settled on (#119), 1-based: 1 when the node has
   * no retry policy, higher when earlier attempts were retried. Absent on
   * pre-#119 events (read as 1).
   */
  attempt: z.number().int().min(1, "attempt must be an integer >= 1").optional(),
});

export type NodeCompletedEvent = z.infer<typeof NodeCompletedEventSchema>;

/**
 * Engine-emitted event: a node attempt failed (or, with `retryOn:
 * "always"`, completed) and the engine will re-execute the node (#119).
 * `attempt` is the 1-based attempt being retried; `nextInMs` is the
 * backoff delay (exponential base 2 plus jitter) before the next attempt
 * starts. Emitted between the attempts' driver events, before the node's
 * final `node.completed`.
 */
export const NodeRetryEventSchema = z.strictObject({
  type: z.literal("node.retry"),
  seq: seqSchema,
  nodeId: idSchema,
  nodeName: z.string().min(1, "nodeName must be a non-empty string"),
  iteration: iterationSchema,
  /** The 1-based attempt that just finished and is being retried. */
  attempt: z.number().int().min(1, "attempt must be an integer >= 1"),
  /** Delay before the next attempt starts, jitter included. */
  nextInMs: z.number().int().min(0, "nextInMs must be an integer >= 0"),
  /** Why the attempt is being retried (the failure message). */
  error: z.string().optional(),
});

export type NodeRetryEvent = z.infer<typeof NodeRetryEventSchema>;

/**
 * Engine-emitted event: an approval gate node (#118) opened its wait —
 * the run is paused (`run.status` stays `running`; the run row carries
 * `awaitingNodeId`/`awaitingSince`). `prompt` is the question shown to
 * the approver; `timeoutMinutes` echoes the configured auto-reject
 * window, when set. Exactly one per gate execution (a resume after a
 * daemon restart re-enters the wait WITHOUT re-emitting this).
 */
export const NodeAwaitingEventSchema = z.strictObject({
  type: z.literal("node.awaiting"),
  seq: seqSchema,
  nodeId: idSchema,
  nodeName: z.string().min(1, "nodeName must be a non-empty string"),
  iteration: iterationSchema,
  /** The approval prompt shown to the approver. */
  prompt: z.string(),
  /** Configured auto-reject window, when set. */
  timeoutMinutes: z.number().int().min(1).optional(),
});

export type NodeAwaitingEvent = z.infer<typeof NodeAwaitingEventSchema>;

/**
 * Engine-emitted event: an approval gate resolved. `approved` carries the
 * decision; `note` is the approver's note (`"timed out"` for a timeout
 * rejection). Emitted before the node's `node.completed` — the node always
 * COMPLETES (approve → output note ?? "approved"; reject → output
 * `rejected: <note>`) and routing decides what happens next. Not emitted
 * when the gate is cut short by an abort.
 */
export const NodeApprovedEventSchema = z.strictObject({
  type: z.literal("node.approved"),
  seq: seqSchema,
  nodeId: idSchema,
  nodeName: z.string().min(1, "nodeName must be a non-empty string"),
  iteration: iterationSchema,
  approved: z.boolean(),
  /** Approver note / rejection reason; ≤2000 chars. */
  note: z.string().max(2000, "note must be at most 2000 characters").optional(),
});

export type NodeApprovedEvent = z.infer<typeof NodeApprovedEventSchema>;

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
  NodeAwaitingEventSchema,
  NodeApprovedEventSchema,
  NodeRetryEventSchema,
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
