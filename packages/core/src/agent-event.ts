import { z } from "zod";
import { TerminalRunStatusSchema } from "./run.js";

/**
 * Monotonic sequence number letting consumers order/reorder events that
 * arrived over a transport without ordering guarantees.
 */
const seqSchema = z.number().int().min(0, "seq must be an integer >= 0");

export const AgentStartedEventSchema = z.strictObject({
  type: z.literal("started"),
  seq: seqSchema,
});

export type AgentStartedEvent = z.infer<typeof AgentStartedEventSchema>;

export const AgentSessionEventSchema = z.strictObject({
  type: z.literal("session"),
  seq: seqSchema,
  sessionId: z.string().min(1, "sessionId must be a non-empty string"),
});

export type AgentSessionEvent = z.infer<typeof AgentSessionEventSchema>;

export const AgentMessageDeltaEventSchema = z.strictObject({
  type: z.literal("message-delta"),
  seq: seqSchema,
  delta: z.string(),
});

export type AgentMessageDeltaEvent = z.infer<typeof AgentMessageDeltaEventSchema>;

export const AgentToolCallEventSchema = z.strictObject({
  type: z.literal("tool-call"),
  seq: seqSchema,
  tool: z.string().min(1, "tool must be a non-empty string"),
  input: z.json().optional(),
});

export type AgentToolCallEvent = z.infer<typeof AgentToolCallEventSchema>;

export const AgentToolOutputEventSchema = z.strictObject({
  type: z.literal("tool-output"),
  seq: seqSchema,
  output: z.string(),
});

export type AgentToolOutputEvent = z.infer<typeof AgentToolOutputEventSchema>;

export const AgentDoneEventSchema = z.strictObject({
  type: z.literal("done"),
  seq: seqSchema,
  output: z.string().optional(),
});

export type AgentDoneEvent = z.infer<typeof AgentDoneEventSchema>;

export const AgentErrorEventSchema = z.strictObject({
  type: z.literal("error"),
  seq: seqSchema,
  message: z.string().min(1, "error message must be a non-empty string"),
  code: z.string().min(1).optional(),
});

export type AgentErrorEvent = z.infer<typeof AgentErrorEventSchema>;

/** Streamed agent lifecycle event. All variants are JSON-serializable. */
export const AgentEventSchema = z.discriminatedUnion("type", [
  AgentStartedEventSchema,
  AgentSessionEventSchema,
  AgentMessageDeltaEventSchema,
  AgentToolCallEventSchema,
  AgentToolOutputEventSchema,
  AgentDoneEventSchema,
  AgentErrorEventSchema,
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;

/**
 * Synthetic terminal-status event appended to an SSE stream when a run reaches
 * a terminal status. It is NOT a member of `AgentEventSchema` and is never
 * persisted to the events table: persisted events stay driver-only for now
 * (engine-emitted events land with #15). The streaming layer computes it from
 * the run row, reusing the per-run seq space (`lastSeq + 1`) so web clients
 * can parse it with this schema and keep a monotonic cursor.
 */
export const RunStatusEventSchema = z.strictObject({
  type: z.literal("run.status"),
  seq: seqSchema,
  status: TerminalRunStatusSchema,
});

export type RunStatusEvent = z.infer<typeof RunStatusEventSchema>;
