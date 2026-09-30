"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Workflow } from "@openeuler/core";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
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
      <Card title="Loading workflow…" description="Fetching it from the daemon.">
        <p className="py-6 text-sm text-slate-400">This should only take a moment.</p>
      </Card>
    );
  }
  if (load.phase === "notfound") {
    return (
      <Card title="Workflow not found" description="The daemon has no record of this workflow.">
        <div className="py-4 text-sm text-slate-500">
          <p>It may have been deleted, or the link is stale.</p>
          <WorkflowListLink projectId={projectId} />
        </div>
      </Card>
    );
  }
  if (load.phase === "error") {
    return (
      <Card title="Could not load workflow" description="The daemon did not answer as expected.">
        <div className="flex flex-col items-start gap-3 py-4 text-sm text-slate-500">
          <p className="text-red-600">{load.message}</p>
          <Button variant="secondary" onClick={() => setAttempt((count) => count + 1)}>
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  return <WorkflowEditor projectId={projectId} workflow={load.workflow} />;
}

function WorkflowListLink({ projectId }: { projectId: string }) {
  return (
    <Link
      href={`/projects/${encodeURIComponent(projectId)}/workflows`}
      className="mt-3 inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
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
      <Card
        title={workflow ? `Edit “${workflow.name}”` : "New workflow"}
        description="Chain agent steps with an optional loop back. Saved to the daemon and runnable against this project."
        action={<WorkflowListLink projectId={projectId} />}
      >
        <div className="flex flex-col gap-4">
          <label className="flex max-w-md flex-col gap-1 text-sm font-medium text-slate-700">
            Workflow name
            <input
              type="text"
              value={draft.name}
              onChange={(event) => dispatch({ type: "rename", name: event.target.value })}
              placeholder="e.g. implement → critique → fix"
              className={`rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none ${
                errors["name"] ? "border-red-400" : ""
              }`}
            />
            {errors["name"] ? (
              <p className="text-xs text-red-600" role="alert">
                {errors["name"]}
              </p>
            ) : null}
          </label>

          <label className="flex max-w-md flex-col gap-1 text-sm font-medium text-slate-700">
            Preview sample task{" "}
            <span className="font-normal text-slate-400">
              (used by every step’s prompt preview)
            </span>
            <input
              type="text"
              value={sampleTask}
              onChange={(event) => setSampleTask(event.target.value)}
              placeholder={DEFAULT_SAMPLE_TASK}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none"
            />
          </label>
        </div>
      </Card>

      <Card title="Steps" description="Executed top to bottom; each step is one agent invocation.">
        <div className="flex flex-col gap-3">
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
        </div>
      </Card>

      <Card
        title="Loop"
        description="Optionally jump back from the last step while a condition holds."
      >
        <LoopSection
          loop={draft.loop}
          stepNames={draft.steps.map((step) => step.name || "Untitled step")}
          errors={errors}
          onPatch={(patch) => dispatch({ type: "patch-loop", patch })}
          onToggle={(enabled) => dispatch({ type: "set-loop-enabled", enabled })}
        />
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {formError ? (
          <p className="text-sm text-red-600" role="alert">
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
