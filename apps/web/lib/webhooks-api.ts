import { ApiError, apiFetch, daemonBaseUrl } from "./api";

/**
 * Workflow webhook API client (#120). The signing secret is write-only in
 * the GitHub sense: it exists in exactly one response (create/rotate) and
 * the UI shows it once with a curl snippet, never persisted client-side.
 */

/** A webhook as the daemon serves it (never includes the secret). */
export interface WorkflowWebhook {
  id: string;
  workflowId: string;
  defaultTask?: string;
  createdAt: string;
  updatedAt: string;
}

/** One delivery-log row (the daemon keeps the newest 50 per webhook). */
export interface WebhookDelivery {
  id: number;
  webhookId: string;
  outcome: "accepted" | "rejected";
  statusCode: number;
  authMode?: "signature" | "token";
  runId?: string;
  errorCode?: string;
  createdAt: string;
}

/** Injectable transport so flows are testable without a browser. */
export type WebhookFetcher = typeof apiFetch;

export interface WorkflowWebhookDetail {
  webhook: WorkflowWebhook;
  deliveries: WebhookDelivery[];
}

/** True when the daemon answered 404 WEBHOOK_NOT_FOUND (no webhook yet). */
export function isWebhookMissing(err: unknown): boolean {
  return err instanceof ApiError && err.code === "WEBHOOK_NOT_FOUND";
}

/** Loads the workflow's webhook + delivery ring; null when none exists. */
export async function fetchWorkflowWebhook(
  workflowId: string,
  fetcher: WebhookFetcher = apiFetch,
): Promise<WorkflowWebhookDetail | null> {
  try {
    return await fetcher<WorkflowWebhookDetail>(
      `/api/workflows/${encodeURIComponent(workflowId)}/webhook`,
    );
  } catch (cause) {
    if (isWebhookMissing(cause)) return null;
    throw cause;
  }
}

/** Creates the webhook; the plaintext secret is returned exactly once. */
export async function createWorkflowWebhook(options: {
  workflowId: string;
  defaultTask?: string;
  fetcher?: WebhookFetcher;
}): Promise<{ webhook: WorkflowWebhook; secret: string }> {
  const { workflowId, defaultTask, fetcher = apiFetch } = options;
  return fetcher<{ webhook: WorkflowWebhook; secret: string }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/webhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(defaultTask === undefined ? {} : { defaultTask }) }),
    },
  );
}

/**
 * Rotates the secret and/or edits the default task. The new plaintext
 * secret is returned exactly once, only when `rotateSecret` was set.
 */
export async function patchWorkflowWebhook(options: {
  workflowId: string;
  rotateSecret?: boolean;
  defaultTask?: string | null;
  fetcher?: WebhookFetcher;
}): Promise<{ webhook: WorkflowWebhook; secret?: string }> {
  const { workflowId, rotateSecret, defaultTask, fetcher = apiFetch } = options;
  return fetcher<{ webhook: WorkflowWebhook; secret?: string }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/webhook`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(rotateSecret === undefined ? {} : { rotateSecret }),
        ...(defaultTask === undefined ? {} : { defaultTask }),
      }),
    },
  );
}

export async function deleteWorkflowWebhook(
  workflowId: string,
  fetcher: WebhookFetcher = apiFetch,
): Promise<void> {
  await fetcher(`/api/workflows/${encodeURIComponent(workflowId)}/webhook`, {
    method: "DELETE",
  });
}

/**
 * The absolute trigger URL shown in the drawer's curl snippet (based on
 * `NEXT_PUBLIC_DAEMON_URL`, same origin the web app talks to).
 */
export function webhookTriggerUrl(hookId: string): string {
  return `${daemonBaseUrl()}/api/hooks/${encodeURIComponent(hookId)}`;
}
