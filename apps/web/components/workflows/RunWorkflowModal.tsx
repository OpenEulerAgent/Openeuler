"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Workflow } from "@openeuler/core";
import { Button } from "@/components/Button";
import { ApiError } from "@/lib/api";
import { startWorkflowRun } from "@/lib/workflows-api";

/**
 * "Run this workflow" modal: required task textarea → POST
 * /api/workflows/:id/runs (202) → navigate to `/runs/:id`.
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Run ${workflow.name}`}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-slate-900">Run “{workflow.name}”</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Describe the task for this run. It is passed to the workflow as{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">{"{{task}}"}</code>.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Task{" "}
            <span className="font-normal text-red-500" aria-hidden>
              *
            </span>
            <textarea
              autoFocus
              rows={4}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="e.g. Fix the failing tests in packages/core"
              className="rounded-md border border-slate-300 p-2 font-normal text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none"
            />
          </label>
          {error ? (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={trimmed.length === 0 || submitting}>
              {submitting ? "Starting…" : "Start run"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
