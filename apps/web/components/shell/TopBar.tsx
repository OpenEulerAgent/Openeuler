"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Project } from "@openeuler/core";
import { apiFetch } from "@/lib/api";
import { activeRunsCounts, useActiveRuns } from "@/lib/active-runs";
import { useThemeContext } from "@/components/ThemeProvider";
import { HealthPill } from "@/components/HealthPill";
import { MoonIcon, SearchIcon, SunIcon } from "./icons";

/** `/projects/<id>/…` → `<id>`; null off project routes. */
export function projectIdFromPathname(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

/** Project name for the top bar, cached per id (names rarely change). */
function useProjectContext(projectId: string | null): { name: string | null } {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!projectId || names[projectId] !== undefined) return;
    let cancelled = false;
    void apiFetch<{ project: Project }>(`/api/projects/${encodeURIComponent(projectId)}`)
      .then((body) => {
        if (!cancelled) setNames((current) => ({ ...current, [projectId]: body.project.name }));
      })
      .catch(() => {
        if (!cancelled) setNames((current) => ({ ...current, [projectId]: "…" }));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, names]);
  const name = projectId ? (names[projectId] ?? null) : null;
  return { name };
}

/** Live running/queued counts off the global run-status stream; click through to /runs. */
function RunningRunsIndicator() {
  const { status, runs } = useActiveRuns();
  if (status !== "ready") return null;
  const { queued, running } = activeRunsCounts(runs);
  if (queued === 0 && running === 0) return null;
  return (
    <Link
      href="/runs"
      title={`${running} running · ${queued} queued`}
      className="inline-flex items-center gap-1.5 rounded-full border border-info/40 bg-info-subtle px-2.5 py-1 text-xs font-medium text-info transition-colors hover:border-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="size-3 animate-spin"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="8" cy="8" r="6" strokeOpacity="0.3" />
        <path d="M8 2a6 6 0 0 1 6 6" strokeLinecap="round" />
      </svg>
      {running} running
      {queued > 0 ? ` · ${queued} queued` : ""}
    </Link>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useThemeContext();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className="rounded-md p-1.5 text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
    </button>
  );
}

/**
 * Top app-shell bar (issue #50): project context on project routes, daemon
 * health pill, running-runs indicator, ⌘K trigger and theme toggle.
 */
export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const pathname = usePathname();
  const projectId = projectIdFromPathname(pathname);
  const { name } = useProjectContext(projectId);

  const handleSearchClick = useCallback(() => onOpenPalette(), [onOpenPalette]);

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur md:px-6">
      {projectId ? (
        <nav aria-label="Project context" className="min-w-0">
          <Link
            href="/projects"
            className="text-xs font-medium text-muted-fg transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Projects
          </Link>
          <span aria-hidden className="mx-1.5 text-xs text-muted-fg">
            /
          </span>
          <Link
            href={`/projects/${encodeURIComponent(projectId)}`}
            className="truncate text-sm font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            title={name ?? projectId}
          >
            {name ?? projectId}
          </Link>
        </nav>
      ) : null}

      <div className="flex-1" />

      <RunningRunsIndicator />
      <HealthPill />
      <button
        type="button"
        onClick={handleSearchClick}
        aria-label="Open command palette"
        aria-keyshortcuts="Meta+K Control+K"
        title="Search (⌘K)"
        className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <SearchIcon className="size-3.5" />
        <span aria-hidden className="hidden font-mono sm:inline">
          ⌘K
        </span>
      </button>
      <ThemeToggle />
    </header>
  );
}
