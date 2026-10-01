"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Workflow } from "@openeuler/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonLines } from "@/components/ui/skeleton";
import { FolderIcon } from "@/components/shell/icons";
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
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Workflows</CardTitle>
          <CardDescription>Repeatable multi-step pipelines for this project.</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
          <Button size="sm" onClick={() => router.push(`${basePath}/new`)}>
            New workflow
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {state.phase === "loading" ? (
          <SkeletonLines rows={3} />
        ) : state.phase === "error" ? (
          <div className="flex flex-col items-start gap-3 py-2 text-sm">
            <p className="text-danger">{state.message}</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : state.workflows.length === 0 ? (
          <EmptyState
            icon={<FolderIcon className="size-5" />}
            title="No workflows yet"
            description="Create one to chain agent steps (with optional loops)."
            action={
              <Button size="sm" onClick={() => router.push(`${basePath}/new`)}>
                New workflow
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border" data-testid="workflow-list">
            {state.workflows.map((workflow) => {
              const loop = loopBadge(workflow);
              const deletingThis = confirmDelete === workflow.id && deleting;
              return (
                <li key={workflow.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`${basePath}/${encodeURIComponent(workflow.id)}`}
                      className="min-w-0 rounded-sm transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <span className="block truncate text-sm font-medium text-fg">
                        {workflow.name}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-fg">
                        <span>
                          {workflow.steps.length} step{workflow.steps.length === 1 ? "" : "s"}
                        </span>
                        {loop ? <Badge variant="accent">loop {loop}</Badge> : <Badge>linear</Badge>}
                      </span>
                    </Link>
                    <span className="flex items-center gap-2">
                      <Button size="sm" onClick={() => setRunTarget(workflow)}>
                        Run
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          router.push(`${basePath}/${encodeURIComponent(workflow.id)}`)
                        }
                      >
                        Edit
                      </Button>
                      {confirmDelete === workflow.id ? (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={deleting}
                            onClick={() => setConfirmDelete(null)}
                          >
                            Keep
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            loading={deletingThis}
                            onClick={() => void doDelete(workflow.id)}
                          >
                            {deletingThis ? "Deleting…" : "Confirm delete"}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
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
          <p className="mt-3 text-sm text-danger" role="alert">
            {actionError}
          </p>
        ) : null}
        {runTarget ? (
          <RunWorkflowModal workflow={runTarget} onClose={() => setRunTarget(null)} />
        ) : null}
      </CardContent>
    </Card>
  );
}
