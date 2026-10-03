"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Project } from "@openeuler/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonLines } from "@/components/ui/skeleton";
import { tabPanelProps } from "@/components/ui/tabs";
import { RunsList } from "@/components/RunsList";
import { WorkflowsList } from "@/components/workflows/WorkflowsList";
import { apiFetch, ApiError } from "@/lib/api";
import {
  canGoBack,
  canGoForward,
  historyBack,
  historyCurrent,
  historyForward,
  historyPush,
  initHistory,
} from "@/lib/workspace";
import { FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";
import { NewRunModal } from "./NewRunModal";
import { ProjectSettingsDrawer } from "./ProjectSettingsDrawer";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { WorkspaceTabs, type WorkspaceTab } from "./WorkspaceTabs";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; project: Project }
  | { phase: "notfound" }
  | { phase: "error"; message: string };

async function fetchProject(projectId: string): Promise<LoadState> {
  try {
    const body = await apiFetch<{ project: Project }>(
      `/api/projects/${encodeURIComponent(projectId)}`,
    );
    return { phase: "ready", project: body.project };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return { phase: "notfound" };
    return {
      phase: "error",
      message: cause instanceof ApiError ? cause.message : "Failed to load project",
    };
  }
}

/**
 * The opened-project experience: header (path/branch/dirty + New run), a
 * Files | Workflows | Runs tab bar, a lazy file tree + viewer, and this
 * project's runs. Daemon-down and unknown-id states mirror the run detail
 * page (friendly card + retry).
 */
export function WorkspaceView({ projectId }: { projectId: string }) {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [tab, setTab] = useState<WorkspaceTab>("files");
  const [history, setHistory] = useState(initHistory<string>);
  const [showNewRun, setShowNewRun] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoad(await fetchProject(projectId));
  }, [projectId]);

  useEffect(() => {
    setLoad({ phase: "loading" });
    setTab("files");
    setHistory(initHistory<string>());
    void refresh();
  }, [refresh]);

  const openFile = useCallback((path: string) => {
    setHistory((prev) => historyPush(prev, path));
  }, []);

  if (load.phase === "loading") {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Loading project…</CardTitle>
            <CardDescription>Fetching project {projectId} from the daemon.</CardDescription>
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
            <CardTitle>Project not found</CardTitle>
            <CardDescription>The daemon has no record of this project.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-start gap-3 py-2 text-sm text-muted-fg">
            <p>
              Project <span className="font-mono text-fg">{projectId}</span> does not exist — it may
              have been removed, or the link is stale.
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => void refresh()}>
                Try again
              </Button>
              <Link
                href="/projects"
                className="inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                Back to projects
              </Link>
            </div>
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
            <CardTitle>Could not load project</CardTitle>
            <CardDescription>The daemon did not answer as expected.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-start gap-3 py-2 text-sm">
            <p className="text-danger">{load.message}</p>
            <Button variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const project = load.project;
  const currentFile = historyCurrent(history);

  return (
    <div className="flex flex-col gap-4">
      <WorkspaceHeader
        project={project}
        onNewRun={() => setShowNewRun(true)}
        onSettings={() => setShowSettings(true)}
      />

      <WorkspaceTabs active={tab} onChange={setTab} />

      {tab === "files" ? (
        <div
          className="grid min-h-[28rem] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]"
          {...tabPanelProps("files")}
        >
          <div className="min-h-48 lg:min-h-0">
            <FileTree projectId={project.id} onOpenFile={openFile} />
          </div>
          <FileViewer
            projectId={project.id}
            path={currentFile}
            canBack={canGoBack(history)}
            canForward={canGoForward(history)}
            onBack={() => setHistory((prev) => historyBack(prev))}
            onForward={() => setHistory((prev) => historyForward(prev))}
          />
        </div>
      ) : null}

      {tab === "runs" ? (
        <div {...tabPanelProps("runs")}>
          <RunsList
            projectId={project.id}
            title="Project runs"
            description={`Runs executed against ${project.name}, newest first.`}
            emptyText="No runs for this project yet — start one with the New run button above."
          />
        </div>
      ) : null}

      {tab === "workflows" ? (
        <div {...tabPanelProps("workflows")}>
          <WorkflowsList projectId={project.id} />
        </div>
      ) : null}

      {showNewRun ? (
        <NewRunModal projectId={project.id} onClose={() => setShowNewRun(false)} />
      ) : null}

      {showSettings ? (
        <ProjectSettingsDrawer projectId={project.id} onClose={() => setShowSettings(false)} />
      ) : null}
    </div>
  );
}
