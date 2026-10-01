"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonLines } from "@/components/ui/skeleton";
import { fetchDriverIds, fetchWorkflowForEditor, type WorkflowLoad } from "@/lib/workflows-api";
import { GraphCanvasEditor } from "./GraphCanvasEditor";

type LoadState = { phase: "loading" } | WorkflowLoad;

/**
 * Canvas editor page shell (#46): loads the workflow (with its latest graph
 * revision) plus the registered drivers, then hands off to the React Flow
 * canvas. Every failure collapses to a card with a retry/back path.
 */
export function CanvasEditorView({
  projectId,
  workflowId,
}: {
  projectId: string;
  workflowId: string;
}) {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [drivers, setDrivers] = useState<string[] | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad({ phase: "loading" });
    void fetchWorkflowForEditor(workflowId).then((state) => {
      if (!cancelled) setLoad(state);
    });
    return () => {
      cancelled = true;
    };
  }, [workflowId, attempt]);

  useEffect(() => {
    let cancelled = false;
    void fetchDriverIds().then((ids) => {
      if (!cancelled) setDrivers(ids);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (load.phase === "loading") {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Loading workflow…</CardTitle>
            <CardDescription>Fetching its latest graph revision.</CardDescription>
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
            <BackLink projectId={projectId} />
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

  return <GraphCanvasEditor workflow={load.workflow} drivers={drivers ?? []} />;
}

function BackLink({ projectId }: { projectId: string }) {
  return (
    <Link
      href={`/projects/${encodeURIComponent(projectId)}/workflows`}
      className="mt-3 inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    >
      ← All workflows
    </Link>
  );
}
