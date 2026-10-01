"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Run } from "@openeuler/core";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { apiFetch, ApiError } from "@/lib/api";

/**
 * Minimal "New run" modal: prompt textarea plus an optional model override.
 * Creates an ad-hoc run via POST /api/runs and navigates to its detail page.
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
    <Dialog open onClose={onClose} label="New run">
      <h2 className="text-title font-semibold text-fg">New run</h2>
      <p className="mt-0.5 text-sm text-muted-fg">
        Describe a task for the agent to execute against this project.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <Field label="Prompt" htmlFor="new-run-prompt">
          <Textarea
            id="new-run-prompt"
            autoFocus
            rows={4}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="e.g. Add a README section describing the CLI flags"
          />
        </Field>
        <Field label="Model" hint="(optional)" htmlFor="new-run-model">
          <Input
            id="new-run-model"
            type="text"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="daemon default"
          />
        </Field>
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
            disabled={trimmedPrompt.length === 0 || submitting}
            loading={submitting}
          >
            {submitting ? "Starting…" : "Start run"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
