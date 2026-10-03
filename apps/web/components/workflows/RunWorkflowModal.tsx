"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Workflow } from "@openeuler/core";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { effectiveModeHint, fetchSandboxStatus, type SandboxStatus } from "@/lib/sandbox-api";
import { startWorkflowRun } from "@/lib/workflows-api";

/**
 * "Run this workflow" modal: required task textarea → POST
 * /api/workflows/:id/runs (202) → navigate to `/runs/:id`. The hint line
 * under the task (#106) shows the project's effective execution mode given
 * the daemon's docker availability, so surprises land BEFORE the launch.
 */
export function RunWorkflowModal({
  workflow,
  onClose,
}: {
  workflow: Workflow;
  onClose: () => void;
}) {
  const router = useRouter();
  const [task, setTask] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dockerStatus, setDockerStatus] = useState<SandboxStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSandboxStatus(workflow.projectId).then(
      (status) => {
        if (!cancelled) setDockerStatus(status);
      },
      () => {
        if (!cancelled) setDockerStatus(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workflow.projectId]);

  const trimmed = task.trim();
  const submit = async () => {
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await startWorkflowRun(workflow.id, trimmed);
      router.push(`/runs/${run.id}`);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Failed to start run");
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onClose={onClose} disableClose={submitting} label={`Run ${workflow.name}`}>
      <h2 className="text-title font-semibold text-fg">Run “{workflow.name}”</h2>
      <p className="mt-0.5 text-sm text-muted-fg">
        Describe the task for this run. It is passed to the workflow as{" "}
        <code className="rounded bg-elevated px-1 py-0.5 font-mono text-xs">{"{{task}}"}</code>.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <Field label="Task" htmlFor="run-workflow-task">
          <Textarea
            id="run-workflow-task"
            autoFocus
            rows={4}
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="e.g. Fix the failing tests in packages/core"
          />
        </Field>
        {dockerStatus !== null && dockerStatus.projectMode !== undefined ? (
          <p className="text-xs text-muted-fg" data-effective-mode-hint>
            {effectiveModeHint({
              executionMode: dockerStatus.projectMode,
              available: dockerStatus.available,
            })}
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={trimmed.length === 0 || submitting}
            loading={submitting}
          >
            {submitting ? "Starting…" : "Start run"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
