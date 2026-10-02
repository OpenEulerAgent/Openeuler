import { execFile } from "node:child_process";
import {
  constants as fsConstants,
  accessSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { TERMINAL_RUN_STATUSES } from "@openeuler/core";
import type { DriverRegistry } from "@openeuler/drivers";
import type { Db } from "@openeuler/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { resolveMaxConcurrentRuns } from "../concurrency.js";
import { HttpError } from "../errors.js";
import { getVersion } from "../version.js";

/**
 * System API.
 *
 * - `GET /api/system/auth-status` (#92): `{authRequired}` — always open, so
 *   the web can discover the auth mode before presenting a token.
 * - `GET /api/system/check` (#53): the onboarding wizard's environment
 *   preflight. Probes git, the opencode CLI (version + auth) and the worktree
 *   store, returning actionable hints for every failure so the first-run UI can
 *   tell the user exactly what to fix. Results are cached for a short TTL so
 *   wizard re-opens and polling don't hammer the binaries; `?refresh=1`
 *   bypasses the cache (the wizard's "Re-check" action).
 * - `GET /api/system/settings` (#95): read-only daemon facts for the settings
 *   hub (version, db path/size, worktree store + `du -sb` bytes, drivers,
 *   concurrency, auth mode, uptime). Auth applies.
 * - `POST /api/system/maintenance` (#95): the settings hub's danger zone —
 *   prune orphaned worktrees, purge the event log of old terminal runs,
 *   vacuum the database. Actions are idempotent, return counts, and report
 *   failures as typed errors. Auth applies.
 */

const execFileAsync = promisify(execFile);

export const SYSTEM_CHECK_CACHE_TTL_MS = 30_000;
export const SYSTEM_CHECK_TIMEOUT_MS = 5_000;
/** `du -sb` result cache TTL for `GET /api/system/settings` (#95). */
export const WORKTREE_BYTES_CACHE_TTL_MS = 60_000;
/** Per-`du` timeout for the settings payload. */
export const DU_TIMEOUT_MS = 10_000;
/** Default age cutoff (days) for `purge-events`. */
export const DEFAULT_PURGE_DAYS = 30;

export interface GitCheck {
  ok: boolean;
  version?: string;
  hint?: string;
}

export interface OpenCodeCheck {
  ok: boolean;
  version?: string;
  authenticated?: boolean;
  hint?: string;
}

export interface WorktreesCheck {
  ok: boolean;
  path: string | null;
}

export interface SystemCheckResult {
  git: GitCheck;
  opencode: OpenCodeCheck;
  worktrees: WorktreesCheck;
}

export interface SystemRouterOptions {
  /** Cache TTL in ms; defaults to {@link SYSTEM_CHECK_CACHE_TTL_MS}. */
  cacheTtlMs?: number;
  /** Per-command timeout in ms; defaults to {@link SYSTEM_CHECK_TIMEOUT_MS}. */
  commandTimeoutMs?: number;
  /** git binary to probe; defaults to `"git"` (resolved via PATH). */
  gitBinary?: string;
  /** opencode binary to probe; defaults to `"opencode"` (resolved via PATH). */
  opencodeBinary?: string;
  /** Worktree store root to check; defaults to the app's WorktreeManager. */
  storeRoot?: string;
  /**
   * Whether bearer-token auth is enabled (`OPENEULER_TOKEN` set, #92).
   * Surfaced by the always-open `GET /api/system/auth-status` so the web
   * settings page can show "Auth enabled/disabled" without a token, and by
   * the auth-gated `GET /api/system/settings` as `authEnabled` (#95).
   */
  authRequired?: boolean;
  /** Driver registry backing `GET /api/system/settings` (#95); app.ts passes its boot registry. */
  drivers?: DriverRegistry;
  /** Concurrency cap reported as `maxConcurrentRuns`; defaults to env resolution. */
  maxConcurrentRuns?: number;
  /** `du` binary for worktree-store byte sizing; defaults to `"du"`. */
  duBinary?: string;
  /** Per-`du` timeout; defaults to {@link DU_TIMEOUT_MS}. */
  duTimeoutMs?: number;
  /** `du` cache TTL; defaults to {@link WORKTREE_BYTES_CACHE_TTL_MS}. */
  bytesCacheTtlMs?: number;
}

/** `GET /api/system/settings` payload (#95): read-only daemon facts. */
export interface SystemSettings {
  version: string;
  dbPath: string | null;
  dbBytes: number | null;
  worktreeRoot: string;
  worktreeBytes: number | null;
  drivers: Array<{ id: string }>;
  defaultDriver: string | null;
  maxConcurrentRuns: number;
  authEnabled: boolean;
  uptimeSeconds: number;
}

/** One `POST /api/system/maintenance` outcome (#95), keyed by `action`. */
export type MaintenanceResult =
  | { action: "prune-worktrees"; removed: number; remaining: number }
  | { action: "purge-events"; deleted: number; dbBytes: number | null }
  | { action: "vacuum"; dbBytes: number | null };

const MaintenanceBodySchema = z.strictObject({
  action: z.enum(["prune-worktrees", "purge-events", "vacuum"]),
  days: z.coerce
    .number()
    .int("days must be an integer")
    .min(0, "days must be >= 0")
    .max(3650, "days must be <= 3650")
    .optional(),
});

interface CommandOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
}

/** Runs one probe binary via execFile (no shell), bounded by a hard timeout. */
async function runCommand(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr, timedOut: false, notFound: false };
  } catch (err) {
    const detail = err as NodeJS.ErrnoException & {
      killed?: boolean;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      ok: false,
      stdout: typeof detail.stdout === "string" ? detail.stdout : "",
      stderr: typeof detail.stderr === "string" ? detail.stderr : "",
      timedOut: detail.killed === true,
      notFound: detail.code === "ENOENT",
    };
  }
}

/** First version-looking token of a `--version` line, tolerant of formats. */
function parseVersion(stdout: string): string | undefined {
  const firstLine = stdout.split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return undefined;
  const match = /\d+[^\s]*/.exec(firstLine);
  return match?.[0] ?? firstLine;
}

async function checkGit(binary: string, timeoutMs: number): Promise<GitCheck> {
  const run = await runCommand(binary, ["--version"], timeoutMs);
  if (!run.ok) {
    return {
      ok: false,
      hint: run.notFound
        ? `git was not found on PATH (tried "${binary}"). Install it from https://git-scm.com/downloads and reopen the wizard`
        : run.timedOut
          ? `\`${binary} --version\` timed out; check your git installation`
          : `\`${binary} --version\` failed${run.stderr ? `: ${run.stderr.split("\n")[0]?.trim()}` : ""}`,
    };
  }
  const version = /git version (\S+)/.exec(run.stdout)?.[1] ?? parseVersion(run.stdout);
  return { ok: true, ...(version === undefined ? {} : { version }) };
}

async function checkOpenCode(binary: string, timeoutMs: number): Promise<OpenCodeCheck> {
  const versionRun = await runCommand(binary, ["--version"], timeoutMs);
  if (!versionRun.ok) {
    return {
      ok: false,
      hint: versionRun.notFound
        ? `opencode CLI not found on PATH (tried "${binary}"). Install it from https://opencode.ai/docs/install, then run: opencode auth login. Until then only the fake driver can run workflows`
        : versionRun.timedOut
          ? `\`${binary} --version\` timed out; the opencode CLI seems broken — reinstall it from https://opencode.ai/docs/install`
          : `\`${binary} --version\` failed${versionRun.stderr ? `: ${versionRun.stderr.split("\n")[0]?.trim()}` : ""}`,
    };
  }
  const version = parseVersion(versionRun.stdout);
  // Auth probe: exit 0 + non-empty output = at least one provider is set up.
  // Deliberately tolerant of format changes — we never parse provider rows.
  const authRun = await runCommand(binary, ["auth", "list"], timeoutMs);
  const authenticated = authRun.ok && authRun.stdout.trim().length > 0;
  return {
    ok: true,
    ...(version === undefined ? {} : { version }),
    authenticated,
    ...(authenticated ? {} : { hint: "Run: opencode auth login" }),
  };
}

/** Fallback store root mirroring WorktreeManager's default resolution. */
function fallbackStoreRoot(): string {
  const fromEnv = process.env["OPENEULER_WORKTREES"];
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv);
  return join(homedir(), ".openeuler", "worktrees");
}

function checkWorktrees(storeRoot: string | undefined): WorktreesCheck {
  if (storeRoot === undefined) return { ok: false, path: null };
  try {
    mkdirSync(storeRoot, { recursive: true });
    accessSync(storeRoot, fsConstants.W_OK);
    return { ok: true, path: storeRoot };
  } catch {
    return { ok: false, path: storeRoot };
  }
}

/**
 * Performs the probes (no caching). Exported for unit tests; routes layer
 * wraps it with the TTL cache.
 */
export async function performSystemCheck(
  options: Pick<SystemRouterOptions, "commandTimeoutMs" | "gitBinary" | "opencodeBinary"> & {
    storeRoot?: string;
  } = {},
): Promise<SystemCheckResult> {
  const timeoutMs = options.commandTimeoutMs ?? SYSTEM_CHECK_TIMEOUT_MS;
  const [git, opencode] = await Promise.all([
    checkGit(options.gitBinary ?? "git", timeoutMs),
    checkOpenCode(options.opencodeBinary ?? "opencode", timeoutMs),
  ]);
  return { git, opencode, worktrees: checkWorktrees(options.storeRoot) };
}

/** Size in bytes of a file, or null when it cannot be stated. */
function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** `du -sb <root>` → bytes, or null when `du` is missing/fails. */
async function duBytes(root: string, binary: string, timeoutMs: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(binary, ["-sb", root], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const value = Number.parseInt(stdout, 10);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** Is `candidate` strictly inside `root` (both resolved, `root` itself excluded)? */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function requireDbFor(c: Context<AppEnv>): Db {
  const db = c.get("db");
  if (!db) throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
  return db;
}

/**
 * Runs `WorktreeManager.pruneAll` (git-side prune + orphan report) and then
 * removes the reported orphan directories — the caller `pruneAll` documents.
 * Orphan metadata files are kept (a later `remove(runId)` may still delete the
 * leftover branch ref). Idempotent; paths outside the store are never touched
 * and count as `remaining`.
 */
export async function pruneWorktrees(
  worktrees: { pruneAll(): Promise<string[]>; storeRoot: string },
  logger?: { warn?: (obj: unknown, msg: string) => void },
): Promise<{ removed: number; remaining: number }> {
  let orphans: string[];
  try {
    orphans = await worktrees.pruneAll();
  } catch (err) {
    throw new HttpError(
      500,
      "MAINTENANCE_FAILED",
      `prune-worktrees failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let removed = 0;
  let remaining = 0;
  for (const orphan of orphans) {
    if (!isInside(worktrees.storeRoot, orphan)) {
      logger?.warn?.({ orphan }, "prune-worktrees skipped a path outside the store root");
      remaining += 1;
      continue;
    }
    try {
      rmSync(orphan, { recursive: true, force: true });
    } catch {
      // fall through to the existence check below
    }
    if (existsSync(orphan)) remaining += 1;
    else removed += 1;
  }
  return { removed, remaining };
}

/**
 * Deletes events of terminal runs whose last transition (`updated_at`) is
 * older than `days` days, then checkpoints the WAL (TRUNCATE) so the freed
 * pages are returned to the filesystem. Returns the deleted count + the
 * post-checkpoint db file size.
 */
export function purgeEvents(db: Db, days: number): { deleted: number; dbBytes: number | null } {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const placeholders = TERMINAL_RUN_STATUSES.map(() => "?").join(", ");
  try {
    const info = db.sqlite
      .prepare(
        `delete from events where run_id in (
           select id from runs where status in (${placeholders}) and updated_at < ?
         )`,
      )
      .run(...TERMINAL_RUN_STATUSES, cutoff);
    db.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    return { deleted: Number(info.changes), dbBytes: fileSize(db.path) };
  } catch (err) {
    throw new HttpError(
      500,
      "MAINTENANCE_FAILED",
      `purge-events failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Rebuilds the database file (`VACUUM`) and reports its new size. */
export function vacuumDatabase(db: Db): { dbBytes: number | null } {
  try {
    db.sqlite.exec("VACUUM");
  } catch (err) {
    throw new HttpError(
      500,
      "MAINTENANCE_FAILED",
      `vacuum failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { dbBytes: fileSize(db.path) };
}

export function createSystemRouter(options: SystemRouterOptions = {}): Hono<AppEnv> {
  const cacheTtlMs = options.cacheTtlMs ?? SYSTEM_CHECK_CACHE_TTL_MS;
  let cached: { at: number; result: SystemCheckResult } | null = null;
  const bytesCacheTtlMs = options.bytesCacheTtlMs ?? WORKTREE_BYTES_CACHE_TTL_MS;
  let cachedBytes: { at: number; value: number | null } | null = null;
  const maxConcurrentRuns =
    options.maxConcurrentRuns ?? resolveMaxConcurrentRuns(process.env["MAX_CONCURRENT_RUNS"]);

  const system = new Hono<AppEnv>();

  // Always open (exempt from the auth middleware, #92): the web app needs to
  // discover the auth mode before it could ever present a token.
  system.get("/auth-status", (c) => c.json({ authRequired: options.authRequired === true }));

  system.get("/check", async (c) => {
    const refresh = c.req.query("refresh") === "1";
    if (!refresh && cached !== null && Date.now() - cached.at < cacheTtlMs) {
      return c.json(cached.result);
    }
    const storeRoot = options.storeRoot ?? c.get("worktrees")?.storeRoot ?? fallbackStoreRoot();
    const result = await performSystemCheck({ ...options, storeRoot });
    cached = { at: Date.now(), result };
    return c.json(result);
  });

  // Settings hub facts (#95). Auth applies like every other /api route (only
  // auth-status above is exempt).
  system.get("/settings", async (c) => {
    const db = c.get("db");
    const storeRoot = options.storeRoot ?? c.get("worktrees")?.storeRoot ?? fallbackStoreRoot();
    const refresh = c.req.query("refresh") === "1";
    if (refresh || cachedBytes === null || Date.now() - cachedBytes.at >= bytesCacheTtlMs) {
      cachedBytes = {
        at: Date.now(),
        value: await duBytes(
          storeRoot,
          options.duBinary ?? "du",
          options.duTimeoutMs ?? DU_TIMEOUT_MS,
        ),
      };
    }
    const drivers = options.drivers
      ? options.drivers.listDrivers().map((driver) => ({ id: driver.id }))
      : [];
    return c.json({
      version: getVersion(),
      dbPath: db?.path ?? null,
      dbBytes: db === undefined ? null : fileSize(db.path),
      worktreeRoot: storeRoot,
      worktreeBytes: cachedBytes.value,
      drivers,
      defaultDriver: drivers[0]?.id ?? null,
      maxConcurrentRuns,
      authEnabled: options.authRequired === true,
      uptimeSeconds: process.uptime(),
    } satisfies SystemSettings);
  });

  // Danger-zone maintenance actions (#95). Idempotent, count-based results;
  // failures surface as typed HttpErrors, never as crashes.
  system.post("/maintenance", async (c) => {
    const body = MaintenanceBodySchema.parse(
      await c.req.json().catch(() => {
        throw new HttpError(422, "VALIDATION_ERROR", "maintenance body must be JSON: {action}");
      }),
    );
    const logger = c.get("logger");
    if (body.action === "prune-worktrees") {
      const worktrees = c.get("worktrees");
      if (!worktrees) {
        throw new HttpError(503, "WORKTREES_UNAVAILABLE", "worktree manager is not configured");
      }
      return c.json({ action: body.action, ...(await pruneWorktrees(worktrees, logger)) });
    }
    const db = requireDbFor(c);
    if (body.action === "purge-events") {
      return c.json({
        action: body.action,
        ...purgeEvents(db, body.days ?? DEFAULT_PURGE_DAYS),
      });
    }
    return c.json({ action: body.action, ...vacuumDatabase(db) });
  });

  return system;
}
