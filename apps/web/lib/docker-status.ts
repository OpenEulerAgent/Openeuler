"use client";

import { useEffect, useState } from "react";
import { fetchSandboxStatus, type SandboxStatus } from "./sandbox-api";

/**
 * Docker availability polling (#106): the dashboard pill next to the daemon
 * health pill. Polls `GET /api/sandbox/status` every 60s (the daemon caches
 * the probe for the same 60s, so each poll is one cheap JSON round-trip).
 */

export type DockerStatusState =
  | { status: "checking" }
  | { status: "ready"; available: boolean; version?: string }
  | { status: "unknown" };

export const DOCKER_STATUS_POLL_INTERVAL_MS = 60_000;

/** Fetch the daemon-side docker status once, collapsing failures to `unknown`. */
export async function fetchDockerStatus(): Promise<DockerStatusState> {
  let payload: SandboxStatus;
  try {
    payload = await fetchSandboxStatus();
  } catch {
    return { status: "unknown" };
  }
  return {
    status: "ready",
    available: payload.available === true,
    ...(payload.version === undefined ? {} : { version: payload.version }),
  };
}

/**
 * Poll docker status: once immediately, then every `intervalMs`. Returns a
 * stop function; results resolving after stop are discarded.
 */
export function startDockerStatusPolling(
  onState: (state: DockerStatusState) => void,
  fetcher: () => Promise<DockerStatusState> = fetchDockerStatus,
  intervalMs: number = DOCKER_STATUS_POLL_INTERVAL_MS,
): () => void {
  let cancelled = false;
  const poll = async () => {
    const state = await fetcher().catch((): DockerStatusState => ({ status: "unknown" }));
    if (!cancelled) onState(state);
  };
  void poll();
  const timer = setInterval(() => void poll(), intervalMs);
  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}

export function useDockerStatus(
  intervalMs: number = DOCKER_STATUS_POLL_INTERVAL_MS,
): DockerStatusState {
  const [state, setState] = useState<DockerStatusState>({ status: "checking" });
  useEffect(() => startDockerStatusPolling(setState, fetchDockerStatus, intervalMs), [intervalMs]);
  return state;
}
