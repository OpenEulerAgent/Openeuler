"use client";

import { useCallback, useEffect, useState } from "react";
import type { Run } from "@openeuler/core";
import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonLines } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PlayIcon } from "@/components/shell/icons";
import { apiFetch, ApiError } from "@/lib/api";
import { isRunHosted } from "@/lib/hosting";
import { useRunStats } from "@/lib/runs-stats";

/** A run row as returned by the API: core Run plus computed queue metadata. */
type RunRow = Run & { queuePosition?: number };

type ListState =
  { phase: "loading" } | { phase: "ready"; runs: RunRow[] } | { phase: "error"; message: string };

async function fetchRuns(projectId?: string): Promise<ListState> {
  try {
    const query = projectId === undefined ? "" : `?projectId=${encodeURIComponent(projectId)}`;
    const body = await apiFetch<{ runs: RunRow[] }>(`/api/runs${query}`);
    return { phase: "ready", runs: body.runs };
  } catch (cause) {
    return {
      phase: "error",
      message: cause instanceof ApiError ? cause.message : "Failed to load runs",
    };
  }
}

/** Live queued/running count badges (global counts; hidden on scoped lists). */
function RunCountBadges() {
  const state = useRunStats();
  if (state.status !== "ready") return null;
  const { queued, running } = state.stats;
  if (queued === 0 && running === 0) return null;
  return (
    <span className="flex items-center gap-2">
      <StatusBadge status="running">Running · {running}</StatusBadge>
      <StatusBadge status="queued">Queued · {queued}</StatusBadge>
    </span>
  );
}

/** Run history table (newest first): status, branch, task, created time. */
export function RunsList({
  projectId,
  title = "Runs",
  description,
  emptyText = "No runs yet. Start one from a project (or POST /api/runs).",
}: {
  projectId?: string;
  title?: string;
  description?: string;
  emptyText?: string;
}) {
  const [state, setState] = useState<ListState>({ phase: "loading" });

  const load = useCallback(async (): Promise<void> => {
    setState(await fetchRuns(projectId));
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>
            {description ?? "Every run known to the daemon, newest first."}
          </CardDescription>
        </div>
        <span className="flex items-center gap-3">
          {projectId === undefined ? <RunCountBadges /> : null}
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
        </span>
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
        ) : state.runs.length === 0 ? (
          <EmptyState
            icon={<PlayIcon className="size-5" />}
            title="No runs"
            description={emptyText}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Branch / task</TableHead>
                <TableHead className="w-44 text-right">Created</TableHead>
                <TableHead className="w-28 text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Link
                      href={`/runs/${run.id}`}
                      className="block min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <span className="block truncate font-mono text-sm text-fg">{run.branch}</span>
                      {run.task ? (
                        <span className="mt-0.5 block max-w-xl truncate text-xs text-muted-fg">
                          {run.task}
                        </span>
                      ) : null}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    {run.status === "queued" && run.queuePosition !== undefined ? (
                      <span className="block text-xs text-muted-fg">
                        #{run.queuePosition} in queue
                      </span>
                    ) : null}
                    <span className="text-xs text-muted-fg">
                      {new Date(run.createdAt).toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusBadge status={run.status} />
                      {isRunHosted(run) ? (
                        <span
                          className="rounded-full border border-success/50 bg-success-subtle px-2 py-0.5 text-xs font-medium text-success"
                          title="Sandbox kept alive for previews (hosting)"
                          data-hosted-badge
                        >
                          hosted
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
