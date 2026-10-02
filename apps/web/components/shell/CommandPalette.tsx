"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Project, Run } from "@openeuler/core";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError } from "@/lib/api";
import { navigateWithGuard } from "@/lib/use-unsaved-changes";
import {
  clampSelection,
  confirmOutcome,
  filterPaletteItems,
  groupPaletteItems,
  INITIAL_PALETTE_STATE,
  paletteReducer,
  type PaletteContext,
  type PaletteItem,
} from "@/lib/command-palette";
import { projectIdFromPathname } from "./TopBar";
import { SkeletonLines } from "@/components/ui/skeleton";
import { DashboardIcon, FolderIcon, PlayIcon, SearchIcon, SlidersIcon, StopIcon } from "./icons";
import { cn } from "@/lib/cn";

/** Runs considered "live" for the palette (navigate/stop targets). */
function isLiveRun(run: Run): boolean {
  return run.status === "queued" || run.status === "running";
}

/**
 * ⌘K command palette (issue #50): fuzzy search across pages, projects
 * (fetched), running runs (fetched), and actions (open project, new workflow,
 * stop run). Arrow keys navigate, Enter selects, Escape closes — rendered in
 * the Dialog primitive; state machine lives in lib/command-palette.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const [state, dispatch] = useReducer(paletteReducer, INITIAL_PALETTE_STATE);
  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);

  // Reset query/selection each time the palette opens; refresh dynamic data.
  useEffect(() => {
    if (!open) return;
    dispatch({ type: "open" });
    setLoading(true);
    let cancelled = false;
    void Promise.allSettled([
      apiFetch<{ projects: Project[] }>("/api/projects"),
      apiFetch<{ runs: Run[] }>("/api/runs"),
    ]).then(([projectsResult, runsResult]) => {
      if (cancelled) return;
      if (projectsResult.status === "fulfilled")
        setProjects(projectsResult.value.projects.slice(0, 8));
      if (runsResult.status === "fulfilled")
        setRuns(runsResult.value.runs.filter(isLiveRun).slice(0, 8));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const projectId = projectIdFromPathname(pathname);

  const items = useMemo<PaletteItem[]>(() => {
    const staticItems: PaletteItem[] = [
      {
        id: "action-open-projects",
        group: "Actions",
        label: "Open a project…",
        hint: "/projects",
        keywords: "open project repository add",
        run: (context) => {
          context.router.push("/projects");
          context.close();
        },
      },
      ...(projectId
        ? [
            {
              id: "action-new-workflow",
              group: "Actions" as const,
              label: "New workflow for this project",
              hint: "/projects",
              keywords: "create workflow steps",
              run: (context: PaletteContext) => {
                context.router.push(`/projects/${context.projectId}/workflows/new`);
                context.close();
              },
            },
          ]
        : []),
      {
        id: "page-dashboard",
        group: "Pages",
        label: "Dashboard",
        hint: "/",
        keywords: "home overview",
        run: (context) => {
          context.router.push("/");
          context.close();
        },
      },
      {
        id: "page-projects",
        group: "Pages",
        label: "Projects",
        hint: "/projects",
        keywords: "repos repositories workspace",
        run: (context) => {
          context.router.push("/projects");
          context.close();
        },
      },
      {
        id: "page-runs",
        group: "Pages",
        label: "Runs",
        hint: "/runs",
        keywords: "executions history",
        run: (context) => {
          context.router.push("/runs");
          context.close();
        },
      },
      {
        id: "page-settings",
        group: "Pages",
        label: "Settings",
        hint: "/settings",
        keywords: "preferences theme daemon",
        run: (context) => {
          context.router.push("/settings");
          context.close();
        },
      },
      ...projects.map((project): PaletteItem => {
        const href = `/projects/${project.id}`;
        return {
          id: `project-${project.id}`,
          group: "Projects",
          label: project.name,
          hint: project.path,
          keywords: "open project workspace",
          run: (context) => {
            context.router.push(href);
            context.close();
          },
        };
      }),
      ...runs.map((run): PaletteItem => {
        const href = `/runs/${run.id}`;
        return {
          id: `run-${run.id}`,
          group: "Runs",
          label: run.branch,
          hint: run.task ? run.task.slice(0, 60) : run.status,
          keywords: `run ${run.status} live`,
          run: (context) => {
            context.router.push(href);
            context.close();
          },
        };
      }),
      ...runs.map((run): PaletteItem => {
        return {
          id: `stop-run-${run.id}`,
          group: "Runs",
          label: `Stop ${run.branch}`,
          hint: run.status,
          keywords: "abort stop cancel kill running",
          requiresConfirm: true,
          run: (context) => {
            context.stopRun(run.id);
            context.close();
          },
        };
      }),
    ];
    return staticItems;
  }, [projectId, projects, runs]);

  const filtered = useMemo(() => filterPaletteItems(items, state.query), [items, state.query]);
  const sections = useMemo(() => groupPaletteItems(filtered), [filtered]);
  const selectedIndex = clampSelection(state.selectedIndex, filtered.length);

  const context = useMemo<PaletteContext>(
    () => ({
      // Palette navigation routes through the unsaved-changes guard (#67):
      // on guarded (dirty) pages it opens the confirm dialog instead of
      // discarding edits; everywhere else it pushes immediately.
      router: {
        push: (path: string) => {
          navigateWithGuard(() => router.push(path));
        },
      },
      close: onClose,
      projectId,
      stopRun: (runId: string) => {
        void apiFetch(`/api/runs/${encodeURIComponent(runId)}/abort`, { method: "POST" })
          .then(() => toast({ title: "Stop requested", variant: "info" }))
          .catch((cause: unknown) => {
            if (cause instanceof ApiError && cause.status === 409) {
              toast({ title: "Run already finished", variant: "info" });
              return;
            }
            toast({
              title: "Could not stop run",
              description: cause instanceof ApiError ? cause.message : "Unknown error",
              variant: "danger",
            });
          });
      },
    }),
    [onClose, projectId, router, toast],
  );

  // Two-step confirm: destructive items arm on first activation (Enter/click)
  // and only fire once re-armed; any other key/move resets via the reducer.
  const activate = (item: PaletteItem): void => {
    if (confirmOutcome(item, state.confirmId) === "arm") {
      dispatch({ type: "arm", id: item.id });
      return;
    }
    item.run(context);
  };

  return (
    <Dialog open={open} onClose={onClose} label="Command palette" className="max-w-xl p-0">
      <div className="flex items-center gap-2.5 border-b border-border px-4">
        <SearchIcon className="size-4 shrink-0 text-muted-fg" />
        <input
          autoFocus
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={
            selectedIndex >= 0 ? `command-palette-item-${selectedIndex}` : undefined
          }
          placeholder="Search pages, projects, runs, actions…"
          value={state.query}
          onChange={(event) => dispatch({ type: "query", value: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              dispatch({ type: "move", delta: 1, count: filtered.length });
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              dispatch({ type: "move", delta: -1, count: filtered.length });
            } else if (event.key === "Enter") {
              event.preventDefault();
              const item = filtered[selectedIndex];
              if (item) activate(item);
            }
          }}
          className="w-full bg-transparent py-3 text-sm text-fg outline-none placeholder:text-muted-fg"
        />
        <kbd
          aria-hidden
          className="rounded border border-border px-1.5 py-0.5 font-mono text-small text-muted-fg"
        >
          esc
        </kbd>
      </div>

      <div
        id="command-palette-list"
        role="listbox"
        aria-label="Commands"
        className="max-h-80 overflow-y-auto p-2"
      >
        {filtered.length === 0 && !loading ? (
          <p className="px-3 py-8 text-center text-sm text-muted-fg">
            No results for “{state.query}”.
          </p>
        ) : (
          sections.map((section) => (
            <div key={section.group} className="mb-1">
              <p className="px-3 pb-1 pt-2 text-small font-medium uppercase tracking-wide text-muted-fg">
                {section.group}
              </p>
              {section.items.map((item) => {
                const index = filtered.indexOf(item);
                const selected = index === selectedIndex;
                const armed = item.requiresConfirm && state.confirmId === item.id;
                return (
                  <div
                    key={item.id}
                    id={`command-palette-item-${index}`}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    onClick={() => activate(item)}
                    onMouseEnter={() =>
                      dispatch({
                        type: "move",
                        delta: index - selectedIndex,
                        count: filtered.length,
                      })
                    }
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm",
                      selected ? "bg-accent text-accent-fg" : "text-fg",
                    )}
                  >
                    <span className={cn("shrink-0", selected ? "text-accent-fg" : "text-muted-fg")}>
                      {item.id.startsWith("page-") ? (
                        item.id === "page-dashboard" ? (
                          <DashboardIcon className="size-4" />
                        ) : item.id === "page-projects" ? (
                          <FolderIcon className="size-4" />
                        ) : item.id === "page-runs" ? (
                          <PlayIcon className="size-4" />
                        ) : (
                          <SlidersIcon className="size-4" />
                        )
                      ) : item.id.startsWith("stop-") ? (
                        <StopIcon className="size-3.5" />
                      ) : (
                        <SearchIcon className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {armed ? (
                      <span
                        aria-live="assertive"
                        className="max-w-45 shrink-0 truncate text-xs font-medium"
                      >
                        Press Enter again to stop
                      </span>
                    ) : item.hint ? (
                      <span
                        className={cn(
                          "max-w-45 truncate font-mono text-xs",
                          selected ? "text-accent-fg/80" : "text-muted-fg",
                        )}
                      >
                        {item.hint}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))
        )}
        {loading ? (
          <div className="mb-1 px-3">
            <p className="pb-1 pt-2 text-small font-medium uppercase tracking-wide text-muted-fg">
              Loading projects &amp; runs…
            </p>
            <SkeletonLines rows={3} />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
