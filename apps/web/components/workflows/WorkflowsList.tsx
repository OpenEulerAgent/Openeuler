"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Workflow } from "@openeuler/core";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { apiFetch, ApiError } from "@/lib/api";
import { fetchWorkflows } from "@/lib/workflows-api";
import { RunWorkflowModal } from "./RunWorkflowModal";

type ListState =
  | { phase: "loading" }
  | { phase: "ready"; workflows: Workflow[] }
  | { phase: "error"; message: string };

/** Badge body summarizing a workflow's loop config, or null when it runs linearly. */
export function loopBadge(workflow: Workflow): string | null {
  if (!workflow.loopBack) return null;
  const target = workflow.steps[workflow.loopBack.toStepIndex];
  const targetLabel = target ? `→ ${workflow.loopBack.toStepIndex + 1}. ${target.name}` : "→ ?";
  const when = workflow.loopBack.when;
  const condition =
    when.type === "always"
      ? "always"
      : when.type === "outputMatches"
        ? `output ~ /${when.regex}/`
        : `${when.type.includes("Not") ? "not " : ""}"${when.pattern}"`;
  return `${targetLabel} while ${condition} (max ${workflow.loopBack.maxIterations})`;
}

/**
 * Workflow list for a project: name, step count, loop badge, run/edit/delete.
 * Used both in the workspace tab and on the dedicated workflows page; the
 * editor itself opens on `/projects/[id]/workflows/[workflowId]`.
 */
export function WorkflowsList({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [state, setState] = useState<ListState>({ phase: "loading" });
  const [runTarget, setRunTarget] = useState<Workflow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setState({ phase: "ready", workflows: await fetchWorkflows(projectId) });
    } catch (cause) {
      setState({
        phase: "error",
        message: cause instanceof ApiError ? cause.message : "Failed to load workflows",
      });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const doDelete = async (id: string): Promise<void> => {
    setDeleting(true);
    setActionError(null);
    try {
      await apiFetch<void>(`/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
      setConfirmDelete(null);
      await load();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : "Failed to delete workflow");
    } finally {
      setDeleting(false);
    }
  };

  const basePath = `/projects/${encodeURIComponent(projectId)}/workflows`;

  return (
    <Card
      title="Workflows"
      description="Repeatable multi-step pipelines for this project."
      action={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
          <Link
            href={`${basePath}/new`}
            className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            New workflow
          </Link>
        </div>
      }
    >
      {state.phase === "loading" ? (
        <p className="py-6 text-sm text-slate-400">Loading workflows…</p>
      ) : state.phase === "error" ? (
        <div className="flex flex-col items-start gap-3 py-4 text-sm">
          <p className="text-red-600">{state.message}</p>
          <Button variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : state.workflows.length === 0 ? (
        <p className="py-6 text-sm text-slate-400">
          No workflows yet — create one to chain agent steps (with optional loops).
        </p>
      ) : (
        <ul className="divide-y divide-slate-100" data-testid="workflow-list">
          {state.workflows.map((workflow) => {
            const loop = loopBadge(workflow);
            const deletingThis = confirmDelete === workflow.id && deleting;
            return (
              <li key={workflow.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={`${basePath}/${encodeURIComponent(workflow.id)}`}
                    className="min-w-0 hover:underline"
                  >
                    <span className="block truncate text-sm font-medium text-slate-900">
                      {workflow.name}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>
                        {workflow.steps.length} step{workflow.steps.length === 1 ? "" : "s"}
                      </span>
                      {loop ? (
                        <span className="rounded-full bg-violet-100 px-2 py-0.5 font-medium text-violet-700">
                          loop {loop}
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                          linear
                        </span>
                      )}
                    </span>
                  </Link>
                  <span className="flex items-center gap-2">
                    <Button onClick={() => setRunTarget(workflow)}>Run</Button>
                    <Button
                      variant="secondary"
                      onClick={() => router.push(`${basePath}/${encodeURIComponent(workflow.id)}`)}
                    >
                      Edit
                    </Button>
                    {confirmDelete === workflow.id ? (
                      <>
                        <Button
                          variant="secondary"
                          disabled={deleting}
                          onClick={() => setConfirmDelete(null)}
                        >
                          Keep
                        </Button>
                        <Button
                          className="bg-red-600 hover:bg-red-500"
                          disabled={deletingThis}
                          onClick={() => void doDelete(workflow.id)}
                        >
                          {deletingThis ? "Deleting…" : "Confirm delete"}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setConfirmDelete(workflow.id);
                          setActionError(null);
                        }}
                      >
                        Delete
                      </Button>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {actionError ? (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {actionError}
        </p>
      ) : null}
      {runTarget ? (
        <RunWorkflowModal workflow={runTarget} onClose={() => setRunTarget(null)} />
      ) : null}
    </Card>
  );
}
