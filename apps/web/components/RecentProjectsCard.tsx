"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Project } from "@openeuler/core";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonLines } from "@/components/ui/skeleton";
import { FolderIcon } from "@/components/shell/icons";
import { apiFetch, ApiError } from "@/lib/api";

type ListState =
  | { phase: "loading" }
  | { phase: "ready"; projects: Project[] }
  | { phase: "error"; message: string };

async function fetchRecentProjects(): Promise<ListState> {
  try {
    const body = await apiFetch<{ projects: Project[] }>("/api/projects");
    return { phase: "ready", projects: body.projects.slice(0, 5) };
  } catch (cause) {
    return {
      phase: "error",
      message: cause instanceof ApiError ? cause.message : "Failed to load projects",
    };
  }
}

/** Dashboard card content: the five most recently opened projects. */
export function RecentProjectsCard() {
  const [state, setState] = useState<ListState>({ phase: "loading" });

  const load = useCallback(async (): Promise<void> => {
    setState(await fetchRecentProjects());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") return <SkeletonLines rows={3} />;
  if (state.phase === "error") {
    return (
      <div className="flex flex-col items-start gap-3 py-2 text-sm">
        <p className="text-danger">{state.message}</p>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }
  if (state.projects.length === 0) {
    return (
      <EmptyState
        icon={<FolderIcon className="size-5" />}
        title="No projects yet"
        description="Open a local git working copy to browse its files and run the agent against it."
        action={
          <Link
            href="/projects"
            className="inline-flex items-center rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Open a project…
          </Link>
        }
      />
    );
  }

  return (
    <ul className="divide-y divide-border">
      {state.projects.map((project) => (
        <li key={project.id}>
          <Link
            href={`/projects/${project.id}`}
            className="-mx-2 flex items-center justify-between gap-2 rounded-md px-2 py-2.5 transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-fg">{project.name}</span>
              <span className="mt-0.5 block truncate font-mono text-xs text-muted-fg">
                {project.path}
              </span>
            </span>
            <span className="shrink-0 text-xs text-muted-fg">{project.defaultBranch}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
