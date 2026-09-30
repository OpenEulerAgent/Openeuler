export const PACKAGE_NAME = "@openeuler/engine";

export const ENGINE_VERSION = "0.0.0";

export function nextTick(previous: number): { tick: number } {
  return { tick: previous + 1 };
}

export { GIT_EXEC_TIMEOUT_MS, GitError, gitExec, type GitExecOptions } from "./git.js";

export {
  WorktreeManager,
  WorktreeError,
  branchForRun,
  type WorktreeDiff,
  type WorktreeErrorCode,
  type WorktreeInfo,
  type WorktreeManagerOptions,
  type WorktreeRemoveResult,
} from "./worktree.js";

export {
  ADHOC_STEP_ID,
  DEFAULT_DRIVER_ID,
  MAX_LOOP_ITERATIONS,
  createFlowEngine,
  type ExecuteRunOptions,
  type FlowEngine,
  type FlowEngineOptions,
  type FlowLogger,
  type RunControl,
  type StepDefinition,
} from "./flow-engine.js";
