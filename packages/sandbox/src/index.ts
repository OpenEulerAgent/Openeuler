export const PACKAGE_NAME = "@openeuler/sandbox";

export type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxHandleMeta,
  SandboxHostPorts,
  SandboxLogEntry,
  SandboxLogOptions,
  SandboxMount,
  SandboxNetworkMode,
  SandboxProvider,
  SandboxResources,
  SandboxSpec,
  SandboxStatus,
  SandboxSummary,
  SandboxUsage,
} from "./types.js";

export { SandboxError } from "./error.js";
export type { SandboxErrorCode } from "./error.js";

export {
  createSandboxProviderRegistry,
  defaultSandboxProviderRegistry,
  getSandboxProvider,
  listSandboxProviders,
  registerSandboxProvider,
} from "./registry.js";
export type { SandboxProviderRegistry } from "./registry.js";

export { createFakeSandboxProvider, FakeSandboxProvider } from "./fake.js";
export type {
  FakeExecCall,
  FakeExecScriptEntry,
  FakeSandboxProviderOptions,
  FakeStopCall,
} from "./fake.js";
