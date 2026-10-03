import { statfs } from "node:fs/promises";
import type { Db } from "@openeuler/db";
import type { Run } from "@openeuler/core";
import { TERMINAL_RUN_STATUSES } from "@openeuler/core";
import { SandboxError, docker, parseDockerSizeToBytes } from "@openeuler/sandbox";
import type { DockerCliRunner, SandboxProvider, SandboxSummary } from "@openeuler/sandbox";
import { recordGcActivity } from "./activity.js";
import type { Logger } from "./logger.js";

/**
 * Sandbox garbage collection (#105): nothing leaks. Every pass reconciles
 * the provider's live sandboxes (`provider.list()` — the docker provider
 * already scopes to its `openeuler.sandbox=1` label) with the run rows:
 *
 * - run active (in this executor, or row `queued`/`running`) → keep;
 * - run terminal → destroy once the terminal age crosses the grace
 *   (1h default; `policy.keepForDebug` sandboxes get 4h — the feed's
 *   `ops.sandbox-kept` entry extends the grace too);
 * - no `run` label or unknown run id → orphan → destroy;
 *
 * plus orphan cache-volume pruning: named volumes `openeuler-cache-*`
 * (engine `cacheVolumeName`, #102) whose project no longer exists are
 * removed — they are NEVER touched by normal run teardown, so without this
 * they accumulate forever (#148 QA). Every pass appends one `ops.gc` feed
 * event with the counts (boot sweeps always; periodic passes only when
 * something was collected). Project deletion removes its cache volumes
 * eagerly via {@link removeProjectCacheVolumes}.
 */

/** Grace after run-terminal before a sandbox is destroyed. Default 1h. */
export const DEFAULT_GC_GRACE_MS = 60 * 60 * 1000;

/** Grace for `keepForDebug` sandboxes after run-terminal. Default 4h. */
export const DEFAULT_DEBUG_GRACE_MS = 4 * 60 * 60 * 1000;

/** Periodic GC interval. Default 10min. */
export const DEFAULT_GC_INTERVAL_MS = 10 * 60 * 1000;

/** Docker data usage percentage considered disk pressure (warning only). */
export const DEFAULT_DISK_PRESSURE_THRESHOLD_PCT = 85;

/** Prefix of every named cache volume the engine's run sandboxes mount (#102). */
export const CACHE_VOLUME_PREFIX = "openeuler-cache-";

/** `openeuler-cache-<projectId>-…` prefix of one project's cache volumes. */
export function cacheVolumePrefixFor(projectId: string): string {
  return `${CACHE_VOLUME_PREFIX}${projectId}-`;
}

/** One GC pass outcome; `destroyed`/`orphans`/`cacheVolumesPruned` count successes. */
export interface SandboxGcCounts {
  /** Terminal sandboxes destroyed (age beyond grace). */
  destroyed: number;
  /** Sandboxes left alive (active runs, within grace, or failed destroys). */
  kept: number;
  /** Orphan sandboxes destroyed (no/unknown run). */
  orphans: number;
  /** Orphan cache volumes pruned. */
  cacheVolumesPruned: number;
}

export interface SandboxGcDeps {
  db: Db;
  /** Provider whose sandboxes are reconciled; `list()` + optional `destroy()`. */
  provider: SandboxProvider;
  logger: Logger;
  /** Injectable clock (fake clock in tests); default `Date.now`. */
  now?: () => number;
  /** Grace after run-terminal. Default {@link DEFAULT_GC_GRACE_MS}. */
  graceMs?: number;
  /** Grace for keepForDebug sandboxes. Default {@link DEFAULT_DEBUG_GRACE_MS}. */
  debugGraceMs?: number;
  /**
   * Docker CLI runner for cache-volume operations. Default: the real `docker`
   * CLI (same one the docker provider uses).
   */
  runner?: DockerCliRunner;
  /** Executor's live run ids — their sandboxes are never touched. */
  activeRunIds?: () => readonly string[];
}

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const stderrTail = (stderr: string, max = 400): string => {
  const text = stderr.trim();
  return text.length <= max ? text : `…${text.slice(-max)}`;
};

function runDocker(
  args: readonly string[],
  runner: DockerCliRunner | undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return docker(args, {
    timeoutMs: 30_000,
    ...(runner === undefined ? {} : { runner }),
  });
}

/** True when the run's sandbox was kept for debugging (policy or feed entry). */
function isKeepForDebug(db: Db, run: Run): boolean {
  const policy = db.projects.get(run.projectId)?.sandboxPolicy;
  return (
    policy?.keepForDebug === true || db.activity.latestForRun(run.id)?.type === "ops.sandbox-kept"
  );
}

/** Epoch-ms the run turned terminal (row `updatedAt`), sandbox createdAt fallback. */
function terminalAgeMs(run: Run, summary: SandboxSummary, now: number): number {
  const terminalAt = Date.parse(run.updatedAt);
  const base = Number.isFinite(terminalAt) ? terminalAt : summary.createdAt;
  return now - base;
}

async function destroyById(deps: SandboxGcDeps, id: string): Promise<boolean> {
  if (deps.provider.destroy === undefined) {
    deps.logger.warn(
      { sandbox: id },
      "sandbox GC: provider cannot destroy by id — sandbox left in place",
    );
    return false;
  }
  try {
    await deps.provider.destroy(id);
    return true;
  } catch (err) {
    deps.logger.warn({ err, sandbox: id }, "sandbox GC: destroy failed (retrying next pass)");
    return false;
  }
}

/**
 * Lists docker volume names (`docker volume ls --format {{.Name}}`).
 * Rejects with a typed `SandboxError` on CLI/daemon failure.
 */
async function listVolumeNames(runner: DockerCliRunner | undefined): Promise<string[]> {
  const result = await runDocker(["volume", "ls", "--format", "{{.Name}}"], runner);
  if (result.code !== 0) {
    throw new SandboxError(
      "SANDBOX_EXEC_FAILED",
      `docker volume ls failed: ${stderrTail(result.stderr)}`,
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Removes one docker volume. Resolves false when it is already gone (or in
 * use — removed next pass); true when this call removed it. Never throws for
 * a missing volume; other failures reject with a typed `SandboxError`.
 */
async function removeVolume(name: string, runner: DockerCliRunner | undefined): Promise<boolean> {
  const result = await runDocker(["volume", "rm", name], runner);
  if (result.code === 0) return true;
  if (/no such volume|volume is in use|volume is being used/i.test(result.stderr)) return false;
  throw new SandboxError(
    "SANDBOX_EXEC_FAILED",
    `docker volume rm of "${name}" failed: ${stderrTail(result.stderr)}`,
  );
}

export interface CacheVolumeDeps {
  db: Db;
  logger: Logger;
  /** Docker CLI runner; default the real `docker` CLI. */
  runner?: DockerCliRunner;
}

/**
 * Removes every cache volume of one project (`openeuler-cache-<projectId>-*`,
 * #148 QA): the eager half of cache-volume hygiene, called on project
 * delete. Best-effort per volume (missing/in-use volumes resolve false);
 * a failed `volume ls` logs and resolves 0 — docker being down must not
 * break the caller.
 */
export async function removeProjectCacheVolumes(
  projectId: string,
  deps: CacheVolumeDeps,
): Promise<number> {
  let names: string[];
  try {
    names = await listVolumeNames(deps.runner);
  } catch (err) {
    deps.logger.warn(
      { err, projectId },
      "cache volume cleanup: docker volume ls failed (best-effort, skipped)",
    );
    return 0;
  }
  const prefix = cacheVolumePrefixFor(projectId);
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      if (await removeVolume(name, deps.runner)) removed += 1;
    } catch (err) {
      deps.logger.warn(
        { err, volume: name, projectId },
        "cache volume cleanup: removal failed (best-effort)",
      );
    }
  }
  return removed;
}

/**
 * Prunes cache volumes whose project no longer exists in the db (the
 * periodic half of cache-volume hygiene): a project deleted while docker
 * was down — or a volume left by a wiped db — would otherwise persist
 * forever. Volumes of live projects are never touched. Returns how many
 * were pruned; failures are logged, never thrown.
 */
export async function pruneOrphanCacheVolumes(deps: CacheVolumeDeps): Promise<number> {
  let names: string[];
  try {
    names = await listVolumeNames(deps.runner);
  } catch (err) {
    deps.logger.warn({ err }, "cache volume prune: docker volume ls failed (pass skipped)");
    return 0;
  }
  const prefixes = deps.db.projects.list().map((project) => cacheVolumePrefixFor(project.id));
  let pruned = 0;
  for (const name of names) {
    if (!name.startsWith(CACHE_VOLUME_PREFIX)) continue;
    if (prefixes.some((prefix) => name.startsWith(prefix))) continue;
    try {
      if (await removeVolume(name, deps.runner)) pruned += 1;
    } catch (err) {
      deps.logger.warn(
        { err, volume: name },
        "cache volume prune: removal failed (retrying next pass)",
      );
    }
  }
  return pruned;
}

/** One `docker system df` row (only the fields we read). */
interface DockerSystemDfRow {
  Type?: string;
  Size?: string;
  Reclaimable?: string;
}

/** `docker system df` snapshot backing the disk-pressure check. */
export interface DiskPressureSnapshot {
  /** Sum of image+container+volume sizes (`docker system df`, shared layers may double-count). */
  dockerDataBytes: number;
  /** Reclaimable portion of `dockerDataBytes`. */
  reclaimableBytes: number;
  /** Capacity of the filesystem backing the docker root dir. */
  fsTotalBytes: number;
  /** `dockerDataBytes / fsTotalBytes * 100`. */
  usedPct: number;
}

export interface DiskPressureDeps {
  logger?: Logger;
  /** Docker CLI runner; default the real `docker` CLI. */
  runner?: DockerCliRunner;
  /** Injectable filesystem capacity probe (tests); default `statfs`. */
  fsTotalBytes?: (path: string) => Promise<number | undefined>;
}

/** `"72.55GB (65%)"` → bytes of the leading size (0 when unparseable). */
function reclaimableToBytes(raw: string | undefined): number {
  if (typeof raw !== "string") return 0;
  const size = raw.split(" (")[0]?.trim() ?? "";
  const bytes = parseDockerSizeToBytes(size);
  return Number.isFinite(bytes) ? bytes : 0;
}

async function defaultFsTotalBytes(path: string): Promise<number | undefined> {
  try {
    const stats = await statfs(path);
    const total = Number(stats.blocks) * Number(stats.bsize);
    return Number.isFinite(total) && total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Disk-pressure check (#105): parses `docker system df` and compares the
 * docker-managed data (images + containers + volumes) against the capacity
 * of the filesystem backing the docker root dir (`docker info`). The sizes
 * double-count shared layers, so the percentage is an upper bound — fine
 * for a warning. Resolves undefined when the numbers cannot be gathered
 * (docker down, no fs capacity) — never throws.
 */
export async function checkDiskPressure(
  deps: DiskPressureDeps = {},
): Promise<DiskPressureSnapshot | undefined> {
  try {
    const df = await runDocker(["system", "df", "--format", "{{json .}}"], deps.runner);
    if (df.code !== 0) return undefined;
    let dockerDataBytes = 0;
    let reclaimableBytes = 0;
    for (const line of df.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let row: DockerSystemDfRow;
      try {
        row = JSON.parse(trimmed) as DockerSystemDfRow;
      } catch {
        continue;
      }
      const size = parseDockerSizeToBytes(row.Size);
      if (Number.isFinite(size)) dockerDataBytes += size;
      reclaimableBytes += reclaimableToBytes(row.Reclaimable);
    }
    const info = await runDocker(["info", "--format", "{{.DockerRootDir}}"], deps.runner);
    const rootDir =
      info.code === 0 && info.stdout.trim() !== "" ? info.stdout.trim() : "/var/lib/docker";
    const total = await (deps.fsTotalBytes ?? defaultFsTotalBytes)(rootDir);
    if (total === undefined || total <= 0) return undefined;
    return {
      dockerDataBytes,
      reclaimableBytes,
      fsTotalBytes: total,
      usedPct: (dockerDataBytes / total) * 100,
    };
  } catch {
    return undefined;
  }
}

export interface WarnDiskPressureOptions extends DiskPressureDeps {
  db: Db;
  /** Warning threshold in percent. Default {@link DEFAULT_DISK_PRESSURE_THRESHOLD_PCT}. */
  thresholdPct?: number;
}

/**
 * Runs {@link checkDiskPressure} and, above the threshold, records one
 * `ops.gc` WARNING event (no auto action — the operator decides) and logs.
 * Returns the snapshot (undefined when unavailable).
 */
export async function warnOnDiskPressure(
  options: WarnDiskPressureOptions,
): Promise<DiskPressureSnapshot | undefined> {
  const threshold = options.thresholdPct ?? DEFAULT_DISK_PRESSURE_THRESHOLD_PCT;
  const snapshot = await checkDiskPressure(options);
  if (snapshot === undefined || snapshot.usedPct <= threshold) return snapshot;
  const reclaimableGb = (snapshot.reclaimableBytes / 1_000_000_000).toFixed(1);
  const warning =
    `disk-pressure: docker data at ${snapshot.usedPct.toFixed(1)}% of the filesystem backing it` +
    (snapshot.reclaimableBytes > 0
      ? ` (${reclaimableGb}GB reclaimable — consider docker system prune)`
      : "");
  recordGcActivity(options.db, {
    warning,
    usedPct: Number(snapshot.usedPct.toFixed(1)),
    reclaimableBytes: snapshot.reclaimableBytes,
    fsTotalBytes: snapshot.fsTotalBytes,
  });
  options.logger?.warn(
    { usedPct: Number(snapshot.usedPct.toFixed(1)), thresholdPct: threshold },
    "sandbox GC: disk pressure detected (warning only, no auto action)",
  );
  return snapshot;
}

/**
 * One GC pass. Never throws: provider/CLI failures degrade to zero counts
 * (logged). Records one `ops.gc` feed event with the counts when anything
 * was collected — or always, for a boot sweep (`emitWhenIdle`).
 */
export async function runSandboxGc(
  deps: SandboxGcDeps,
  options: { emitWhenIdle?: boolean } = {},
): Promise<SandboxGcCounts> {
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? DEFAULT_GC_GRACE_MS;
  const debugGraceMs = deps.debugGraceMs ?? DEFAULT_DEBUG_GRACE_MS;
  const counts: SandboxGcCounts = { destroyed: 0, kept: 0, orphans: 0, cacheVolumesPruned: 0 };

  let sandboxes: SandboxSummary[];
  try {
    sandboxes = await deps.provider.list();
  } catch (err) {
    deps.logger.warn({ err }, "sandbox GC: provider list failed — pass skipped");
    if (options.emitWhenIdle === true) {
      recordGcActivity(deps.db, { ...counts, error: describeError(err) });
    }
    return counts;
  }

  const activeRunIds = new Set(deps.activeRunIds?.() ?? []);
  for (const summary of sandboxes) {
    const runId = summary.labels["run"];
    const run = runId === undefined ? undefined : deps.db.runs.get(runId);
    if (run === undefined) {
      // No run label, or a run row that no longer exists → orphan.
      if (await destroyById(deps, summary.id)) counts.orphans += 1;
      else counts.kept += 1;
      continue;
    }
    const isActiveRun =
      activeRunIds.has(run.id) || run.status === "queued" || run.status === "running";
    if (isActiveRun) {
      counts.kept += 1;
      continue;
    }
    if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
      const keepForDebug = isKeepForDebug(deps.db, run);
      const grace = keepForDebug ? debugGraceMs : graceMs;
      if (terminalAgeMs(run, summary, now()) < grace) {
        counts.kept += 1;
        continue;
      }
      if (await destroyById(deps, summary.id)) counts.destroyed += 1;
      else counts.kept += 1;
      continue;
    }
    // Unrecognized status: never destroy what we do not understand.
    counts.kept += 1;
  }

  counts.cacheVolumesPruned = await pruneOrphanCacheVolumes({
    db: deps.db,
    logger: deps.logger,
    ...(deps.runner === undefined ? {} : { runner: deps.runner }),
  });

  const collected = counts.destroyed + counts.orphans + counts.cacheVolumesPruned;
  if (collected > 0 || options.emitWhenIdle === true) {
    recordGcActivity(deps.db, { ...counts });
  }
  if (collected > 0) {
    deps.logger.info(counts, "sandbox GC pass collected stale resources");
  }
  return counts;
}

export interface PeriodicSandboxGcOptions extends SandboxGcDeps {
  /** Interval between periodic passes. Default {@link DEFAULT_GC_INTERVAL_MS}. */
  intervalMs?: number;
  /** Disk-pressure warning threshold in percent. Default 85. */
  diskPressureThresholdPct?: number;
  /** Injectable fs-capacity probe for the pressure check (tests). */
  fsTotalBytes?: (path: string) => Promise<number | undefined>;
}

export interface PeriodicSandboxGc {
  /**
   * Boot sweep: one pass that ALWAYS emits the `ops.gc` event with the
   * counts (zero counts included — mirrors the recovery sweep). Awaited by
   * index.ts after recovery, before serving.
   */
  bootSweep(): Promise<SandboxGcCounts>;
  /** One immediate periodic pass (sandbox GC + disk-pressure check). */
  runNow(): Promise<void>;
  /** Clears the interval timer; idempotent, registered on shutdown. */
  stop(): void;
}

/**
 * Starts the periodic sandbox GC (#105): every `intervalMs` (default 10min,
 * timer unref'd) one GC pass plus the disk-pressure check. Overlapping ticks
 * are skipped (a slow docker CLI must not pile up passes).
 */
export function startPeriodicSandboxGc(options: PeriodicSandboxGcOptions): PeriodicSandboxGc {
  const intervalMs = options.intervalMs ?? DEFAULT_GC_INTERVAL_MS;
  let running = true;
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (!running || inFlight) return;
    inFlight = true;
    try {
      await runSandboxGc(options);
      await warnOnDiskPressure({
        db: options.db,
        thresholdPct: options.diskPressureThresholdPct,
        logger: options.logger,
        ...(options.runner === undefined ? {} : { runner: options.runner }),
        ...(options.fsTotalBytes === undefined ? {} : { fsTotalBytes: options.fsTotalBytes }),
      });
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  return {
    bootSweep: () => runSandboxGc(options, { emitWhenIdle: true }),
    runNow: () => tick(),
    stop: () => {
      if (!running) return;
      running = false;
      clearInterval(timer);
    },
  };
}
