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
  type StepDiff,
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
  type RunSandboxAcquirer,
  type RunSandboxContext,
  type RunSecrets,
  type RunSecretsLoader,
  type StepDefinition,
} from "./flow-engine.js";

export { MAX_EDGE_ITERATIONS, executeGraphRun, type GraphEngineDeps } from "./graph-engine.js";

export {
  DEFAULT_SANDBOX_CPUS,
  DEFAULT_SANDBOX_MEMORY_MB,
  SANDBOX_WORKSPACE_PATH,
  buildRunSandboxSpec,
  buildSandboxSpec,
  cacheVolumeName,
  mergeSandboxConfig,
  type MergedSandboxConfig,
  type SandboxSpecExtras,
} from "./sandbox-spec.js";

export {
  compileExitCondition,
  describeCondition,
  evaluateExitCondition,
  type ExitEvaluator,
} from "./conditions.js";
