"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchSandboxInstances,
  type SandboxInstance,
  type SandboxInstancesPayload,
} from "./sandbox-api";

/**
 * Sandboxes dashboard polling (#112): fetch `/api/sandbox/instances` once
 * immediately, then every {@link SANDBOX_INSTANCES_POLL_MS} while the page
 * is VISIBLE — a background tab pauses (docker stats snapshots are not
 * cheap), a visibility return refreshes immediately. Cleanup stops the
 * interval, the listener and discards in-flight results.
 */

export const SANDBOX_INSTANCES_POLL_MS = 5_000;

/** Cheap cadence for the sidebar count chip (#112). */
export const SANDBOX_COUNT_POLL_MS = 30_000;

export type SandboxInstancesState =
  | { phase: "loading" }
  | { phase: "ready"; instances: SandboxInstance[]; checkedAt: number }
  | { phase: "error"; message: string };

/** Minimal document surface for tests (visibility handling). */
interface VisibilityDocument {
  visibilityState?: string;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export function startSandboxInstancesPolling(
  onState: (state: SandboxInstancesState) => void,
  options: {
    fetcher?: () => Promise<SandboxInstancesPayload>;
    intervalMs?: number;
    document?: VisibilityDocument;
  } = {},
): () => void {
  const intervalMs = options.intervalMs ?? SANDBOX_INSTANCES_POLL_MS;
  const fetcher = options.fetcher ?? fetchSandboxInstances;
  const doc = options.document;
  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const poll = async (): Promise<void> => {
    try {
      const payload = await fetcher();
      if (!cancelled) onState({ phase: "ready", ...payload });
    } catch (cause: unknown) {
      if (!cancelled) {
        onState({
          phase: "error",
          message: cause instanceof Error ? cause.message : "Failed to load sandboxes",
        });
      }
    }
  };

  const visible = (): boolean =>
    doc === undefined || doc.visibilityState === undefined || doc.visibilityState === "visible";

  const schedule = (): void => {
    if (timer !== null || !visible()) return;
    timer = setInterval(() => {
      if (visible()) void poll();
    }, intervalMs);
  };

  const onVisibility = (): void => {
    if (cancelled) return;
    if (visible()) {
      void poll(); // refresh immediately on return
      schedule();
    } else if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  void poll();
  schedule();
  doc?.addEventListener?.("visibilitychange", onVisibility);

  return () => {
    cancelled = true;
    if (timer !== null) clearInterval(timer);
    doc?.removeEventListener?.("visibilitychange", onVisibility);
  };
}

/** Number of sandboxes currently executing (the dashboard header count). */
export function countRunningSandboxes(instances: readonly SandboxInstance[]): number {
  return instances.reduce((count, instance) => count + (instance.status === "running" ? 1 : 0), 0);
}

/**
 * Live sandbox instances with 5s polling while visible (#112). `refresh`
 * forces an off-cycle snapshot (used after stop/destroy actions so
 * optimistic states settle immediately).
 */
export function useSandboxInstances(
  intervalMs: number = SANDBOX_INSTANCES_POLL_MS,
): SandboxInstancesState & { refresh: () => void } {
  const [state, setState] = useState<SandboxInstancesState>({ phase: "loading" });

  useEffect(() => startSandboxInstancesPolling(setState, { intervalMs }), [intervalMs]);

  const refresh = useCallback(() => {
    void fetchSandboxInstances().then(
      (payload) => setState({ phase: "ready", ...payload }),
      () => {
        // Keep the last good snapshot on manual-refresh failure; the poll
        // loop surfaces persistent errors.
      },
    );
  }, []);

  return { ...state, refresh };
}

/**
 * Sidebar count chip (#112): a cheap 30s poll of the instances payload,
 * collapsed to the running count. `null` while unknown (nothing rendered).
 */
export function useActiveSandboxCount(intervalMs: number = SANDBOX_COUNT_POLL_MS): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(
    () =>
      startSandboxInstancesPolling(
        (state) => {
          if (state.phase === "ready") setCount(countRunningSandboxes(state.instances));
        },
        { intervalMs },
      ),
    [intervalMs],
  );
  return count;
}
