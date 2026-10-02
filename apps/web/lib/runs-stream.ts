"use client";

import { useEffect, useRef } from "react";
import type { RunStatus } from "@openeuler/core";
import { apiFetch, daemonBaseUrl } from "./api";
import { getStoredToken } from "./token";

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

/**
 * Absolute SSE URL for the global run-status stream. `EventSource` cannot
 * set headers, so a stored daemon token (#92) rides along as `?token=` —
 * the daemon accepts query tokens on its GET streaming routes only.
 */
export function runsStreamUrl(
  baseUrl: string = daemonBaseUrl(),
  token: string | null = getStoredToken(),
): string {
  const url = `${baseUrl}/api/runs/stream`;
  return token !== null && token.trim().length > 0
    ? `${url}?token=${encodeURIComponent(token.trim())}`
    : url;
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

// ---------------------------------------------------------------------------
// Shared subscription (#62): the TopBar indicator, the dashboard project
// cards and the runs table all listen to the SAME daemon stream — one
// `EventSource` for the whole page tree instead of three against the
// daemon's global-stream cap.

/** The handler slice every stream consumer supplies. */
export interface RunStatusStreamHandlers {
  onEvent: (event: RunStatusStreamEvent) => void;
  /** Fired on every (re)connect — the moment to re-seed state from the API. */
  onOpen?: () => void;
}

/**
 * Ref-counted fan-out hub over one `EventSource`. The first subscriber
 * opens the connection, the last one out closes it; a subscriber joining
 * an already-open stream gets `onOpen` immediately (it missed the open
 * event and still needs its snapshot seed).
 */
class SharedRunStatusStream {
  private readonly listeners = new Set<RunStatusStreamHandlers>();
  private opened = false;
  private readonly source: StatusStreamSource;

  constructor(
    private readonly factory: StatusStreamSourceFactory,
    private readonly release: (stream: SharedRunStatusStream) => void,
  ) {
    this.source = new factory(runsStreamUrl());
    this.source.addEventListener("open", () => {
      this.opened = true;
      this.forEachListener((listener) => listener.onOpen?.());
    });
    this.source.addEventListener("run.status", (event) => {
      if (typeof event.data !== "string") return;
      const parsed = parseRunStatusStreamEvent(event.data);
      if (parsed === null) return;
      this.forEachListener((listener) => listener.onEvent(parsed));
    });
  }

  /** One throwing consumer must not starve the others (#62). */
  private forEachListener(emit: (listener: RunStatusStreamHandlers) => void): void {
    for (const listener of [...this.listeners]) {
      try {
        emit(listener);
      } catch {
        // Isolated to this consumer; the next frame still reaches everyone.
      }
    }
  }

  subscribe(handlers: RunStatusStreamHandlers): () => void {
    this.listeners.add(handlers);
    if (this.opened) handlers.onOpen?.();
    return () => {
      this.listeners.delete(handlers);
      if (this.listeners.size === 0) {
        this.source.close();
        this.release(this);
      }
    };
  }
}

/** One hub per source factory: the default browser factory is a singleton. */
const sharedStreams = new WeakMap<StatusStreamSourceFactory, SharedRunStatusStream>();

function sharedRunStatusStream(factory: StatusStreamSourceFactory): SharedRunStatusStream {
  let stream = sharedStreams.get(factory);
  if (stream === undefined) {
    stream = new SharedRunStatusStream(factory, (closed) => {
      if (sharedStreams.get(factory) === closed) sharedStreams.delete(factory);
    });
    sharedStreams.set(factory, stream);
  }
  return stream;
}

/**
 * Hook flavor: shares the page-wide stream subscription for the component's
 * lifetime. Latest-ref semantics — the connection outlives re-renders but
 * every frame is dispatched through the CURRENT render's handlers, so
 * handler closures (rows, filters, …) are never frozen at mount time.
 */
export function useRunStatusStream(handlers: RunStatusStreamHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    const unsubscribe = sharedRunStatusStream(BrowserStatusStreamSource).subscribe({
      onEvent: (event) => handlersRef.current.onEvent(event),
      onOpen: () => handlersRef.current.onOpen?.(),
    });
    return unsubscribe;
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
  rows: readonly T[],
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
  // Same reference when nothing changed — callers skip pointless re-renders.
  return changed ? next : (rows as T[]);
}

/** Page size the dashboard requests (`GET /api/runs` is bounded, #62). */
export const RUNS_PAGE_SIZE = 50;

/** Fetches one bounded page of runs (server-side status/project filtering). */
export async function fetchRuns(
  query: {
    projectId?: string;
    statuses?: RunStatus[];
    limit?: number;
    /** `nextCursor` of the previous page — fetches the next older page. */
    before?: string;
  } = {},
): Promise<{ rows: RunsApiRow[]; nextCursor?: string }> {
  const params = new URLSearchParams();
  if (query.projectId !== undefined) params.set("projectId", query.projectId);
  if (query.statuses !== undefined && query.statuses.length > 0) {
    params.set("status", query.statuses.join(","));
  }
  params.set("limit", String(query.limit ?? RUNS_PAGE_SIZE));
  if (query.before !== undefined) params.set("before", query.before);
  const body = await apiFetch<{ runs: RunsApiRow[]; nextCursor?: string }>(
    `/api/runs?${params.toString()}`,
  );
  return {
    rows: body.runs,
    ...(body.nextCursor === undefined ? {} : { nextCursor: body.nextCursor }),
  };
}
