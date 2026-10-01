"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { starterGraph } from "@/lib/graph/canvas-document";
import { createWorkflowWithGraph } from "@/lib/workflows-api";

/**
 * Create-workflow form for the canvas era (#46): a name is all that is
 * needed — the workflow is created with a one-entry-agent starter graph
 * (revision 1) and the user lands straight on the canvas editor.
 */
export function NewWorkflowForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const submit = async () => {
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createWorkflowWithGraph({
        projectId,
        name: trimmed,
        graph: starterGraph(),
      });
      toast({
        variant: "success",
        title: `Created “${trimmed}”`,
        description: "Revision 1 saved.",
      });
      router.push(
        `/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(result.workflow.id)}/edit`,
      );
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Failed to create workflow");
      setSubmitting(false);
    }
  };

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <div>
          <CardTitle>New workflow</CardTitle>
          <CardDescription>
            Name it — you will shape the agent graph on the canvas (the entry agent node starts
            prompted with {"{{task}}"}).
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field label="Workflow name" htmlFor="new-workflow-name" error={error ?? undefined}>
          <Input
            id="new-workflow-name"
            autoFocus
            value={name}
            invalid={error !== null}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            placeholder="e.g. implement → review → fix"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            disabled={submitting}
            onClick={() => router.push(`/projects/${encodeURIComponent(projectId)}/workflows`)}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={trimmed.length === 0}
            loading={submitting}
          >
            {submitting ? "Creating…" : "Create and open canvas"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
