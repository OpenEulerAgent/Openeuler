import { ProjectSandboxPolicySchema, type ProjectSandboxPolicy } from "@openeuler/core";
import { ApiError, apiFetch } from "./api";

/**
 * Project sandbox policy API client (#101). The policy rides inside the
 * project payload on GET (`project.sandboxPolicy`, absent until first
 * saved) and is replaced atomically via `PATCH /api/projects/:id/policy`.
 */

/** Injectable transport so flows are testable without a browser. */
export type PolicyFetcher = typeof apiFetch;

/** The project slice the policy flows through. */
interface ProjectPolicyBody {
  project: { sandboxPolicy?: ProjectSandboxPolicy };
}

/**
 * Client-side mirror of the daemon's policy rules: first issue message of a
 * zod parse, or null when the policy is valid. Used for inline form errors
 * before the PATCH.
 */
export function policyIssue(policy: unknown): string | null {
  const parsed = ProjectSandboxPolicySchema.safeParse(policy);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "invalid sandbox policy");
}

/** Loads the project's saved policy; null when none was saved yet. */
export async function fetchProjectPolicy(
  projectId: string,
  fetcher: PolicyFetcher = apiFetch,
): Promise<ProjectSandboxPolicy | null> {
  const body = await fetcher<ProjectPolicyBody>(`/api/projects/${encodeURIComponent(projectId)}`);
  return body.project.sandboxPolicy ?? null;
}

/**
 * Whole-policy replace (`PATCH`). Returns the stored policy (daemon-normal:
 * `executionMode` defaulted). A 422 throws `ApiError` with zod `details`.
 */
export async function patchProjectPolicy(
  projectId: string,
  policy: ProjectSandboxPolicy,
  fetcher: PolicyFetcher = apiFetch,
): Promise<ProjectSandboxPolicy> {
  const body = await fetcher<ProjectPolicyBody>(
    `/api/projects/${encodeURIComponent(projectId)}/policy`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(policy),
    },
  );
  if (!body.project.sandboxPolicy) {
    throw new ApiError("BAD_JSON", "daemon did not return the saved sandbox policy", 0);
  }
  return body.project.sandboxPolicy;
}
