import type { AgentEvent } from "@openeuler/core";

/** Interaction mode requested for a run. */
export type AgentMode = "auto" | "ask";

/** Options for {@link AgentExecSeam.run}. */
export interface AgentExecOptions {
  /** Kill the command after this many ms (the seam's own bound; default: seam-defined). */
  timeoutMs?: number;
  /** Extra environment variables for this command only. */
  env?: Record<string, string>;
}

/** Result of one {@link AgentExecSeam.run} invocation. */
export interface AgentExecResult {
  /** Process exit code. Non-zero is a *result*, not an error. */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Sandbox execution seam (#102): when present on {@link AgentStartOpts},
 * drivers run their agent command INSIDE the run's sandbox through `run`
 * instead of a local child-process spawn. `kind: "sandbox"` keeps the union
 * open for future seams (remote VMs, …). `stop` is the abort path: drivers
 * call it from `AgentHandle.abort()`; it must best-effort cancel every
 * in-flight `run()` (those promises then reject) and stop the sandbox.
 */
export interface AgentExecSeam {
  kind: "sandbox";
  run(cmd: string[], opts?: AgentExecOptions): Promise<AgentExecResult>;
  /** Best-effort cancel of in-flight `run()` calls; never throws. */
  stop?(): void | Promise<void>;
}

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
  /**
   * Sandbox execution seam (#102): when set, run the agent command inside
   * the run's sandbox via `exec.run` instead of a local spawn. `cwd` is a
   * CONTAINER path in that case (e.g. `/workspace`); drivers must not
   * host-resolve or host-stat it. Absent = local execution (unchanged).
   */
  exec?: AgentExecSeam;
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
