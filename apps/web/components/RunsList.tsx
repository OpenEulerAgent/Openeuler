"use client";

import { useCallback, useEffect, useState } from "react";
import type { Run } from "@openeuler/core";
import Link from "next/link";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { StatusBadge } from "@/components/StatusBadge";
import { apiFetch, ApiError } from "@/lib/api";

type ListState =
  { phase: "loading" } | { phase: "ready"; runs: Run[] } | { phase: "error"; message: string };

async function fetchRuns(projectId?: string): Promise<ListState> {
  try {
    const query = projectId === undefined ? "" : `?projectId=${encodeURIComponent(projectId)}`;
    const body = await apiFetch<{ runs: Run[] }>(`/api/runs${query}`);
    return { phase: "ready", runs: body.runs };
  } catch (cause) {
    return {
      phase: "error",
      message: cause instanceof ApiError ? cause.message : "Failed to load runs",
    };
  }
}

/** Run history list (newest first): status badge, branch, task, created time. */
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
    <Card
      title={title}
      description={description ?? "Every run known to the daemon, newest first."}
      action={
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      {state.phase === "loading" ? (
        <p className="py-6 text-sm text-slate-400">Loading runs…</p>
      ) : state.phase === "error" ? (
        <div className="flex flex-col items-start gap-3 py-4 text-sm">
          <p className="text-red-600">{state.message}</p>
          <Button variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : state.runs.length === 0 ? (
        <p className="py-6 text-sm text-slate-400">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {state.runs.map((run) => (
            <li key={run.id}>
              <Link
                href={`/runs/${run.id}`}
                className="flex flex-wrap items-center justify-between gap-2 py-3 hover:bg-slate-50"
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-sm text-slate-900">
                    {run.branch}
                  </span>
                  {run.task ? (
                    <span className="mt-0.5 block max-w-xl truncate text-xs text-slate-500">
                      {run.task}
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-slate-400">
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                  <StatusBadge status={run.status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
