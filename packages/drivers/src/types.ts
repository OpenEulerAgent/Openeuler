import type { AgentEvent } from "@openeuler/core";

/** Interaction mode requested for a run. */
export type AgentMode = "auto" | "ask";

/** Options passed to {@link AgentDriver.start}. */
export interface AgentStartOpts {
  /** Working directory the agent should operate in. */
  cwd: string;
  /** Instruction for the run. */
  prompt: string;
  /** Model override, e.g. `"glm-4.6"`. */
  model?: string;
  /** Agent/subagent selection, e.g. `"build"`. */
  agent?: string;
  /** `"auto"` lets the agent act without confirmation, `"ask"` requires approval. */
  mode: AgentMode;
  /** Continue a previous session. */
  sessionId?: string;
  /** Extra environment variables for the agent process. */
  env?: Record<string, string>;
}

/** Why an agent run ended. */
export type AgentExitReason = "exit" | "aborted" | "error";

/** Terminal result of an agent run. */
export interface AgentExit {
  /** Exit code when the run terminated on its own, `null` when aborted/errored without a code. */
  code: number | null;
  reason: AgentExitReason;
  /**
   * Final output of the run. For runs that ended early (`"aborted"`),
   * this is the output accumulated so far.
   */
  output: string;
}

/** Live handle to a single agent run. */
export interface AgentHandle {
  /** Streamed lifecycle events; every event satisfies `AgentEvent` from `@openeuler/core`. */
  events: AsyncIterable<AgentEvent>;
  /** Stop the run. No-op once the run has finished. */
  abort(): Promise<void>;
  /** Resolves exactly once when the run ends. Never rejects. */
  exited: Promise<AgentExit>;
}

/** A pluggable agent backend (e.g. opencode). */
export interface AgentDriver {
  /** Unique registry id, e.g. `"opencode"` or `"fake"`. */
  id: string;
  start(opts: AgentStartOpts): AgentHandle;
}
