"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Project } from "@openeuler/core";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
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
      <Card
        title="Open project"
        description="Point the daemon at a local git working copy (absolute path)."
      >
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void openProject();
              }}
              placeholder="/absolute/path/to/repo"
              aria-label="Project path"
              className="min-w-64 flex-1 rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none"
            />
            <Button
              onClick={() => void openProject()}
              disabled={path.trim().length === 0 || opening}
            >
              {opening ? "Opening…" : "Open"}
            </Button>
          </div>
          {openError ? <p className="text-sm text-red-600">{openError}</p> : null}
        </div>
      </Card>

      <Card
        title="Projects"
        description="Registered working copies, newest first."
        action={
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
      >
        {state.phase === "loading" ? (
          <p className="py-6 text-sm text-slate-400">Loading projects…</p>
        ) : state.phase === "error" ? (
          <div className="flex flex-col items-start gap-3 py-4 text-sm">
            <p className="text-red-600">{state.message}</p>
            <Button variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : state.projects.length === 0 ? (
          <p className="py-6 text-sm text-slate-400">
            No projects opened yet — paste an absolute path to a git repository above.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {state.projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/projects/${project.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-3 hover:bg-slate-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-sm text-slate-900">
                      {project.path}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">
                      {project.defaultBranch}
                      {project.dirty ? " · uncommitted changes" : ""}
                    </span>
                  </span>
                  <span className="text-xs text-slate-400">
                    opened {new Date(project.createdAt).toLocaleString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
