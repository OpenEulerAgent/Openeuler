import type { Db } from "@openeuler/db";
import { hostingKeepAliveMinutes } from "@openeuler/core";
import type { Logger } from "./logger.js";
import { recordHostingExpiredActivity } from "./activity.js";
import type { SandboxProvider } from "@openeuler/sandbox";

/**
 * Hosted-run lifecycle (#110): the TTL sweeper that ends hosting.
 *
 * A hosted run (`status: "success"` + `hostedUntil` set — see the
 * executor's dispose path) keeps its sandbox alive so previews stay
 * served. This module owns everything AFTER that point:
 *
 * - **TTL sweep** (1min interval): every run whose `hostedUntil` passed
 *   gets its sandbox destroyed (executor handle first, provider-label
 *   fallback for hosting that outlived a daemon restart), `hostedUntil`
 *   cleared on the row (the run STAYS `success`), and one
 *   `ops.hosting-expired` feed event recorded.
 * - **Boot reattach** (after a daemon restart): a hosted run whose
 *   sandbox container survived gets a fresh window
 *   (`hostedUntil = now + keepAliveMinutes` — the simple restart
 *   semantics; live port mappings degrade until then because the new
 *   process holds no handle); a hosted run whose sandbox died has
 *   hosting cleared.
 *
 * The sandbox GC (#105) separately exempts hosted sandboxes from its
 * terminal-grace pass — destruction of an expired host is owned HERE.
 */

/** Hosting TTL sweep interval. Default 1min (#110). */
export const DEFAULT_HOSTING_SWEEP_INTERVAL_MS = 60_000;

/** One TTL sweep outcome; `expired` counts destroys+clears. */
export interface HostingSweepCounts {
  /** Hosted sandboxes destroyed past their TTL (row cleared, ops event). */
  expired: number;
  /** Runs still inside their window — untouched. */
  kept: number;
}

export interface HostingSweepDeps {
  db: Db;
  /** Provider used for the label-lookup fallback destroy (post-restart). */
  provider: SandboxProvider;
  logger: Logger;
  /** Injectable clock (fake clock in tests); default `Date.now`. */
  now?: () => number;
  /**
   * Executor-owned teardown hook (#110): fully stops a hosted sandbox this
   * daemon holds a handle for (tailer already stopped at host time; the
   * row's `hostedUntil` is cleared inside). Returning false means "not
   * mine" — the sweep then falls back to destroying by provider label.
   */
  stopHosted?: (runId: string) => Promise<boolean>;
}

/** Every run row currently hosted (hostedUntil set), newest first. */
function hostedRuns(db: Db) {
  return db.runs.list().filter((run) => run.hostedUntil !== undefined);
}

/** Destroys every provider sandbox labeled `run=<runId>` (fallback path). */
async function destroyByRunLabel(deps: HostingSweepDeps, runId: string): Promise<void> {
  try {
    const summaries = await deps.provider.list({ run: runId });
    for (const summary of summaries) {
      if (deps.provider.destroy === undefined) {
        deps.logger.warn(
          { runId, sandbox: summary.id },
          "hosting sweep: provider cannot destroy by id — sandbox left in place",
        );
        continue;
      }
      await deps.provider.destroy(summary.id).catch((err: unknown) => {
        deps.logger.warn({ err, runId, sandbox: summary.id }, "hosting sweep: destroy failed");
      });
    }
  } catch (err) {
    deps.logger.warn({ err, runId }, "hosting sweep: provider list failed");
  }
}

/**
 * One hosting TTL sweep (#110). Never throws: provider failures degrade
 * to a retry next tick (the row keeps its `hostedUntil` only when the
 * destroy was owned by the executor hook; the fallback path clears it
 * after best-effort destroys — a leaked container is still collected by
 * the sandbox GC's terminal grace once hosting is off the row).
 */
export async function runHostingSweep(deps: HostingSweepDeps): Promise<HostingSweepCounts> {
  const now = deps.now ?? Date.now;
  const counts: HostingSweepCounts = { expired: 0, kept: 0 };
  for (const run of hostedRuns(deps.db)) {
    const until = Date.parse(run.hostedUntil ?? "");
    if (Number.isFinite(until) && now() < until) {
      counts.kept += 1;
      continue;
    }
    const expiredAt = run.hostedUntil ?? new Date(now()).toISOString();
    const stopped = deps.stopHosted ? await deps.stopHosted(run.id) : false;
    if (!stopped) {
      await destroyByRunLabel(deps, run.id);
      // Not hosted anymore even if a destroy hiccupped (GC backstops).
      if (deps.db.runs.get(run.id)?.hostedUntil !== undefined) {
        deps.db.runs.update(run.id, { hostedUntil: null });
      }
    }
    recordHostingExpiredActivity(deps.db, { runId: run.id, until: expiredAt });
    counts.expired += 1;
    deps.logger.info(
      { runId: run.id, until: expiredAt },
      "hosted run expired — sandbox destroyed, run stays success",
    );
  }
  return counts;
}

export interface HostingReattachDeps {
  db: Db;
  /** Provider whose live sandboxes are probed by run label. */
  provider: SandboxProvider;
  logger: Logger;
  /** Injectable clock (tests); default `Date.now`. */
  now?: () => number;
}

/** Outcome of the boot reattach sweep. */
export interface HostingReattachCounts {
  /** Hosted runs whose sandbox survived: TTL re-armed from now. */
  reattached: number;
  /** Hosted runs whose sandbox is gone: hosting cleared. */
  cleared: number;
}

/**
 * Boot-time reattach of hosting after a daemon restart (#110): a hosted
 * run whose sandbox container is still alive keeps hosting with a FRESH
 * window (`now + keepAliveMinutes`); one whose sandbox died has
 * `hostedUntil` cleared (the run stays `success`). Live port mappings
 * degrade until expiry — the new daemon holds no sandbox handle — but the
 * TTL (and Stop hosting, which destroys by label) keeps working.
 */
export async function reattachHostedRuns(deps: HostingReattachDeps): Promise<HostingReattachCounts> {
  const now = deps.now ?? Date.now;
  const counts: HostingReattachCounts = { reattached: 0, cleared: 0 };
  for (const run of hostedRuns(deps.db)) {
    let alive = false;
    try {
      alive = (await deps.provider.list({ run: run.id })).length > 0;
    } catch (err) {
      deps.logger.warn({ err, runId: run.id }, "hosting reattach: provider list failed");
    }
    if (alive) {
      const until = new Date(now() + hostingKeepAliveMinutes(run.hosting) * 60_000).toISOString();
      deps.db.runs.update(run.id, { hostedUntil: until });
      counts.reattached += 1;
      deps.logger.info(
        { runId: run.id, until },
        "hosted run reattached after daemon restart (fresh TTL window)",
      );
    } else {
      deps.db.runs.update(run.id, { hostedUntil: null });
      counts.cleared += 1;
      deps.logger.info({ runId: run.id }, "hosted run's sandbox is gone after restart — hosting cleared");
    }
  }
  return counts;
}

export interface HostingSweeperOptions extends HostingSweepDeps {
  /** TTL sweep interval. Default {@link DEFAULT_HOSTING_SWEEP_INTERVAL_MS}. */
  intervalMs?: number;
}

export interface HostingSweeper {
  /** One immediate sweep (tests + manual triggers). */
  runNow(): Promise<void>;
  /** Clears the interval timer; idempotent, registered on shutdown. */
  stop(): void;
}

/**
 * Starts the periodic hosting TTL sweeper (#110): every `intervalMs`
 * (default 1min, timer unref'd) one {@link runHostingSweep} pass.
 * Overlapping ticks are skipped (a slow provider must not pile up passes).
 */
export function startHostingSweeper(options: HostingSweeperOptions): HostingSweeper {
  const intervalMs = options.intervalMs ?? DEFAULT_HOSTING_SWEEP_INTERVAL_MS;
  let running = true;
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (!running || inFlight) return;
    inFlight = true;
    try {
      await runHostingSweep(options);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  return {
    runNow: () => tick(),
    stop: () => {
      if (!running) return;
      running = false;
      clearInterval(timer);
    },
  };
}
