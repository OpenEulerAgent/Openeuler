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
  SandboxVolume,
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

export { createDockerSandboxProvider, DockerSandboxProvider } from "./docker.js";
export type { DockerSandboxProviderOptions } from "./docker.js";
export { dockerAvailable, createDockerAvailabilityProbe, docker } from "./docker-cli.js";
export type { DockerCliResult, DockerCliRunner } from "./docker-cli.js";
export type { DockerStdinCliRunner } from "./docker-cli.js";
export {
  buildSandboxImage,
  COMMON_BASE_IMAGES,
  imageBuildTag,
  imageNameIssue,
  imageRefIssue,
  listSandboxImages,
  normalizeImageRef,
  OPENEULER_IMAGE_NAMESPACE,
  OPENEULER_IMAGE_TAG,
  parseDockerCreatedAtMs,
  parseDockerSizeToBytes,
  pullSandboxImage,
  removeSandboxImage,
} from "./images.js";
export type { SandboxImageBuildInput, SandboxImageEntry, SandboxImagesOptions } from "./images.js";
