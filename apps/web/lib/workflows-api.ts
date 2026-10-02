import type {
  AgentPreset,
  GraphSummary,
  Run,
  StepConfig,
  Workflow,
  WorkflowGraph,
} from "@openeuler/core";
import { ApiError, apiFetch } from "./api";

/** Injectable transport so submit flows are testable without a browser. */
export type WorkflowFetcher = typeof apiFetch;

/**
 * A workflow row as the LIST serves it (#70): the row plus the
 * daemon-computed graph summary of the latest revision (absent for legacy
 * workflows that were never saved as revisions).
 */
export type WorkflowListed = Workflow & {
  graphSummary?: GraphSummary;
};

/** A workflow row plus the latest-revision graph the daemon serves with it. */
export type WorkflowWithGraph = Workflow & {
  latestRevision?: { id: string; number: number };
  graph?: WorkflowGraph;
  graphSummary?: GraphSummary;
};

export async function fetchWorkflows(
  projectId: string,
  fetcher: WorkflowFetcher = apiFetch,
): Promise<WorkflowListed[]> {
  const body = await fetcher<{ workflows: WorkflowListed[] }>(
    `/api/workflows?projectId=${encodeURIComponent(projectId)}`,
  );
  return body.workflows;
}

export async function fetchWorkflow(
  workflowId: string,
  fetcher: WorkflowFetcher = apiFetch,
): Promise<WorkflowWithGraph> {
  const body = await fetcher<{ workflow: WorkflowWithGraph }>(
    `/api/workflows/${encodeURIComponent(workflowId)}`,
  );
  return body.workflow;
}

/** Editor load state for one workflow: every failure collapses to a phase. */
export type WorkflowLoad =
  | { phase: "ready"; workflow: WorkflowWithGraph }
  | { phase: "notfound" }
  | { phase: "error"; message: string };

/** Fetch one workflow for the editor, collapsing failures into a load state. */
export async function fetchWorkflowForEditor(
  workflowId: string,
  fetcher: WorkflowFetcher = apiFetch,
): Promise<WorkflowLoad> {
  try {
    return { phase: "ready", workflow: await fetchWorkflow(workflowId, fetcher) };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return { phase: "notfound" };
    return {
      phase: "error",
      message: cause instanceof ApiError ? cause.message : "Failed to load workflow",
    };
  }
}

/** Driver dropdown fallback when `GET /api/drivers` is unreachable or empty. */
const DEFAULT_DRIVER_IDS: readonly string[] = ["opencode"];

/** Driver ids plus whether the static default list had to stand in (#74). */
export interface DriverIdsResult {
  ids: string[];
  /** True when `/api/drivers` was unreachable or empty and the defaults are used. */
  fallback: boolean;
}

/**
 * Registered driver ids from `GET /api/drivers`, reporting whether the
 * static default list had to stand in (#74) so callers can warn.
 */
export async function fetchDriverIdsResult(
  fetcher: WorkflowFetcher = apiFetch,
): Promise<DriverIdsResult> {
  try {
    const body = await fetcher<{ drivers: string[] }>("/api/drivers");
    if (body.drivers.length > 0) return { ids: body.drivers, fallback: false };
    return { ids: [...DEFAULT_DRIVER_IDS], fallback: true };
  } catch {
    return { ids: [...DEFAULT_DRIVER_IDS], fallback: true };
  }
}

/**
 * Registered driver ids for the step dropdown, from `GET /api/drivers`.
 * Falls back to the static default list when the daemon is unreachable or
 * reports none (older daemon without the endpoint).
 */
export async function fetchDriverIds(fetcher: WorkflowFetcher = apiFetch): Promise<string[]> {
  return (await fetchDriverIdsResult(fetcher)).ids;
}

export async function deleteWorkflow(
  workflowId: string,
  fetcher: WorkflowFetcher = apiFetch,
): Promise<void> {
  await fetcher<void>(`/api/workflows/${encodeURIComponent(workflowId)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Agent presets ("your team", #49). Nodes copy configs at creation time;
// preset edits never silently mutate existing nodes.
//

/** The project's preset roster (builtins first, then by name). */
export async function fetchAgentPresets(
  projectId: string,
  fetcher: WorkflowFetcher = apiFetch,
): Promise<AgentPreset[]> {
  const body = await fetcher<{ presets: AgentPreset[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/presets`,
  );
  return body.presets;
}

export async function createAgentPreset(options: {
  projectId: string;
  name: string;
  description?: string;
  icon?: string;
  config: StepConfig;
  fetcher?: WorkflowFetcher;
}): Promise<AgentPreset> {
  const { projectId, name, description, icon, config, fetcher = apiFetch } = options;
  const body = await fetcher<{ preset: AgentPreset }>(
    `/api/projects/${encodeURIComponent(projectId)}/presets`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        ...(description === undefined ? {} : { description }),
        ...(icon === undefined ? {} : { icon }),
        config,
      }),
    },
  );
  return body.preset;
}

/** Mutable preset fields; `icon: null` clears it. */
export interface AgentPresetUpdatePatch {
  name?: string;
  description?: string;
  icon?: string | null;
  config?: StepConfig;
}

export async function updateAgentPreset(options: {
  projectId: string;
  presetId: string;
  patch: AgentPresetUpdatePatch;
  fetcher?: WorkflowFetcher;
}): Promise<AgentPreset> {
  const { projectId, presetId, patch, fetcher = apiFetch } = options;
  const body = await fetcher<{ preset: AgentPreset }>(
    `/api/projects/${encodeURIComponent(projectId)}/presets/${encodeURIComponent(presetId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  return body.preset;
}

export async function deleteAgentPreset(options: {
  projectId: string;
  presetId: string;
  fetcher?: WorkflowFetcher;
}): Promise<void> {
  const { projectId, presetId, fetcher = apiFetch } = options;
  await fetcher<void>(
    `/api/projects/${encodeURIComponent(projectId)}/presets/${encodeURIComponent(presetId)}`,
    { method: "DELETE" },
  );
}

/** Save outcome for the canvas editor: the new immutable revision number. */
export interface SavedGraph {
  workflow: WorkflowWithGraph;
  revision: { id: string; number: number };
}

/**
 * Canvas save (#46): `PUT /api/workflows/:id/graph` — validates server-side
 * (422 details carry node/edge paths) and snapshots the graph as the next
 * immutable revision. `expectedRevision` (#76) optionally pins the revision
 * the editor is based on; a mismatch answers 409 REVISION_CONFLICT instead
 * of silently overwriting the newer revision.
 */
export async function saveWorkflowGraph(options: {
  workflowId: string;
  graph: unknown;
  /** The latest revision the client knows; omit to save unconditionally. */
  expectedRevision?: number;
  fetcher?: WorkflowFetcher;
}): Promise<SavedGraph> {
  const { workflowId, graph, expectedRevision, fetcher = apiFetch } = options;
  return fetcher<SavedGraph>(`/api/workflows/${encodeURIComponent(workflowId)}/graph`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      graph,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  });
}

/**
 * Create a workflow from a graph (canvas "new workflow" flow): POSTs
 * `{projectId, name, graph}` — revision 1 snapshots the graph — and returns
 * the created workflow plus its revision pointer.
 */
export async function createWorkflowWithGraph(options: {
  projectId: string;
  name: string;
  graph: unknown;
  fetcher?: WorkflowFetcher;
}): Promise<SavedGraph> {
  const { projectId, name, graph, fetcher = apiFetch } = options;
  return fetcher<SavedGraph>("/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, name, graph }),
  });
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
