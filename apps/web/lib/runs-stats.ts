"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "./api";

/** Body of `GET /api/runs/stats`: live queue/execution counts. */
export interface RunStats {
  queued: number;
  running: number;
}

export type RunStatsState =
  | { status: "loading" }
  | { status: "ready"; stats: RunStats }
  | { status: "error"; message: string };

export const RUN_STATS_POLL_INTERVAL_MS = 5000;

/** Fetch `/api/runs/stats` once, collapsing every failure mode into a state. */
export async function fetchRunStats(): Promise<RunStatsState> {
  try {
    const stats = await apiFetch<RunStats>("/api/runs/stats");
    return { status: "ready", stats };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Unknown error";
    return { status: "error", message };
  }
}

/**
 * Poll run stats: once immediately, then every `intervalMs`. Returns a stop
 * function; results resolving after stop are discarded.
 */
export function startRunStatsPolling(
  onState: (state: RunStatsState) => void,
  fetcher: () => Promise<RunStatsState> = fetchRunStats,
  intervalMs: number = RUN_STATS_POLL_INTERVAL_MS,
): () => void {
  let cancelled = false;
  const poll = async () => {
    let state: RunStatsState;
    try {
      state = await fetcher();
    } catch {
      state = { status: "error", message: "Unknown error" };
    }
    if (!cancelled) onState(state);
  };
  void poll();
  const timer = setInterval(() => void poll(), intervalMs);
  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}

export function useRunStats(intervalMs: number = RUN_STATS_POLL_INTERVAL_MS): RunStatsState {
  const [state, setState] = useState<RunStatsState>({ status: "loading" });
  useEffect(() => startRunStatsPolling(setState, fetchRunStats, intervalMs), [intervalMs]);
  return state;
}
