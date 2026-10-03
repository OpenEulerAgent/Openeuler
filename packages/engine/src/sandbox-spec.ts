import type { ProjectSandboxPolicy, SandboxOverrides } from "@openeuler/core";
import { SandboxError } from "@openeuler/sandbox";
import type { SandboxMount, SandboxSpec, SandboxVolume } from "@openeuler/sandbox";

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

/**
 * Container path every run worktree is bind-mounted at (#102): the run's
 * sandboxed steps execute with `cwd` = this path.
 */
export const SANDBOX_WORKSPACE_PATH = "/workspace";

/**
 * Stable cache volume name for one (project, container path) pair (#102):
 * `openeuler-cache-<projectId>-<sanitized path>`. Stable per project so
 * consecutive runs share dependency caches; sanitized to docker's volume
 * name grammar (`[a-zA-Z0-9][a-zA-Z0-9_.-]*`).
 */
export function cacheVolumeName(projectId: string, cachePath: string): string {
  const sanitizedPath = cachePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("-");
  const raw = `openeuler-cache-${projectId}-${sanitizedPath}`;
  const cleaned = raw.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return cleaned === "" ? "openeuler-cache" : cleaned;
}

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
/** Extra spec fields the executor attaches to a RUN sandbox (#102). */
export interface SandboxSpecExtras {
  /** Named cache volumes (`policy.cachePaths` → stable per-project names). */
  volumes?: SandboxVolume[];
  /** Discovery labels (`provider.list()` selectors). */
  labels?: Record<string, string>;
  /** Initial working directory inside the sandbox. */
  workingDir?: string;
}

export function buildSandboxSpec(
  policy: ProjectSandboxPolicy,
  overrides: SandboxOverrides | undefined,
  runId: string,
  mounts: SandboxMount[],
  env: Record<string, string>,
  ports: number[] = [],
  extras: SandboxSpecExtras = {},
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
    ...(extras.volumes === undefined || extras.volumes.length === 0
      ? {}
      : { volumes: extras.volumes }),
    ...(extras.labels === undefined || Object.keys(extras.labels).length === 0
      ? {}
      : { labels: extras.labels }),
    ...(extras.workingDir === undefined ? {} : { workingDir: extras.workingDir }),
  };
}

/**
 * Builds the ONE sandbox spec a whole run executes in (#102): the project
 * policy (node `sandboxOverrides` are deliberately NOT merged here — they
 * are validated/stored but per-node sandboxes are post-v0.2; the run
 * sandbox uses project policy only, documented deviation), the run's
 * worktree bind-mounted rw (+`:cached`) at `/workspace`, one named cache
 * volume per `policy.cachePaths`, and the `run` discovery label.
 */
export function buildRunSandboxSpec(input: {
  policy: ProjectSandboxPolicy;
  runId: string;
  projectId: string;
  /** Host worktree path (the bind-mount source). */
  worktreePath: string;
  /** Container env (NO secrets — those ride per-exec via the driver seam). */
  env?: Record<string, string>;
}): SandboxSpec {
  return buildSandboxSpec(
    input.policy,
    undefined, // v0.2 deviation: run sandbox uses project policy only.
    input.runId,
    [
      {
        hostPath: input.worktreePath,
        containerPath: SANDBOX_WORKSPACE_PATH,
        consistency: "cached",
      },
    ],
    input.env ?? {},
    [],
    {
      volumes: (input.policy.cachePaths ?? []).map((cachePath) => ({
        name: cacheVolumeName(input.projectId, cachePath),
        containerPath: cachePath,
      })),
      labels: { run: input.runId },
      workingDir: SANDBOX_WORKSPACE_PATH,
    },
  );
}
