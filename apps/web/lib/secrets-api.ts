import { SECRET_NAME_SCHEMA } from "@openeuler/core";
import { ApiError, apiFetch } from "./api";

/**
 * Per-project secrets API client (#93). Values are write-only: every type
 * here intentionally has no value field, and the UI never renders one.
 */

/** A secret row as the listing serves it: name + createdAt, nothing else. */
export interface ProjectSecretName {
  name: string;
  createdAt: string;
}

/** Injectable transport so flows are testable without a browser. */
export type SecretsFetcher = typeof apiFetch;

/** Client-side mirror of the daemon's 422 name rules; null when valid. */
export function secretNameIssue(name: string): string | null {
  const parsed = SECRET_NAME_SCHEMA.safeParse(name);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "invalid secret name");
}

export async function fetchProjectSecrets(
  projectId: string,
  fetcher: SecretsFetcher = apiFetch,
): Promise<ProjectSecretName[]> {
  const body = await fetcher<{ secrets: ProjectSecretName[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/secrets`,
  );
  return body.secrets;
}

export async function putProjectSecret(
  projectId: string,
  name: string,
  value: string,
  fetcher: SecretsFetcher = apiFetch,
): Promise<ProjectSecretName> {
  const body = await fetcher<{ secret: ProjectSecretName }>(
    `/api/projects/${encodeURIComponent(projectId)}/secrets`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, value }),
    },
  );
  return body.secret;
}

export async function deleteProjectSecret(
  projectId: string,
  name: string,
  fetcher: SecretsFetcher = apiFetch,
): Promise<void> {
  await fetcher(
    `/api/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

/** True when the daemon answered 503 SECRETS_UNAVAILABLE (no key loaded). */
export function isSecretsUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.code === "SECRETS_UNAVAILABLE";
}
