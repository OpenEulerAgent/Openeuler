"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { ApiError } from "@/lib/api";
import { formatRelativeAge } from "@/lib/time";
import { fetchWorkflowRevisions, type WorkflowRevisionListed } from "@/lib/workflows-api";

/** Drawer fetch state: every failure collapses to one message row. */
type RevisionListState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; revisions: WorkflowRevisionListed[] };

/**
 * Revision history drawer (#77): lists the workflow's immutable revisions
 * (number, createdAt, "current" on the latest) with a read-only "View"
 * action per row. Fetches on every open so a freshly minted revision shows
 * without leaving the editor. v0.12 keeps it strictly read-only — no
 * restore.
 */
export function RevisionHistoryDrawer({
  open,
  workflowId,
  currentRevision,
  onClose,
  onView,
}: {
  open: boolean;
  workflowId: string;
  /** The revision the editor is based on; the list's top row mirrors it. */
  currentRevision: number | null;
  onClose: () => void;
  /** Load this revision's graph into the read-only snapshot view. */
  onView: (revisionNumber: number) => void;
}) {
  const [state, setState] = useState<RevisionListState>({ phase: "loading" });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ phase: "loading" });
    fetchWorkflowRevisions(workflowId)
      .then((revisions) => {
        if (cancelled) return;
        setState({
          phase: "ready",
          // Newest first so the current revision leads the list.
          revisions: [...revisions].sort((a, b) => b.number - a.number),
        });
      })
      .catch((cause) => {
        if (cancelled) return;
        setState({
          phase: "error",
          message: cause instanceof ApiError ? cause.message : "Failed to load revisions",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open, workflowId]);

  return (
    <Drawer open={open} onClose={onClose} label="Revision history">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-title font-semibold text-fg">Revision history</h2>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-fg">
        Every save snapshots the graph as an immutable revision. Viewing one is read-only — the
        current canvas is untouched.
      </p>
      <ul className="mt-4 flex flex-col gap-2" data-revision-list>
        {state.phase === "loading" ? (
          <li className="rounded-lg border border-border p-3 text-sm text-muted-fg">
            Loading revisions…
          </li>
        ) : null}
        {state.phase === "error" ? (
          <li
            className="rounded-lg border border-danger/50 bg-danger-subtle p-3 text-sm text-danger"
            role="alert"
          >
            {state.message}
          </li>
        ) : null}
        {state.phase === "ready"
          ? state.revisions.map((revision) => {
              // When the editor carries no revision pointer (legacy
              // workflow), the newest row still reads as current.
              const current = revision.number === (currentRevision ?? state.revisions[0]?.number);
              return (
                <li
                  key={revision.id}
                  data-revision-row={revision.number}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3"
                >
                  <span className="font-mono text-sm text-fg">rev {revision.number}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-fg">
                    {formatRelativeAge(revision.createdAt)}
                  </span>
                  {current ? <Badge variant="success">current</Badge> : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`View revision ${revision.number}`}
                    onClick={() => onView(revision.number)}
                  >
                    View
                  </Button>
                </li>
              );
            })
          : null}
        {state.phase === "ready" && state.revisions.length === 0 ? (
          <li className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-fg">
            No revisions yet — the first save will snapshot this graph.
          </li>
        ) : null}
      </ul>
    </Drawer>
  );
}
