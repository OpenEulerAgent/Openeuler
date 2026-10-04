"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { resolveRunApproval, type RunAwaitingView } from "@/lib/approval";
import { formatElapsed } from "@/lib/run-feed";
import { cn } from "@/lib/cn";

/**
 * Approval banner (#118): shown on the run detail while the run is PAUSED
 * at an approval gate — the prompt, how long it has been waiting, a note
 * input, and Approve / Reject (Reject asks for an inline confirm — a
 * rejection can fail the run or route it away). Both actions POST the
 * decision and refresh the detail; the SSE stream then carries the
 * `node.approved` + follow-up events that move the graph forward. A 409
 * means someone else resolved it (or it timed out) — also just a refresh.
 */
export function ApprovalBanner({
  runId,
  awaiting,
  nowMs,
  live,
  onChanged,
}: {
  runId: string;
  /** The awaiting view from `GET /api/runs/:id`; renders nothing when null. */
  awaiting: RunAwaitingView | null;
  /** Ticking clock for the "waiting since" label. */
  nowMs: number;
  /** Only live (running) runs accept decisions here. */
  live: boolean;
  /** Called after a successful decision (or a 409) to refetch the detail. */
  onChanged: () => void;
}) {
  const [note, setNote] = useState("");
  const [confirmReject, setConfirmReject] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (awaiting === null) return null;

  const decide = async (approve: boolean): Promise<void> => {
    setBusy(approve ? "approve" : "reject");
    setError(null);
    try {
      await resolveRunApproval(runId, awaiting.nodeId, approve, note);
      setNote("");
      setConfirmReject(false);
      onChanged();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        // Resolved elsewhere / timed out: the refresh shows the truth.
        setConfirmReject(false);
        onChanged();
      } else {
        setError(cause instanceof ApiError ? cause.message : "Failed to record the decision");
      }
    } finally {
      setBusy(null);
    }
  };

  const sinceMs = Date.parse(awaiting.since);
  const waitingLabel = Number.isNaN(sinceMs)
    ? null
    : `waiting for ${formatElapsed(sinceMs, nowMs)}`;

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-warning-subtle px-4 py-3"
      data-approval-banner
      data-approval-node={awaiting.nodeId}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-warning" data-approval-title>
          Approval needed
        </span>
        {waitingLabel !== null ? (
          <span className="text-xs text-muted-fg" data-approval-since>
            {waitingLabel}
          </span>
        ) : null}
        <span className="flex-1" />
        {awaiting.nodeName !== undefined ? (
          <span className="rounded-full bg-elevated px-2 py-0.5 font-mono text-[10px] text-muted-fg">
            {awaiting.nodeName}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-fg" data-approval-prompt>
        {awaiting.prompt.length > 0 ? awaiting.prompt : "Approve to continue this run."}
      </p>
      {live ? (
        <>
          <Input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Note (optional — recorded with the decision)"
            aria-label="Approval note"
            maxLength={2000}
            data-approval-note
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              loading={busy === "approve"}
              disabled={busy !== null}
              onClick={() => void decide(true)}
              data-approval-approve
            >
              Approve
            </Button>
            {confirmReject ? (
              <>
                <span className="text-xs text-muted-fg">
                  Reject{note.trim().length > 0 ? " with this note" : ""}?
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  loading={busy === "reject"}
                  disabled={busy !== null}
                  onClick={() => void decide(false)}
                  data-approval-reject-confirm
                >
                  Confirm reject
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmReject(false)}
                  disabled={busy !== null}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                className={cn("border-danger/40 text-danger hover:bg-danger-subtle")}
                disabled={busy !== null}
                onClick={() => setConfirmReject(true)}
                data-approval-reject
              >
                Reject
              </Button>
            )}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-fg">
          The run is not executing (interrupted?) — resume it to act on this approval.
        </p>
      )}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}
