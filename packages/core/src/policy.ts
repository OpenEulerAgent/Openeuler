import { z } from "zod";

/**
 * Per-project sandbox policy (#101): the defaults every sandboxed run of a
 * project executes under — image, resources, network exposure, cache mounts
 * and debug retention. Node-level `sandboxOverrides` (on `StepConfig`) win
 * per field over this policy at run time; the pure merge lives in
 * `@openeuler/engine` (`buildSandboxSpec`).
 *
 * This module is deliberately dependency-free and browser-safe: the web form
 * reuses the same zod schemas for client-side validation, mirroring the
 * daemon's 422 messages.
 */

/** CPU clamp for policy/override `cpus`: whole cores, 1..8. */
export const SANDBOX_POLICY_CPUS_MIN = 1;
export const SANDBOX_POLICY_CPUS_MAX = 8;

/** Memory clamp for policy/override `memoryMb`, in MiB: 512..8192. */
export const SANDBOX_POLICY_MEMORY_MB_MIN = 512;
export const SANDBOX_POLICY_MEMORY_MB_MAX = 8192;

/** Upper bound for `cachePaths` entries. */
export const SANDBOX_POLICY_CACHE_PATHS_MAX = 5;

/**
 * Image reference grammar — the sandbox docker provider's `IMAGE_REF_PATTERN`
 * plus a leading-dash guard (the first character must be a lowercase
 * alphanumeric), so a policy image can never read as a docker flag.
 * Duplicated here so core stays dependency-free; `@openeuler/engine`
 * type-checks the mapping onto `SandboxSpec` stays in sync.
 */
export const SANDBOX_IMAGE_REF_PATTERN = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@\S+)?$/;

export const SANDBOX_IMAGE_REF_ISSUE =
  "image must be a lowercase reference like openeuler/worker:latest (optional @digest; no leading dashes)";

/**
 * Network exposure of a sandbox run. Structurally identical to
 * `SandboxNetworkMode` in `@openeuler/sandbox` — `limited` means a
 * dedicated bridge with working DNS; **egress is NOT filtered in v0.2**
 * (documented honestly in the UI and provider README).
 */
export const SandboxNetworkModeSchema = z.enum(["none", "limited", "default"]);
export type SandboxNetworkMode = z.infer<typeof SandboxNetworkModeSchema>;

export const EXECUTION_MODES = ["local", "sandbox", "auto"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

const imageRefSchema = z.string().regex(SANDBOX_IMAGE_REF_PATTERN, SANDBOX_IMAGE_REF_ISSUE);

const cpusSchema = z
  .number()
  .int("cpus must be a whole number of cores")
  .min(SANDBOX_POLICY_CPUS_MIN, `cpus must be >= ${SANDBOX_POLICY_CPUS_MIN}`)
  .max(SANDBOX_POLICY_CPUS_MAX, `cpus must be <= ${SANDBOX_POLICY_CPUS_MAX}`);

const memoryMbSchema = z
  .number()
  .int("memoryMb must be a whole number of MiB")
  .min(SANDBOX_POLICY_MEMORY_MB_MIN, `memoryMb must be >= ${SANDBOX_POLICY_MEMORY_MB_MIN}`)
  .max(SANDBOX_POLICY_MEMORY_MB_MAX, `memoryMb must be <= ${SANDBOX_POLICY_MEMORY_MB_MAX}`);

const cachePathSchema = z
  .string()
  .min(1, "cache paths must be non-empty")
  .startsWith("/", "cache paths must be absolute container paths starting with /")
  .refine((value) => !value.includes(":"), "cache paths must not contain ':' — they become container-side mount targets");

/**
 * The whole-project sandbox policy. PATCHed atomically via
 * `PATCH /api/projects/:id/policy` (whole-policy replace); `executionMode`
 * defaults to `"auto"` when omitted.
 */
export const ProjectSandboxPolicySchema = z.strictObject({
  executionMode: z.enum(EXECUTION_MODES).default("auto"),
  image: imageRefSchema.optional(),
  cpus: cpusSchema.optional(),
  memoryMb: memoryMbSchema.optional(),
  network: SandboxNetworkModeSchema.optional(),
  cachePaths: z
    .array(cachePathSchema)
    .max(SANDBOX_POLICY_CACHE_PATHS_MAX, `at most ${SANDBOX_POLICY_CACHE_PATHS_MAX} cache paths`)
    .optional(),
  keepForDebug: z.boolean().optional(),
});

export type ProjectSandboxPolicyInput = z.input<typeof ProjectSandboxPolicySchema>;
export type ProjectSandboxPolicy = z.output<typeof ProjectSandboxPolicySchema>;

/**
 * Per-node sandbox overrides carried on `StepConfig` (additive — graphs
 * saved before #101 simply lack the key and stay valid). Editing overrides
 * bumps a new graph revision through the ordinary save flow; the merge into
 * a `SandboxSpec` happens in `buildSandboxSpec` (override wins per field).
 */
export const SandboxOverridesSchema = z.strictObject({
  image: imageRefSchema.optional(),
  cpus: cpusSchema.optional(),
  memoryMb: memoryMbSchema.optional(),
  network: SandboxNetworkModeSchema.optional(),
});

export type SandboxOverrides = z.infer<typeof SandboxOverridesSchema>;

/** True when the override object carries no field (i.e. "inherit everything"). */
export function sandboxOverridesActive(overrides: SandboxOverrides | undefined): boolean {
  return (
    overrides !== undefined &&
    (overrides.image !== undefined ||
      overrides.cpus !== undefined ||
      overrides.memoryMb !== undefined ||
      overrides.network !== undefined)
  );
}
