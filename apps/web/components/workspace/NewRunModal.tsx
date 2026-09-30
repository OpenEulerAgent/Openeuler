"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Run } from "@openeuler/core";
import { Button } from "@/components/Button";
import { apiFetch, ApiError } from "@/lib/api";

/**
 * Minimal "New run" modal: prompt textarea plus an optional model override.
 * Creates an ad-hoc run via POST /api/runs and navigates to its detail page.
 * The full workflows UI arrives with #17.
 */
export function NewRunModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedPrompt = prompt.trim();
  const submit = async () => {
    if (trimmedPrompt.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        projectId,
        prompt: trimmedPrompt,
        ...(model.trim().length === 0 ? {} : { model: model.trim() }),
      };
      const created = await apiFetch<{ run: Run }>("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      router.push(`/runs/${created.run.id}`);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Failed to create run");
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="New run"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-slate-900">New run</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Describe a task for the agent to execute against this project.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Prompt
            <textarea
              autoFocus
              rows={4}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="e.g. Add a README section describing the CLI flags"
              className="rounded-md border border-slate-300 p-2 font-normal text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Model <span className="font-normal text-slate-400">(optional)</span>
            <input
              type="text"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="daemon default"
              className="rounded-md border border-slate-300 px-2 py-1.5 font-normal text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none"
            />
          </label>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={trimmedPrompt.length === 0 || submitting}
            >
              {submitting ? "Starting…" : "Start run"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
