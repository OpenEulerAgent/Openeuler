"use client";

import Link from "next/link";
import type { Project } from "@openeuler/core";
import { Button } from "@/components/Button";

/**
 * Workspace header: project path (mono), default branch badge, dirty
 * indicator from the project snapshot, and the New run CTA.
 */
export function WorkspaceHeader({ project, onNewRun }: { project: Project; onNewRun: () => void }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            <Link href="/projects" className="hover:text-slate-600">
              Projects
            </Link>
            <span aria-hidden className="mx-1">
              /
            </span>
            {project.name}
          </p>
          <h1
            className="mt-1 truncate font-mono text-lg font-semibold text-slate-900"
            title={project.path}
          >
            {project.path}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600"
            title="Default branch"
          >
            <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="currentColor">
              <path d="M9.5 3.25a2.25 2.25 0 1 1 3.25 2.014v3.236A2.75 2.75 0 0 1 10 11.25H6.977a1.25 1.25 0 0 0-1.227 1.017 2.25 2.25 0 1 1-1.482-.369A2.75 2.75 0 0 1 6.977 9.75H10a1.25 1.25 0 0 0 1.25-1.25V5.264A2.25 2.25 0 0 1 9.5 3.25z" />
            </svg>
            {project.defaultBranch}
          </span>
          {project.dirty ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700"
              title="The working copy had uncommitted changes when the project was registered"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
              uncommitted changes
            </span>
          ) : project.dirty === false ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
              <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
              clean
            </span>
          ) : null}
          <Button onClick={onNewRun}>New run</Button>
        </div>
      </div>
      {project.remoteUrl ? (
        <p
          className="mt-3 border-t border-slate-100 pt-3 truncate font-mono text-xs text-slate-500"
          title={project.remoteUrl}
        >
          {project.remoteUrl}
        </p>
      ) : null}
    </section>
  );
}
