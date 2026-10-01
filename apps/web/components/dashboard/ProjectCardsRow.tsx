"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Project } from "@openeuler/core";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { FolderIcon } from "@/components/shell/icons";
import { apiFetch, ApiError } from "@/lib/api";
import { activeRunsByProject, useActiveRuns } from "@/lib/active-runs";

type ProjectsState =
  | { phase: "loading" }
  | { phase: "ready"; projects: Project[] }
  | { phase: "error"; message: string };

/**
 * Project cards row (#51): path, branch and live active-run count per
 * project, with quick actions (open workspace, new workflow).
 */
export function ProjectCardsRow() {
  const [state, setState] = useState<ProjectsState>({ phase: "loading" });
  const active = useActiveRuns();

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ projects: Project[] }>("/api/projects")
      .then((body) => {
        if (!cancelled) setState({ phase: "ready", projects: body.projects });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            phase: "error",
            message: cause instanceof ApiError ? cause.message : "Failed to load projects",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "loading") {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="project-cards">
        {Array.from({ length: 3 }, (_, index) => (
          <Card key={index}>
            <CardContent className="flex flex-col gap-3 py-5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-6 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <Card data-testid="project-cards">
        <CardContent>
          <div className="flex flex-col items-start gap-3 py-2 text-sm">
            <p className="text-danger">{state.message}</p>
            <p className="text-xs text-muted-fg">Projects appear once the daemon is reachable.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (state.projects.length === 0) {
    return (
      <Card data-testid="project-cards">
        <CardContent>
          <EmptyState
            icon={<FolderIcon className="size-5" />}
            title="No projects yet"
            description="Open a local git working copy to browse its files, build workflows and run the agent against it."
            action={
              <Link
                href="/projects"
                className="inline-flex items-center rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                Open your first project…
              </Link>
            }
          />
        </CardContent>
      </Card>
    );
  }

  const byProject = activeRunsByProject(active.runs);

  return (
    <div
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      data-testid="project-cards"
      aria-label="Projects"
    >
      {state.projects.map((project) => {
        const counts = byProject[project.id];
        const activeCount = counts === undefined ? 0 : counts.queued + counts.running;
        return (
          <Card key={project.id}>
            <CardContent className="flex flex-col gap-3 py-5">
              <div className="flex items-start justify-between gap-2">
                <Link
                  href={`/projects/${encodeURIComponent(project.id)}`}
                  className="min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="block truncate text-sm font-semibold text-fg">
                    {project.name}
                  </span>
                  <span
                    className="mt-0.5 block truncate font-mono text-xs text-muted-fg"
                    title={project.path}
                  >
                    {project.path}
                  </span>
                </Link>
                {activeCount > 0 ? (
                  <Badge variant="info" title={`${counts?.running ?? 0} running · ${counts?.queued ?? 0} queued`}>
                    <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />
                    {counts?.running ?? 0} running
                    {(counts?.queued ?? 0) > 0 ? ` · ${counts?.queued} queued` : ""}
                  </Badge>
                ) : null}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs text-muted-fg">
                  {project.defaultBranch}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Link
                    href={`/projects/${encodeURIComponent(project.id)}`}
                    className="rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-fg transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    Open
                  </Link>
                  <Link
                    href={`/projects/${encodeURIComponent(project.id)}/workflows/new`}
                    className="rounded-md px-2 py-1 text-xs font-medium text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    + Workflow
                  </Link>
                </span>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
