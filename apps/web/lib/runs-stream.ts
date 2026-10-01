"use client";

import { useEffect } from "react";
import type { RunStatus } from "@openeuler/core";
import { apiFetch, daemonBaseUrl } from "./api";

/**
 * Global run-status stream client (#51): `GET /api/runs/stream` pushes one
 * `run.status` frame per daemon-wide transition (queued admission, running
 * start, terminal). Live-only — latest state always comes from the runs
 * table; the stream patches rows/counts without manual refreshes.
 */

export interface RunStatusStreamEvent {
  runId: string;
  status: RunStatus;
  projectId: string;
  workflowRevision?: { id: string; number: number };
}

const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "success",
  "failed",
  "aborted",
  "interrupted",
];

/** Absolute SSE URL for the global run-status stream. */
export function runsStreamUrl(baseUrl: string = daemonBaseUrl()): string {
  return `${baseUrl}/api/runs/stream`;
}

/** Parses one SSE `data` payload; null when malformed. */
export function parseRunStatusStreamEvent(raw: string): RunStatusStreamEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record["runId"] !== "string" || record["runId"].length === 0) return null;
  if (typeof record["projectId"] !== "string" || record["projectId"].length === 0) return null;
  if (
    typeof record["status"] !== "string" ||
    !RUN_STATUSES.includes(record["status"] as RunStatus)
  ) {
    return null;
  }
  const revision = record["workflowRevision"];
  if (
    revision !== undefined &&
    (typeof revision !== "object" ||
      revision === null ||
      typeof (revision as Record<string, unknown>)["id"] !== "string" ||
      typeof (revision as Record<string, unknown>)["number"] !== "number")
  ) {
    return null;
  }
  return {
    runId: record["runId"],
    status: record["status"] as RunStatus,
    projectId: record["projectId"],
    ...(revision === undefined
      ? {}
      : {
          workflowRevision: {
            id: (revision as Record<string, unknown>)["id"] as string,
            number: (revision as Record<string, unknown>)["number"] as number,
          },
        }),
  } satisfies RunStatusStreamEvent;
}

/** Minimal structural slice of `EventSource` the client needs (mockable). */
export interface StatusStreamSource {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export type StatusStreamSourceFactory = new (url: string) => StatusStreamSource;

export class BrowserStatusStreamSource implements StatusStreamSource {
  private readonly source: EventSource;

  constructor(url: string) {
    this.source = new EventSource(url);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.source.addEventListener(type, listener as unknown as EventListener);
  }

  close(): void {
    this.source.close();
  }
}

export interface RunStatusStreamOptions {
  /** Daemon base URL; defaults to `daemonBaseUrl()`. */
  baseUrl?: string;
  /** Injectable for tests; defaults to the native `EventSource`. */
  sourceFactory?: StatusStreamSourceFactory;
  onEvent: (event: RunStatusStreamEvent) => void;
  /** Fired on every (re)connect — the moment to re-seed state from the API. */
  onOpen?: () => void;
}

export interface RunStatusStreamHandle {
  close(): void;
}

/**
 * Subscribes to the global run-status stream. Reconnection is left to the
 * browser (`EventSource` retries on its own); every `open` fires
 * {@link RunStatusStreamOptions.onOpen} so callers can re-fetch a snapshot
 * and heal any drift from the reconnect gap.
 */
export function connectRunStatusStream(options: RunStatusStreamOptions): RunStatusStreamHandle {
  const baseUrl = options.baseUrl ?? daemonBaseUrl();
  const sourceFactory: StatusStreamSourceFactory =
    options.sourceFactory ?? BrowserStatusStreamSource;
  const source = new sourceFactory(runsStreamUrl(baseUrl));

  source.addEventListener("open", () => {
    options.onOpen?.();
  });
  source.addEventListener("run.status", (event) => {
    if (typeof event.data !== "string") return;
    const parsed = parseRunStatusStreamEvent(event.data);
    if (parsed !== null) options.onEvent(parsed);
  });

  return {
    close(): void {
      source.close();
    },
  };
}

/**
 * Hook flavor: runs one subscription for the component's lifetime, re-fires
 * `onOpen` on reconnects. `onEvent`/`onOpen` may change between renders; the
 * stream itself is opened once.
 */
export function useRunStatusStream(handlers: {
  onEvent: (event: RunStatusStreamEvent) => void;
  onOpen?: () => void;
}): void {
  const { onEvent, onOpen } = handlers;
  useEffect(() => {
    const handle = connectRunStatusStream({
      onEvent,
      ...(onOpen === undefined ? {} : { onOpen }),
    });
    return () => handle.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** A run row as returned by `GET /api/runs` (computed fields included). */
export interface RunsApiRow {
  id: string;
  projectId: string;
  workflowId?: string;
  workflowRevisionId?: string;
  status: RunStatus;
  branch: string;
  iteration: number;
  task?: string;
  breadcrumb?: unknown[];
  createdAt: string;
  updatedAt: string;
  queuePosition?: number;
  workflowRevision?: { id: string; number: number };
  project?: { id: string; name: string };
  workflow?: { id: string; name: string };
}

/**
 * Stream → row reducer: patches the matching row's status in place
 * (refreshing derived queue metadata); unknown run ids are left to the
 * caller (usually a refetch). Pure — the same input always yields the same
 * output rows, which is what the reducer tests pin down.
 */
export function applyRunStatusEvent<T extends { id: string; status: RunStatus }>(
  rows: T[],
  event: RunStatusStreamEvent,
): T[] {
  let changed = false;
  const next = rows.map((row) => {
    if (row.id !== event.runId || row.status === event.status) return row;
    changed = true;
    const patched = { ...row, status: event.status } as T & { queuePosition?: number };
    delete patched.queuePosition;
    return patched as T;
  });
  return changed ? next : rows;
}

/** Fetches one page of runs (server-side status/project filtering). */
export async function fetchRuns(
  query: { projectId?: string; statuses?: RunStatus[] } = {},
): Promise<RunsApiRow[]> {
  const params = new URLSearchParams();
  if (query.projectId !== undefined) params.set("projectId", query.projectId);
  if (query.statuses !== undefined && query.statuses.length > 0) {
    params.set("status", query.statuses.join(","));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const body = await apiFetch<{ runs: RunsApiRow[] }>(`/api/runs${suffix}`);
  return body.runs;
}
