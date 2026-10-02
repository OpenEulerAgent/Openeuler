"use client";

/**
 * 401 gate hub (#92): `apiFetch` reports every daemon 401 here; the app
 * shell's `TokenGate` card subscribes, collects the token, and retries the
 * failed action. Keeps api.ts free of React while the gate stays reactive.
 */

export type UnauthorizedListener = () => void;

const listeners = new Set<UnauthorizedListener>();

/** A deferred replay of the request that 401'd (path + init captured). */
let pendingRetry: (() => Promise<unknown>) | null = null;

/** Subscribe to unauthorized (401) notifications; returns an unsubscribe fn. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notifies every listener; one throwing listener must not starve the rest. */
export function notifyUnauthorized(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Isolated to this consumer.
    }
  }
}

/** Registers the retry for the latest 401'd request (overwrites any older one). */
export function setPendingRetry(retry: () => Promise<unknown>): void {
  pendingRetry = retry;
}

/** Takes (and clears) the pending retry; null when nothing is waiting. */
export function takePendingRetry(): (() => Promise<unknown>) | null {
  const retry = pendingRetry;
  pendingRetry = null;
  return retry;
}

/** Test helper: drop any pending retry without running it. */
export function __clearPendingRetry(): void {
  pendingRetry = null;
}
