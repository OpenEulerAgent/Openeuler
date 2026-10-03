"use client";

import type { RunStatus, StepRun } from "@openeuler/core";
import { formatDuration, runDuration } from "../time";

/**
 * History filmstrip layout math (#113): the last terminal runs render as
 * horizontal swimlanes — per run a row of node-execution blocks whose widths
 * are proportional to their driver duration (clamped to a minimum so short
 * nodes stay visible, then renormalized so the row always sums to 100%),
 * over a run-level start→end ruler. Pure functions over
 * `GET /api/runs/:id` step payloads; the component only maps the results to
 * pixels.
 */

/**
 * A StepRun as served by `GET /api/runs/:id` (#113): the core row plus the
 * daemon's display enrichment — node/step name, and the driver duration for
 * graph nodes (`node.completed` carries it; linear steps have none).
 */
export interface LaneStepRun extends StepRun {
  name?: string;
  durationMs?: number;
}

/** One rendered block of a swimlane. */
export interface FilmstripBlock {
  stepRunId: string;
  /** Node/step display name (falls back to the raw step id). */
  name: string;
  /** 1-based execution iteration of the node. */
  iteration: number;
  status: RunStatus;
  /** Driver duration in ms; null when the log could not provide one. */
  durationMs: number | null;
  /** Share of the row width, in percent (clamped + renormalized; sums to 100). */
  widthPct: number;
}

/** Minimum share of the row a block keeps, however short it ran. */
export const FILMSTRIP_MIN_BLOCK_PCT = 4;

/** Semantic tone of a block (mapped to a color class by the component). */
export type FilmstripTone = "success" | "failed" | "warning" | "info";

export function blockTone(status: RunStatus): FilmstripTone {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (status === "aborted" || status === "interrupted") return "warning";
  return "info";
}

/** Tooltip title of one block: `Worker A · iter 2 · 3s`. */
export function filmstripBlockTitle(block: FilmstripBlock): string {
  const duration =
    block.durationMs === null ? "unknown duration" : formatDuration(block.durationMs);
  return `${block.name} · iter ${block.iteration} · ${duration}`;
}

const roundPct = (value: number): number => Math.round(value * 100) / 100;

/**
 * Lays out one run's steps as proportional blocks:
 *
 * - known `durationMs` are used as-is; unknown ones take the mean of the
 *   known durations (or an equal share when nothing is known);
 * - each share is clamped to at least `minWidthPct`, then the row is
 *   renormalized to exactly 100% (clamping a share up must shrink the rest);
 * - order follows the input steps.
 */
export function filmstripBlocks(
  steps: readonly LaneStepRun[],
  options: { minWidthPct?: number } = {},
): FilmstripBlock[] {
  if (steps.length === 0) return [];
  const minWidthPct = options.minWidthPct ?? FILMSTRIP_MIN_BLOCK_PCT;

  const durations = steps.map((step) =>
    typeof step.durationMs === "number" && step.durationMs >= 0 ? step.durationMs : null,
  );
  const known = durations.filter((value): value is number => value !== null);
  const fallback = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const effective = durations.map((value) => value ?? fallback);
  const total = effective.reduce((a, b) => a + b, 0);

  const shares = effective.map((value) => Math.max(value / total, minWidthPct / 100));
  const shareTotal = shares.reduce((a, b) => a + b, 0);

  return steps.map((step, index) => ({
    stepRunId: step.id,
    name: step.name ?? step.stepId,
    iteration: step.iteration,
    status: step.status,
    durationMs: durations[index] ?? null,
    widthPct: roundPct(((shares[index] as number) / shareTotal) * 100),
  }));
}

/** One tick of the run-level start→end ruler. */
export interface FilmstripTick {
  /** Position along the row, in percent. */
  pct: number;
  /** Wall-clock label at that position (`0ms`, `1m 30s`, …). */
  label: string;
}

/** Ruler over the run's full span: createdAt → updatedAt (terminal rows). */
export interface FilmstripRuler {
  totalMs: number;
  ticks: FilmstripTick[];
}

/**
 * The run-level ruler (#113): total wall-clock span plus tick marks at the
 * given fractions (default start / middle / end).
 */
export function filmstripRuler(
  run: { createdAt: string; updatedAt: string; status: string },
  options: { fractions?: readonly number[]; nowMs?: number } = {},
): FilmstripRuler {
  const fractions = options.fractions ?? [0, 0.5, 1];
  const totalMs = Math.max(0, runDuration(run, options.nowMs));
  return {
    totalMs,
    ticks: fractions.map((fraction) => ({
      pct: roundPct(fraction * 100),
      label: formatDuration(Math.round(totalMs * fraction)),
    })),
  };
}
