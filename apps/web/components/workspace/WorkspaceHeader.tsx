"use client";

import Link from "next/link";
import type { Project } from "@openeuler/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * Workspace header: project path (mono), default branch badge, dirty
 * indicator from the project snapshot, Settings, and the New run CTA.
 */
export function WorkspaceHeader({
  project,
  onNewRun,
  onSettings,
}: {
  project: Project;
  onNewRun: () => void;
  onSettings: () => void;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-fg">
            <Link
              href="/projects"
              className="transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Projects
            </Link>
            <span aria-hidden className="mx-1">
              /
            </span>
            {project.name}
          </p>
          <h1
            className="mt-1 truncate font-mono text-title font-semibold text-fg"
            title={project.path}
          >
            {project.path}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="neutral" className="gap-1.5">
            <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="currentColor">
              <path d="M9.5 3.25a2.25 2.25 0 1 1 3.25 2.014v3.236A2.75 2.75 0 0 1 10 11.25H6.977a1.25 1.25 0 0 0-1.227 1.017 2.25 2.25 0 1 1-1.482-.369A2.75 2.75 0 0 1 6.977 9.75H10a1.25 1.25 0 0 0 1.25-1.25V5.264A2.25 2.25 0 0 1 9.5 3.25z" />
            </svg>
            {project.defaultBranch}
          </Badge>
          {project.dirty ? (
            <Badge
              variant="warning"
              title="The working copy had uncommitted changes when the project was registered"
            >
              uncommitted changes
            </Badge>
          ) : project.dirty === false ? (
            <Badge variant="success">clean</Badge>
          ) : null}
          <Button
            variant="secondary"
            size="icon"
            onClick={onSettings}
            aria-label="Project settings (secrets)"
            title="Project settings (secrets)"
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M6.5 1.5h3l.35 1.75 1.6.93 1.7-.62 1.5 2.6-1.35 1.17v1.34l1.35 1.17-1.5 2.6-1.7-.62-1.6.93L9.5 14.5h-3l-.35-1.75-1.6-.93-1.7.62-1.5-2.6 1.35-1.17V7.33L1.35 6.16l1.5-2.6 1.7.62 1.6-.93L6.5 1.5z" />
              <circle cx="8" cy="8" r="2" />
            </svg>
          </Button>
          <Button onClick={onNewRun}>New run</Button>
        </div>
      </div>
      {project.remoteUrl ? (
        <p
          className="mt-3 truncate border-t border-border pt-3 font-mono text-xs text-muted-fg"
          title={project.remoteUrl}
        >
          {project.remoteUrl}
        </p>
      ) : null}
    </Card>
  );
}
