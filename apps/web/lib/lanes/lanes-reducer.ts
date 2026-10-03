"use client";

import type { RunStatus } from "@openeuler/core";
import { TERMINAL_RUN_STATUSES } from "@openeuler/core";
import type { RunStatusStreamEvent, RunsApiRow } from "../runs-stream";

/**
 * Workmux lanes reducer (#113): pure state machine turning the global
 * run-status stream + periodic `GET /api/runs?status=running,queued` seeds
 * into the live lane columns of `/lanes`. Active lanes (queued/running)
 * patch in place; a lane whose run goes terminal lingers
 * {@link LANE_EXIT_FADE_MS} (fade-out) before it leaves the board; a
 * transition for an unknown id adds a minimal placeholder lane immediately
 * (filled by the next seed) so new runs appear the moment they queue.
 */

/** How long a terminal lane card fades before it is pruned (#113). */
export const LANE_EXIT_FADE_MS = 5_000;

/** Debounce window for the seed refetch a placeholder lane schedules. */
export const LANES_REFETCH_DEBOUNCE_MS = 300;

/** A lane column: one run row plus the exit-fade bookkeeping. */
export interface LaneCard extends RunsApiRow {
  /** Set once the run went terminal: the card fades, then is pruned. */
  exiting?: boolean;
  /** Epoch ms the exit grace ends (set together with `exiting`). */
  exitAtMs?: number;
}

export type LanesAction =
  /** Initial/reconnect fetch of active runs merged into the board. */
  | { type: "seeded"; rows: RunsApiRow[]; nowMs?: number }
  /** One global stream transition: patch, exit-fade or placeholder-add. */
  | { type: "streamEvent"; event: RunStatusStreamEvent; nowMs?: number }
  /** A single fetched run row filling a placeholder (or refreshing a lane). */
  | { type: "runFetched"; row: RunsApiRow }
  /** Drops lanes whose exit grace has elapsed. */
  | { type: "pruneExpired"; nowMs: number };

/** Active = non-terminal: exactly queued or running. */
export function isLaneActiveStatus(status: RunStatus): boolean {
  return !(TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/** Lane order: oldest on the left, new runs appended on the right. */
function compareLanes(a: LaneCard, b: LaneCard): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

const sortedLanes = (lanes: readonly LaneCard[]): LaneCard[] => [...lanes].sort(compareLanes);

/** Strips exit bookkeeping off a fresh row. */
function toLane(row: RunsApiRow): LaneCard {
  const lane: LaneCard = { ...row };
  delete lane.exiting;
  delete lane.exitAtMs;
  return lane;
}

/**
 * Seed merge (#113): fetched active rows replace the board's active lanes
 * (filling placeholders with full detail), while terminal lanes still inside
 * their fade window survive — a reconnect re-seed must not yank a card that
 * is mid-fade.
 */
function seedLanes(
  lanes: readonly LaneCard[],
  rows: readonly RunsApiRow[],
  nowMs: number,
): LaneCard[] {
  const byId = new Map<string, LaneCard>();
  for (const row of rows) {
    if (!isLaneActiveStatus(row.status)) continue;
    byId.set(row.id, toLane(row));
  }
  for (const lane of lanes) {
    if (lane.exiting === true && lane.exitAtMs !== undefined && lane.exitAtMs > nowMs) {
      if (!byId.has(lane.id)) byId.set(lane.id, lane);
    }
  }
  return sortedLanes([...byId.values()]);
}

/**
 * Stream → lanes reducer. Pure: same input lanes + action always yield the
 * same output array (and the SAME reference when nothing changed, so
 * re-renders stay cheap).
 */
export function lanesReducer(lanes: readonly LaneCard[], action: LanesAction): LaneCard[] {
  switch (action.type) {
    case "seeded":
      return seedLanes(lanes, action.rows, action.nowMs ?? Date.now());

    case "streamEvent": {
      const { event } = action;
      const nowMs = action.nowMs ?? Date.now();
      const index = lanes.findIndex((lane) => lane.id === event.runId);
      if (isLaneActiveStatus(event.status)) {
        if (index === -1) {
          // Unknown id: a new run just queued/started — placeholder lane now,
          // full detail on the debounced seed refetch.
          const placeholder: LaneCard = {
            id: event.runId,
            projectId: event.projectId,
            status: event.status,
            branch: "",
            iteration: 0,
            createdAt: new Date(nowMs).toISOString(),
            updatedAt: new Date(nowMs).toISOString(),
            ...(event.workflowRevision === undefined
              ? {}
              : { workflowRevision: event.workflowRevision }),
          };
          return sortedLanes([...lanes, placeholder]);
        }
        const existing = lanes[index] as LaneCard;
        if (existing.status === event.status && existing.exiting !== true)
          return lanes as LaneCard[];
        const patched: LaneCard = { ...existing, status: event.status };
        delete patched.exiting;
        delete patched.exitAtMs;
        if (event.status !== "queued") delete patched.queuePosition;
        const next = [...lanes];
        next[index] = patched;
        return next;
      }
      // Terminal: only known lanes transition (a terminal event for an id we
      // never saw means the run finished before we noticed it — history's job).
      if (index === -1) return lanes as LaneCard[];
      const existing = lanes[index] as LaneCard;
      if (existing.exiting === true) {
        if (existing.status === event.status) return lanes as LaneCard[];
        const next = [...lanes];
        next[index] = { ...existing, status: event.status };
        return next;
      }
      const exiting: LaneCard = {
        ...existing,
        status: event.status,
        exiting: true,
        exitAtMs: nowMs + LANE_EXIT_FADE_MS,
      };
      const next = [...lanes];
      next[index] = exiting;
      return next;
    }

    case "runFetched": {
      const { row } = action;
      const index = lanes.findIndex((lane) => lane.id === row.id);
      if (isLaneActiveStatus(row.status)) {
        if (index === -1) return sortedLanes([...lanes, toLane(row)]);
        const next = [...lanes];
        next[index] = toLane(row);
        return next;
      }
      if (index === -1) return lanes as LaneCard[];
      // The fetch raced the stream: run finished between event and refetch.
      const existing = lanes[index] as LaneCard;
      if (existing.exiting === true) return lanes as LaneCard[];
      const nowMs = Date.now();
      const next = [...lanes];
      next[index] = {
        ...toLane(row),
        exiting: true,
        exitAtMs: nowMs + LANE_EXIT_FADE_MS,
      };
      return next;
    }

    case "pruneExpired":
      return lanes.filter((lane) => lane.exitAtMs === undefined || lane.exitAtMs > action.nowMs);
  }
}
