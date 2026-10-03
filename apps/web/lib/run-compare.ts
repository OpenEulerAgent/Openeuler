import type { Run, RunStatus, StepRun } from "@openeuler/core";
import { parsePatch } from "./diff-parse";
import type { PreviewPortView } from "./preview";
import { isLiveStatus, runDuration } from "./time";

/**
 * Pure assembly for the run-compare page (#114): `?a=&b=` URL codec,
 * node-by-node alignment of two runs' StepRuns (union keyed by
 * stepId/node + iteration), the header stat-card model, event-count
 * sparkbar fractions and the files-changed-only-in-A/B extraction off the
 * existing diff parser. Framework-free; the RunCompareView component is a
 * thin shell over these.
 */

/** A StepRun as served by `GET /api/runs/:id` — `name` + `durationMs` enrichment (#113). */
export type CompareStepRun = StepRun & {
  name?: string;
  durationMs?: number;
};

/** The run-detail payload shape the compare page consumes (subset of the daemon body). */
export interface CompareRunDetail {
  run: Run & {
    queuePosition?: number;
    workflowRevision?: { id: string; number: number };
    project?: { id: string; name: string };
    workflow?: { id: string; name: string };
  };
  steps: CompareStepRun[];
  summary: { eventCount: number };
  /** Live sandbox snapshot (#102); present only while the run executes sandboxed. */
  sandbox?: { id: string; image: string; status: string };
  ports?: PreviewPortView[];
}

// ---------------------------------------------------------------------------
// URL codec: /runs/compare?a=<id>&b=<id>
//

export interface CompareQuery {
  a: string | null;
  b: string | null;
}

/** Parses `?a=&b=` off a query string (or full href); empty/missing values become null. */
export function parseCompareQuery(search: string | URLSearchParams): CompareQuery {
  const query = typeof search === "string" ? (search.slice(search.indexOf("?") + 1) ?? "") : search;
  const params = typeof query === "string" ? new URLSearchParams(query) : query;
  const clean = (value: string | null): string | null =>
    value !== null && value.length > 0 ? value : null;
  return { a: clean(params.get("a")), b: clean(params.get("b")) };
}

/** Canonical compare href for two run ids (selection order = A then B). */
export function compareHref(a: string, b: string): string {
  return `/runs/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
}

// ---------------------------------------------------------------------------
// Node-by-node alignment: union of both runs' step runs.
//

/** One aligned execution row: a (stepId, iteration) slot with either side's StepRun. */
export interface CompareStepRow {
  /** Stable row key: `<stepId>#<iteration>`. */
  key: string;
  stepId: string;
  /** 1-based loop pass / per-node execution number. */
  iteration: number;
  /** Display label: the node/step name when either side carries one, else the id. */
  label: string;
  a: CompareStepRun | null;
  b: CompareStepRun | null;
}

const rowKey = (stepId: string, iteration: number): string => `${stepId}#${iteration}`;

/**
 * Aligns two runs' step runs into union rows keyed by (stepId + iteration).
 * Rows sort by iteration, then by first appearance — A's execution order
 * first, B-only nodes appended after A's (mirrors how the runs actually
 * traversed the graph, so retries with re-ordered nodes still read sanely).
 */
export function alignRunSteps(
  stepsA: readonly CompareStepRun[],
  stepsB: readonly CompareStepRun[],
): CompareStepRow[] {
  const byKeyA = new Map<string, CompareStepRun>();
  stepsA.forEach((step) => byKeyA.set(rowKey(step.stepId, step.iteration), step));
  const byKeyB = new Map<string, CompareStepRun>();
  stepsB.forEach((step) => byKeyB.set(rowKey(step.stepId, step.iteration), step));

  // Combined within-iteration order: index in A, else A's length + index in B.
  const orderA = new Map<string, number>();
  stepsA.forEach((step, index) => {
    const key = rowKey(step.stepId, step.iteration);
    if (!orderA.has(key)) orderA.set(key, index);
  });
  const orderB = new Map<string, number>();
  stepsB.forEach((step, index) => {
    const key = rowKey(step.stepId, step.iteration);
    if (!orderB.has(key)) orderB.set(key, index);
  });
  const offset = stepsA.length;
  const position = (key: string): number =>
    orderA.get(key) ?? offset + (orderB.get(key) ?? Number.MAX_SAFE_INTEGER);

  // stepId → node name, A's first sighting winning (later loop iterations of
  // the same node often carry no name of their own).
  const names = new Map<string, string>();
  for (const step of [...stepsA, ...stepsB]) {
    if (step.name !== undefined && !names.has(step.stepId)) names.set(step.stepId, step.name);
  }

  const keys = new Set<string>([...orderA.keys(), ...orderB.keys()]);
  return [...keys]
    .map((key) => {
      const a = byKeyA.get(key) ?? null;
      const b = byKeyB.get(key) ?? null;
      const side = a ?? b;
      const stepId = (side as CompareStepRun).stepId;
      const iteration = (side as CompareStepRun).iteration;
      return {
        key,
        stepId,
        iteration,
        label: a?.name ?? b?.name ?? names.get(stepId) ?? stepId,
        a,
        b,
      };
    })
    .sort((left, right) =>
      left.iteration !== right.iteration
        ? left.iteration - right.iteration
        : position(left.key) - position(right.key) || left.stepId.localeCompare(right.stepId),
    );
}

// ---------------------------------------------------------------------------
// Header stat cards.
//

/** One side's header stats (the card model — primitives only, formatting lives in the view). */
export interface RunCompareStats {
  runId: string;
  branch: string;
  status: RunStatus;
  /** True while queued/running — the duration card keeps ticking client-side. */
  live: boolean;
  /** Wall-clock span: createdAt → updatedAt (terminal) or → `now` (live). */
  durationMs: number;
  /** Completed step runs (node executions for graph runs). */
  executions: number;
  /** Highest 1-based iteration any step reached (0 when the run ran nothing). */
  iterations: number;
  /** Declared container ports (#107), in declared order. */
  ports: number[];
  /** Pinned graph revision number; null for ad-hoc / pre-graph runs. */
  workflowRevision: number | null;
  /** True while the run detail carries a live sandbox snapshot (#102). */
  sandboxed: boolean;
  sandboxImage: string | null;
  eventCount: number;
}

/** Assembles one side's stat-card data from its run detail. */
export function runCompareStats(
  detail: CompareRunDetail,
  now: number = Date.now(),
): RunCompareStats {
  const { run, steps, summary } = detail;
  const iterations = steps.reduce((max, step) => Math.max(max, step.iteration), 0);
  return {
    runId: run.id,
    branch: run.branch,
    status: run.status,
    live: isLiveStatus(run.status),
    durationMs: runDuration(run, now),
    executions: steps.length,
    iterations,
    ports: run.ports ?? [],
    workflowRevision: run.workflowRevision?.number ?? null,
    sandboxed: detail.sandbox !== undefined,
    sandboxImage: detail.sandbox?.image ?? null,
    eventCount: summary.eventCount,
  };
}

// ---------------------------------------------------------------------------
// Event-count sparkbars.
//

/** Event counts → bar fractions (0..1 of the shared max, so A/B visually compare). */
export interface EventSpark {
  a: number;
  b: number;
  max: number;
  aFraction: number;
  bFraction: number;
}

export function eventSpark(countA: number, countB: number): EventSpark {
  const a = Math.max(0, countA);
  const b = Math.max(0, countB);
  const max = Math.max(a, b);
  return {
    a,
    b,
    max,
    aFraction: max === 0 ? 0 : a / max,
    bFraction: max === 0 ? 0 : b / max,
  };
}

// ---------------------------------------------------------------------------
// Files changed only in A / only in B (hunk-level, via the existing diff parser).
//

export interface CompareFileSets {
  onlyInA: string[];
  onlyInB: string[];
  inBoth: string[];
}

/**
 * Path-set diff of two cumulative patches: which changed files appear only
 * in A's patch, only in B's, and in both. Paths follow the parser's display
 * path (post-image, or the old path for deletions) in patch order.
 */
export function filesOnlyIn(patchA: string, patchB: string): CompareFileSets {
  const pathsA = parsePatch(patchA).map((entry) => entry.path);
  const pathsB = parsePatch(patchB).map((entry) => entry.path);
  const setA = new Set(pathsA);
  const setB = new Set(pathsB);
  return {
    onlyInA: pathsA.filter((path) => !setB.has(path)),
    onlyInB: pathsB.filter((path) => !setA.has(path)),
    inBoth: pathsA.filter((path) => setB.has(path)),
  };
}

// ---------------------------------------------------------------------------
// Output clipping for the aligned table's 2-line cells.
//

/** First `maxLines` lines of a step output, plus whether anything was cut. */
export function clipToLines(text: string, maxLines: number): { text: string; clipped: boolean } {
  if (maxLines < 1) return { text: "", clipped: text.trim().length > 0 };
  const lines = text.split("\n");
  return {
    text: lines.slice(0, maxLines).join("\n"),
    clipped: lines.length > maxLines,
  };
}
