import type { RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import type { WorktreeManager } from "@openeuler/engine";
import { RunStatusSchema } from "@openeuler/core";
import type { Executor } from "./executor.js";
import { getVersion } from "./version.js";

/**
 * Prometheus exposition for `GET /metrics` (#94). Hand-rolled text format
 * (version 0.0.4) — no client dependency. Every series is refreshed on
 * scrape from cheap sources: single-row sqlite counts over the `runs` /
 * `events` tables plus in-memory executor/worktree state, so no counters
 * need wiring into the executor's `onRunStatus` funnel — the db rows the
 * funnel already writes ARE the counter state.
 */

/** Content type per the Prometheus text exposition spec (version 0.0.4). */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const RUN_STATUSES = RunStatusSchema.options;

export interface MetricsSources {
  db?: Db;
  executor?: Executor;
  worktrees?: WorktreeManager;
}

export interface MetricsSnapshot {
  /** Rows in the `runs` table per status; every status emits a sample. */
  runsByStatus: Record<RunStatus, number>;
  /** Runs currently held by this daemon's executor (queued or executing). */
  runsActive: number;
  /** Runs admitted but not yet executing (rows sitting in `queued`). */
  queueDepth: number;
  /** Total rows in the per-run agent event log. */
  eventLogRows: number;
  /** Runs with a live git worktree on disk. */
  worktreesActive: number;
  /** Isolated sandboxes currently executing; placeholder 0 until M6. */
  sandboxesActive: number;
  uptimeSeconds: number;
  version: string;
}

/** Label-value escaping per the exposition format: `\`, `"` and newlines. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** `select count(*)` shorthand over the raw sqlite handle. */
function countRows(db: Db, table: "runs" | "events"): number {
  const row = db.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number };
  return row.n;
}

/** Collects every gauge from its cheap source; safe with no db/executor. */
export function collectMetrics(sources: MetricsSources = {}): MetricsSnapshot {
  const runsByStatus = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<
    RunStatus,
    number
  >;
  if (sources.db !== undefined) {
    const rows = sources.db.sqlite
      .prepare("select status, count(*) as n from runs group by status")
      .all() as Array<{ status: string; n: number }>;
    for (const row of rows) {
      if ((RUN_STATUSES as readonly string[]).includes(row.status)) {
        runsByStatus[row.status as RunStatus] = row.n;
      }
    }
  }
  return {
    runsByStatus,
    runsActive: sources.executor?.activeRunIds().length ?? 0,
    queueDepth: runsByStatus["queued"] ?? 0,
    eventLogRows: sources.db === undefined ? 0 : countRows(sources.db, "events"),
    worktreesActive: sources.worktrees?.activeCount() ?? 0,
    sandboxesActive: 0,
    uptimeSeconds: process.uptime(),
    version: getVersion(),
  };
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function sample(name: string, labels: Record<string, string> | undefined, value: number): string {
  const label =
    labels === undefined
      ? ""
      : `{${Object.entries(labels)
          .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
          .join(",")}}`;
  return `${name}${label} ${formatValue(value)}`;
}

function family(name: string, help: string, lines: string[]): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...lines];
}

/** Renders the snapshot in the Prometheus text exposition format 0.0.4. */
export function renderMetrics(snapshot: MetricsSnapshot): string {
  const lines = [
    ...family("openeuler_info", "Daemon build information.", [
      sample("openeuler_info", { version: snapshot.version }, 1),
    ]),
    ...family("openeuler_uptime_seconds", "Seconds the daemon process has been up.", [
      sample("openeuler_uptime_seconds", undefined, snapshot.uptimeSeconds),
    ]),
    ...family(
      "openeuler_runs_total",
      "Total runs by current status (computed from rows; reset with the db).",
      RUN_STATUSES.map((status) =>
        sample("openeuler_runs_total", { status }, snapshot.runsByStatus[status]),
      ),
    ),
    ...family(
      "openeuler_runs_active",
      "Runs currently executing or queued in this daemon's executor.",
      [sample("openeuler_runs_active", undefined, snapshot.runsActive)],
    ),
    ...family("openeuler_queue_depth", "Runs admitted but not yet executing.", [
      sample("openeuler_queue_depth", undefined, snapshot.queueDepth),
    ]),
    ...family("openeuler_event_log_rows", "Rows in the per-run agent event log.", [
      sample("openeuler_event_log_rows", undefined, snapshot.eventLogRows),
    ]),
    ...family("openeuler_worktrees_active", "Runs with a live git worktree on disk.", [
      sample("openeuler_worktrees_active", undefined, snapshot.worktreesActive),
    ]),
    ...family(
      "openeuler_sandboxes_active",
      "Isolated sandboxes currently executing (placeholder until M6).",
      [sample("openeuler_sandboxes_active", undefined, snapshot.sandboxesActive)],
    ),
  ];
  return `${lines.join("\n")}\n`;
}

/** Convenience: collect from sources and render in one step. */
export function scrapeMetrics(sources: MetricsSources = {}): string {
  return renderMetrics(collectMetrics(sources));
}
