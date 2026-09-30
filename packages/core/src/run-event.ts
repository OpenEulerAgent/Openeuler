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

/** Engine-emitted (non-driver) event. All variants are JSON-serializable. */
export const RunEventSchema = z.discriminatedUnion("type", [
  RunStatusEventSchema,
  StepStartedEventSchema,
  StepCompletedEventSchema,
]);

export type RunEvent = z.infer<typeof RunEventSchema>;

/**
 * Anything persistable into a run's event log: streamed driver events plus
 * the engine's own lifecycle events. The events table stores payloads as JSON
 * and parses them back through this union.
 */
export const PersistedEventSchema = z.union([AgentEventSchema, RunEventSchema]);

export type PersistedEvent = z.infer<typeof PersistedEventSchema>;
