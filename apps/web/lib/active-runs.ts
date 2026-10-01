"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunStatus } from "@openeuler/core";
import { apiFetch } from "./api";
import { useRunStatusStream } from "./runs-stream";

/**
 * Shared live snapshot of every non-terminal run (#51): seeded from the runs
 * table (queued + running lists), then kept current by the global
 * run-status stream. Every consumer shares ONE page-wide stream
 * subscription (#62) — this hook, the TopBar indicator and the dashboard
 * runs table all fan out of the same `EventSource`.
 */

export interface ActiveRunInfo {
  id: string;
  status: "queued" | "running";
  projectId?: string;
}

/** Totals across all projects. */
export function activeRunsCounts(runs: readonly ActiveRunInfo[]): {
  queued: number;
  running: number;
} {
  let queued = 0;
  let running = 0;
  for (const run of runs) {
    if (run.status === "queued") queued += 1;
    else running += 1;
  }
  return { queued, running };
}

/** Active counts grouped per project (missing key = none active). */
export function activeRunsByProject(
  runs: readonly ActiveRunInfo[],
): Record<string, { queued: number; running: number }> {
  const byProject: Record<string, { queued: number; running: number }> = {};
  for (const run of runs) {
    if (run.projectId === undefined) continue;
    const bucket = (byProject[run.projectId] ??= { queued: 0, running: 0 });
    if (run.status === "queued") bucket.queued += 1;
    else bucket.running += 1;
  }
  return byProject;
}

/** Merges one stream transition into the snapshot map (pure). */
export function mergeRunStatusIntoMap(
  map: ReadonlyMap<string, ActiveRunInfo>,
  event: { runId: string; status: RunStatus; projectId?: string },
): Map<string, ActiveRunInfo> {
  const next = new Map(map);
  if (event.status === "queued" || event.status === "running") {
    const existing = next.get(event.runId);
    next.set(event.runId, {
      id: event.runId,
      status: event.status,
      projectId: event.projectId ?? existing?.projectId,
    });
  } else {
    next.delete(event.runId);
  }
  return next;
}

async function seedActiveRuns(): Promise<Map<string, ActiveRunInfo>> {
  const [queuedBody, runningBody] = await Promise.all([
    apiFetch<{ runs: Array<{ id: string; projectId: string; status: RunStatus }> }>(
      "/api/runs?status=queued",
    ),
    apiFetch<{ runs: Array<{ id: string; projectId: string; status: RunStatus }> }>(
      "/api/runs?status=running",
    ),
  ]);
  const map = new Map<string, ActiveRunInfo>();
  for (const run of [...queuedBody.runs, ...runningBody.runs]) {
    map.set(run.id, {
      id: run.id,
      status: run.status === "queued" ? "queued" : "running",
      projectId: run.projectId,
    });
  }
  return map;
}

export interface UseActiveRunsResult {
  /** Snapshot state: loading until the first seed lands. */
  status: "loading" | "ready" | "error";
  runs: ActiveRunInfo[];
}

/**
 * The shared live snapshot hook. Seeded once on mount, re-seeded on every
 * stream (re)connect to heal reconnect gaps, patched by every transition.
 */
export function useActiveRuns(): UseActiveRunsResult {
  const [state, setState] = useState<UseActiveRunsResult>({ status: "loading", runs: [] });
  const mapRef = useRef<ReadonlyMap<string, ActiveRunInfo>>(new Map());

  const seed = useCallback(async (): Promise<void> => {
    try {
      const map = await seedActiveRuns();
      mapRef.current = map;
      setState({ status: "ready", runs: [...map.values()] });
    } catch {
      setState((current) =>
        current.status === "loading" ? { status: "error", runs: [] } : current,
      );
    }
  }, []);

  useEffect(() => {
    void seed();
  }, [seed]);

  useRunStatusStream({
    onEvent: (event) => {
      mapRef.current = mergeRunStatusIntoMap(mapRef.current, event);
      setState({ status: "ready", runs: [...mapRef.current.values()] });
    },
    onOpen: () => {
      void seed();
    },
  });

  return state;
}
