"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { starterGraph } from "@/lib/graph/canvas-document";
import { createWorkflowWithGraph, fetchDriverIdsResult } from "@/lib/workflows-api";

/**
 * Create-workflow form for the canvas era (#46): a name is all that is
 * needed — the workflow is created with a one-entry-agent starter graph
 * (revision 1) and the user lands straight on the canvas editor. The entry
 * agent's driver defaults to the first registered driver (#74) so installs
 * without the opencode CLI still work out of the box.
 */
export function NewWorkflowForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [driverIds, setDriverIds] = useState<string[] | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchDriverIdsResult().then((result) => {
      if (cancelled) return;
      setDriverIds(result.ids);
      setDriverId(result.ids[0] ?? null);
      if (result.fallback) {
        toast({
          variant: "info",
          title: "Driver list unavailable",
          description:
            "Could not load registered drivers — defaulting the entry agent to opencode.",
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const trimmed = name.trim();
  const resolvingDrivers = driverId === null;
  const submit = async () => {
    if (trimmed.length === 0 || submitting || driverId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createWorkflowWithGraph({
        projectId,
        name: trimmed,
        graph: starterGraph(driverId),
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
        <Field label="Entry agent driver" htmlFor="new-workflow-driver">
          <Select
            id="new-workflow-driver"
            disabled={driverIds === null}
            value={driverId ?? ""}
            onChange={(event) => setDriverId(event.target.value)}
          >
            {driverIds === null ? (
              <option value="">Loading drivers…</option>
            ) : (
              driverIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))
            )}
          </Select>
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
            loading={submitting || resolvingDrivers}
          >
            {submitting
              ? "Creating…"
              : resolvingDrivers
                ? "Loading drivers…"
                : "Create and open canvas"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
