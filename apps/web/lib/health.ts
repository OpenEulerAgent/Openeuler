"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "./api";

export interface HealthPayload {
  ok: boolean;
  version: string;
  /** Absent when the daemon runs with auth enabled (minimal `/health`, #92). */
  uptime?: number;
}

export type HealthState =
  | { status: "checking" }
  | { status: "healthy"; version: string; uptime?: number }
  | { status: "degraded"; message: string };

export const HEALTH_POLL_INTERVAL_MS = 5000;

/** Fetch `/health` once, collapsing every failure mode into a `HealthState`. */
export async function fetchHealth(): Promise<HealthState> {
  try {
    const payload = await apiFetch<HealthPayload>("/health");
    return payload.ok
      ? {
          status: "healthy",
          version: payload.version,
          ...(payload.uptime === undefined ? {} : { uptime: payload.uptime }),
        }
      : { status: "degraded", message: "Daemon reported an unhealthy state" };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Unknown error";
    return { status: "degraded", message };
  }
}

/**
 * Poll health: once immediately, then every `intervalMs`. Returns a stop
 * function; results resolving after stop are discarded.
 */
export function startHealthPolling(
  onState: (state: HealthState) => void,
  fetcher: () => Promise<HealthState> = fetchHealth,
  intervalMs: number = HEALTH_POLL_INTERVAL_MS,
): () => void {
  let cancelled = false;
  const poll = async () => {
    let state: HealthState;
    try {
      state = await fetcher();
    } catch {
      state = { status: "degraded", message: "Unknown error" };
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

export function useHealth(intervalMs: number = HEALTH_POLL_INTERVAL_MS): HealthState {
  const [state, setState] = useState<HealthState>({ status: "checking" });
  useEffect(() => startHealthPolling(setState, fetchHealth, intervalMs), [intervalMs]);
  return state;
}

export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}
