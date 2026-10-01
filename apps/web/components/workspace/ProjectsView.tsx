"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Project } from "@openeuler/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { SkeletonLines } from "@/components/ui/skeleton";
import { FolderIcon } from "@/components/shell/icons";
import { apiFetch, ApiError } from "@/lib/api";

type ListState =
  | { phase: "loading" }
  | { phase: "ready"; projects: Project[] }
  | { phase: "error"; message: string };

async function fetchProjects(): Promise<ListState> {
  try {
    const body = await apiFetch<{ projects: Project[] }>("/api/projects");
    return { phase: "ready", projects: body.projects };
  } catch (cause) {
    return {
      phase: "error",
      message: cause instanceof ApiError ? cause.message : "Failed to load projects",
    };
  }
}

/**
 * Projects landing page: registered projects (linking into the workspace)
 * plus a minimal "Open project" affordance — an absolute path posted to
 * POST /api/projects, then straight to the workspace. The full workflows
 * picker arrives with #17.
 */
export function ProjectsView() {
  const router = useRouter();
  const [state, setState] = useState<ListState>({ phase: "loading" });
  const [path, setPath] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState(await fetchProjects());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openProject = async () => {
    const trimmed = path.trim();
    if (trimmed.length === 0 || opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const body = await apiFetch<{ project: Project }>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: trimmed }),
      });
      router.push(`/projects/${body.project.id}`);
    } catch (cause) {
      setOpenError(cause instanceof ApiError ? cause.message : "Failed to open project");
      setOpening(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Open project</CardTitle>
            <CardDescription>
              Point the daemon at a local git working copy (absolute path).
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Input
                type="text"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void openProject();
                }}
                placeholder="/absolute/path/to/repo"
                aria-label="Project path"
                className="min-w-64 flex-1 font-mono"
              />
              <Button
                onClick={() => void openProject()}
                disabled={path.trim().length === 0 || opening}
                loading={opening}
              >
                {opening ? "Opening…" : "Open"}
              </Button>
            </div>
            {openError ? <p className="text-sm text-danger">{openError}</p> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Projects</CardTitle>
            <CardDescription>Registered working copies, newest first.</CardDescription>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {state.phase === "loading" ? (
            <SkeletonLines rows={4} />
          ) : state.phase === "error" ? (
            <div className="flex flex-col items-start gap-3 py-2 text-sm">
              <p className="text-danger">{state.message}</p>
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : state.projects.length === 0 ? (
            <EmptyState
              icon={<FolderIcon className="size-5" />}
              title="No projects opened yet"
              description="Paste an absolute path to a git repository above to get started."
            />
          ) : (
            <ul className="divide-y divide-border">
              {state.projects.map((project) => (
                <li key={project.id}>
                  <Link
                    href={`/projects/${project.id}`}
                    className="-mx-2 flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-3 transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-sm text-fg">
                        {project.path}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-fg">
                        {project.defaultBranch}
                        {project.dirty ? " · uncommitted changes" : ""}
                      </span>
                    </span>
                    <span className="text-xs text-muted-fg">
                      opened {new Date(project.createdAt).toLocaleString()}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
