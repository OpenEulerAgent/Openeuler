"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Workflow } from "@openeuler/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SkeletonLines } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import {
  DEFAULT_SAMPLE_TASK,
  createWorkflowDraft,
  draftReducer,
  errorsAfterAction,
  fieldErrorsFromApiError,
  validateDraft,
  workflowToDraft,
  type DraftAction,
  type FieldErrors,
} from "@/lib/workflow-builder";
import {
  fetchDriverIds,
  fetchWorkflowForEditor,
  saveWorkflowDraft,
  type WorkflowLoad,
} from "@/lib/workflows-api";
import { LoopSection } from "./LoopSection";
import { StepCard } from "./StepCard";

type LoadState = { phase: "loading" } | WorkflowLoad;

/**
 * Workflow editor page shell: loads the workflow (edit mode) and hands off to
 * {@link WorkflowEditor}; without a workflowId it starts a fresh draft.
 */
export function WorkflowEditorView({
  projectId,
  workflowId,
}: {
  projectId: string;
  /** Absent → create a new workflow. */
  workflowId?: string;
}) {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    setLoad({ phase: "loading" });
    void fetchWorkflowForEditor(workflowId).then((state) => {
      if (!cancelled) setLoad(state);
    });
    return () => {
      cancelled = true;
    };
  }, [workflowId, attempt]);

  if (!workflowId) return <WorkflowEditor projectId={projectId} />;

  if (load.phase === "loading") {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Loading workflow…</CardTitle>
            <CardDescription>Fetching it from the daemon.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <SkeletonLines rows={3} />
        </CardContent>
      </Card>
    );
  }
  if (load.phase === "notfound") {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Workflow not found</CardTitle>
            <CardDescription>The daemon has no record of this workflow.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="py-2 text-sm text-muted-fg">
            <p>It may have been deleted, or the link is stale.</p>
            <WorkflowListLink projectId={projectId} />
          </div>
        </CardContent>
      </Card>
    );
  }
  if (load.phase === "error") {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Could not load workflow</CardTitle>
            <CardDescription>The daemon did not answer as expected.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-start gap-3 py-2 text-sm">
            <p className="text-danger">{load.message}</p>
            <Button variant="secondary" onClick={() => setAttempt((count) => count + 1)}>
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return <WorkflowEditor projectId={projectId} workflow={load.workflow} />;
}

function WorkflowListLink({ projectId }: { projectId: string }) {
  return (
    <Link
      href={`/projects/${encodeURIComponent(projectId)}/workflows`}
      className="mt-3 inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    >
      ← All workflows
    </Link>
  );
}

/**
 * The editor form: workflow name, ordered step list (add/remove/reorder),
 * loop-back section, client-side validation, save via POST/PATCH with server
 * 422s mapped back onto fields.
 */
export function WorkflowEditor({
  projectId,
  workflow,
}: {
  projectId: string;
  workflow?: Workflow;
}) {
  const router = useRouter();
  const [draft, reduce] = useReducer(draftReducer, workflow, (existing) =>
    existing ? workflowToDraft(existing) : createWorkflowDraft(),
  );
  const [drivers, setDrivers] = useState<string[]>([]);
  const [sampleTask, setSampleTask] = useState(DEFAULT_SAMPLE_TASK);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dispatch = useCallback((action: DraftAction) => {
    reduce(action);
    setErrors((current) => errorsAfterAction(current, action));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchDriverIds().then((ids) => {
      if (!cancelled) setDrivers(ids);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (saving) return;
    const clientErrors = validateDraft(draft);
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length > 0) {
      setFormError("Fix the highlighted fields before saving.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await saveWorkflowDraft({ projectId, draft, workflowId: workflow?.id });
      router.push(`/projects/${encodeURIComponent(projectId)}/workflows`);
    } catch (cause) {
      const mapped = fieldErrorsFromApiError(cause, draft.loop.conditionType);
      if (Object.keys(mapped).length > 0) {
        setErrors(mapped);
        setFormError("The daemon rejected the workflow — fix the highlighted fields.");
      } else {
        setFormError(cause instanceof ApiError ? cause.message : "Failed to save workflow");
      }
      setSaving(false);
    }
  }, [draft, projectId, router, saving, workflow?.id]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{workflow ? `Edit “${workflow.name}”` : "New workflow"}</CardTitle>
            <CardDescription>
              Chain agent steps with an optional loop back. Saved to the daemon and runnable against
              this project.
            </CardDescription>
          </div>
          <WorkflowListLink projectId={projectId} />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex max-w-md flex-col gap-1 text-sm font-medium text-fg">
            Workflow name
            <Input
              type="text"
              value={draft.name}
              invalid={errors["name"] !== undefined}
              onChange={(event) => dispatch({ type: "rename", name: event.target.value })}
              placeholder="e.g. implement → critique → fix"
            />
            {errors["name"] ? (
              <p className="text-xs text-danger" role="alert">
                {errors["name"]}
              </p>
            ) : null}
          </div>

          <label className="flex max-w-md flex-col gap-1 text-sm font-medium text-fg">
            Preview sample task{" "}
            <span className="font-normal text-muted-fg">(used by every step’s prompt preview)</span>
            <Input
              type="text"
              value={sampleTask}
              onChange={(event) => setSampleTask(event.target.value)}
              placeholder={DEFAULT_SAMPLE_TASK}
            />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Steps</CardTitle>
            <CardDescription>
              Executed top to bottom; each step is one agent invocation.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {draft.steps.map((step, index) => (
            <StepCard
              key={step.id}
              index={index}
              total={draft.steps.length}
              step={step}
              errors={errors}
              drivers={drivers}
              sampleTask={sampleTask}
              onPatch={(patch) => dispatch({ type: "patch-step", index, patch })}
              onRemove={() => dispatch({ type: "remove-step", index })}
              onMove={(dir) => dispatch({ type: "move-step", index, dir })}
            />
          ))}
          <div>
            <Button variant="secondary" onClick={() => dispatch({ type: "add-step" })}>
              + Add step
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Loop</CardTitle>
            <CardDescription>
              Optionally jump back from the last step while a condition holds.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <LoopSection
            loop={draft.loop}
            stepNames={draft.steps.map((step) => step.name || "Untitled step")}
            errors={errors}
            onPatch={(patch) => dispatch({ type: "patch-loop", patch })}
            onToggle={(enabled) => dispatch({ type: "set-loop-enabled", enabled })}
          />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {formError ? (
          <p className="text-sm text-danger" role="alert">
            {formError}
          </p>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() => router.push(`/projects/${encodeURIComponent(projectId)}/workflows`)}
          >
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : workflow ? "Save changes" : "Create workflow"}
          </Button>
        </div>
      </div>
    </div>
  );
}
