import { apiFetch } from "./api";

/**
 * Approval-gate API client (#118): resolve the gate a run is currently
 * waiting on via `POST /api/runs/:id/approvals/:nodeId`. 409s mean the run
 * is no longer awaiting that node (resolved elsewhere, timed out,
 * restarted daemon) — callers treat it as "refresh and show truth".
 */

/** The awaiting block `GET /api/runs/:id` serves while a gate is open. */
export interface RunAwaitingView {
  nodeId: string;
  nodeName?: string;
  prompt: string;
  /** ISO timestamp the wait opened. */
  since: string;
}

/** Approve/reject the gate; resolves once the daemon accepted the decision. */
export async function resolveRunApproval(
  runId: string,
  nodeId: string,
  approve: boolean,
  note?: string,
): Promise<void> {
  await apiFetch(`/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(nodeId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      approve,
      ...(note === undefined || note.trim().length === 0 ? {} : { note: note.trim() }),
    }),
  });
}
