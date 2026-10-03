"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { RunsApiRow } from "../runs-stream";
import type { LaneStepRun } from "./filmstrip";

/**
 * Lazy run-detail loader for the lanes filmstrip (#113): each visible
 * history row fetches `GET /api/runs/:id` exactly ONCE — concurrent callers
 * share the in-flight promise, settled results cache until the lanes view
 * unmounts (`dispose`), and failures clear their gate so a later mount can
 * retry. The cache lives for the whole `/lanes` visit so flipping
 * Live ⇄ History never refetches a row the viewer already saw.
 */

/** `GET /api/runs/:id` payload as the filmstrip consumes it. */
export interface RunDetailPayload {
  run: RunsApiRow;
  steps: LaneStepRun[];
  summary: { eventCount: number };
}

/** Injectable transport (tests pass a recorder). */
export type RunDetailFetcher = (runId: string) => Promise<RunDetailPayload>;

export const fetchRunDetail: RunDetailFetcher = async (runId) =>
  apiFetch<RunDetailPayload>(`/api/runs/${encodeURIComponent(runId)}`);

interface CacheEntry {
  promise: Promise<RunDetailPayload>;
  /** Set once the fetch settled successfully (peek is synchronous). */
  detail?: RunDetailPayload;
}

export class RunDetailCache {
  private readonly entries = new Map<string, CacheEntry>();
  private disposed = false;

  constructor(private readonly fetcher: RunDetailFetcher = fetchRunDetail) {}

  /**
   * Loads one run's detail: cached hit, shared in-flight promise, or a new
   * fetch. A rejected fetch removes its entry so the next `load` retries.
   */
  load(runId: string): Promise<RunDetailPayload> {
    const hit = this.entries.get(runId);
    if (hit !== undefined) return hit.promise;
    const entry: CacheEntry = {
      promise: this.fetcher(runId).then(
        (detail) => {
          if (!this.disposed) entry.detail = detail;
          return detail;
        },
        (cause: unknown) => {
          this.entries.delete(runId);
          throw cause;
        },
      ),
    };
    this.entries.set(runId, entry);
    return entry.promise;
  }

  /** Synchronously settled detail for a run, when already fetched. */
  peek(runId: string): RunDetailPayload | undefined {
    return this.entries.get(runId)?.detail;
  }

  /** Number of runs held (in-flight or settled). */
  get size(): number {
    return this.entries.size;
  }

  /** Unmount cleanup: drops every cached row (a fresh visit refetches). */
  dispose(): void {
    this.disposed = true;
    this.entries.clear();
  }
}

export type UseRunDetailResult =
  { phase: "loading" } | { phase: "ready"; detail: RunDetailPayload } | { phase: "error" };

/**
 * Row-level hook over a shared {@link RunDetailCache}: starts one lazy load
 * on mount, ignores late settles after unmount/run switch, and surfaces
 * loading/ready/error for the row skeleton.
 */
export function useRunDetail(runId: string, cache: RunDetailCache): UseRunDetailResult {
  const [state, setState] = useState<UseRunDetailResult>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    cache.load(runId).then(
      (detail) => {
        if (!cancelled) setState({ phase: "ready", detail });
      },
      () => {
        if (!cancelled) setState({ phase: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runId, cache]);

  return state;
}
