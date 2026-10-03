import type { ProjectSandboxPolicy, SandboxOverrides } from "@openeuler/core";
import { SandboxError } from "@openeuler/sandbox";
import type { SandboxMount, SandboxSpec } from "@openeuler/sandbox";

/**
 * Pure policy → spec mapping (#101, prep for #102): merges a project's
 * sandbox policy with a node's `sandboxOverrides` (override wins per
 * field), fills engine defaults, and produces the `SandboxSpec` a sandbox
 * provider `create()`s. No I/O, no provider wiring — the executor (#102)
 * calls this once it routes runs into sandboxes.
 */

/** Default CPU share when neither policy nor override sets one (issue #101). */
export const DEFAULT_SANDBOX_CPUS = 2;

/** Default memory (MiB) when neither policy nor override sets one (issue #101). */
export const DEFAULT_SANDBOX_MEMORY_MB = 2048;

/** Merge result of policy + node overrides; every field optional until defaults. */
export interface MergedSandboxConfig {
  image: string | undefined;
  cpus: number;
  memoryMb: number;
  network: ProjectSandboxPolicy["network"] | undefined;
}

/**
 * Per-field merge: an override field wins over the policy field only when
 * actually set (empty override fields inherit). Resources fall back to the
 * engine defaults; the network stays `undefined` when nobody set it (the
 * provider then applies its own default).
 */
export function mergeSandboxConfig(
  policy: Pick<ProjectSandboxPolicy, "image" | "cpus" | "memoryMb" | "network">,
  overrides: SandboxOverrides | undefined,
): MergedSandboxConfig {
  return {
    image: overrides?.image ?? policy.image,
    cpus: overrides?.cpus ?? policy.cpus ?? DEFAULT_SANDBOX_CPUS,
    memoryMb: overrides?.memoryMb ?? policy.memoryMb ?? DEFAULT_SANDBOX_MEMORY_MB,
    network: overrides?.network ?? policy.network,
  };
}

/**
 * Builds the sandbox spec for one node execution. Throws a typed
 * `SANDBOX_INVALID_SPEC` `SandboxError` when sandbox execution is requested
 * but no image is configured anywhere — with an actionable message naming
 * the image-management endpoints (`GET /api/sandbox/images`,
 * `POST /api/sandbox/images/pull`), so the failure reads as a setup step
 * rather than an internal error.
 */
export function buildSandboxSpec(
  policy: ProjectSandboxPolicy,
  overrides: SandboxOverrides | undefined,
  runId: string,
  mounts: SandboxMount[],
  env: Record<string, string>,
  ports: number[] = [],
): SandboxSpec {
  const merged = mergeSandboxConfig(policy, overrides);
  if (merged.image === undefined || merged.image.length === 0) {
    throw new SandboxError(
      "SANDBOX_INVALID_SPEC",
      "sandbox execution needs an image: set one in Project settings → Sandbox (or as a node override). " +
        'List installable images with GET /api/sandbox/images, then POST /api/sandbox/images/pull {"ref": "…"} ' +
        '(e.g. busybox:1.36) or POST /api/sandbox/images/build {"name": "…"}',
    );
  }
  return {
    runId,
    image: merged.image,
    mounts,
    env,
    ...(ports.length > 0 ? { ports } : {}),
    resources: { cpus: merged.cpus, memoryMb: merged.memoryMb },
    ...(merged.network === undefined ? {} : { network: merged.network }),
  };
}
