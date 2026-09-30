import type { Run, Workflow } from "@openeuler/core";
import { ApiError, apiFetch } from "./api";
import { DEFAULT_DRIVER_IDS, draftToPayload, type WorkflowDraft } from "./workflow-builder";

/** Injectable transport so submit flows are testable without a browser. */
export type WorkflowFetcher = typeof apiFetch;

export async function fetchWorkflows(
  projectId: string,
  fetcher: WorkflowFetcher = apiFetch,
): Promise<Workflow[]> {
  const body = await fetcher<{ workflows: Workflow[] }>(
    `/api/workflows?projectId=${encodeURIComponent(projectId)}`,
  );
  return body.workflows;
}

export async function fetchWorkflow(
  workflowId: string,
  fetcher: WorkflowFetcher = apiFetch,
): Promise<Workflow> {
  const body = await fetcher<{ workflow: Workflow }>(
    `/api/workflows/${encodeURIComponent(workflowId)}`,
  );
  return body.workflow;
}

/**
 * Registered driver ids for the step dropdown, from `GET /api/drivers`.
 * Falls back to the static default list when the daemon is unreachable or
 * reports none (older daemon without the endpoint).
 */
export async function fetchDriverIds(fetcher: WorkflowFetcher = apiFetch): Promise<string[]> {
  try {
    const body = await fetcher<{ drivers: string[] }>("/api/drivers");
    return body.drivers.length > 0 ? body.drivers : [...DEFAULT_DRIVER_IDS];
  } catch {
    return [...DEFAULT_DRIVER_IDS];
  }
}

/**
 * Save a draft: POST to create, PATCH to update. The PATCH always sends
 * name + steps and `loopBack: null` when the loop is disabled, so a stored
 * loop is cleared by disabling it in the editor.
 */
export async function saveWorkflowDraft(options: {
  projectId: string;
  draft: WorkflowDraft;
  /** Present → PATCH this workflow; absent → POST a new one. */
  workflowId?: string;
  fetcher?: WorkflowFetcher;
}): Promise<Workflow> {
  const { projectId, draft, workflowId, fetcher = apiFetch } = options;
  const payload = draftToPayload(draft);
  const body = workflowId
    ? { ...payload, loopBack: payload.loopBack ?? null }
    : { ...payload, projectId };

  const response = await fetcher<{ workflow: Workflow }>(
    workflowId ? `/api/workflows/${encodeURIComponent(workflowId)}` : "/api/workflows",
    {
      method: workflowId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return response.workflow;
}

export async function deleteWorkflow(
  workflowId: string,
  fetcher: WorkflowFetcher = apiFetch,
): Promise<void> {
  await fetcher<void>(`/api/workflows/${encodeURIComponent(workflowId)}`, { method: "DELETE" });
}

/**
 * Run-modal submit flow: POST /api/workflows/:id/runs with the required task,
 * returning the accepted run (202) to navigate to `/runs/:id`.
 */
export async function startWorkflowRun(
  workflowId: string,
  task: string,
  fetcher: WorkflowFetcher = apiFetch,
): Promise<Run> {
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    throw new ApiError("TASK_REQUIRED", "task must be a non-empty string", 0);
  }
  const body = await fetcher<{ run: Run }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: trimmed }),
    },
  );
  return body.run;
}
