import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { TERMINAL_RUN_STATUSES, type Project, type Run, type RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { branchForRun, type WorktreeManager, type WorktreeStoreEntry } from "@openeuler/engine";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { recordGcActivity } from "../activity.js";
import { HttpError } from "../errors.js";

/**
 * Per-project worktree manager API (#111): surfaces the isolation layer.
 *
 * - `GET /api/projects/:id/worktrees` — one row per store entry attributable
 *   to the project (metadata `projectPath`, or the run row's `projectId`),
 *   with `du -sB1` disk usage (60s-cached), last activity and a status:
 *   `active` (run queued/running), `inspectable` (run terminal + directory
 *   still on disk), `orphan` (no run row, or only leftovers remain).
 * - `POST /api/projects/:id/worktrees/prune` — `{runId}` removes one
 *   non-active worktree (dir + metadata + branch via `WorktreeManager.remove`
 *   semantics); `{orphans: true}` removes every orphan entry. Active
 *   worktrees answer 409.
 */

const execFileAsync = promisify(execFile);

/** `du -sB1` per-entry result cache TTL for the listing (#111). */
export const WORKTREE_DU_CACHE_TTL_MS = 60_000;
/** Per-`du` timeout for the listing. */
export const WORKTREE_DU_TIMEOUT_MS = 10_000;

/** Lifecycle status of one store entry, derived from its run row (#111). */
export type WorktreeStatus = "active" | "inspectable" | "orphan";

/** One `GET /api/projects/:id/worktrees` row (#111). */
export interface WorktreeView {
  runId: string;
  branch: string;
  path: string;
  /** `du -sB1` of the store directory, 60s-cached; null when `du` fails or the dir is gone. */
  diskUsageBytes: number | null;
  /** Run `updatedAt` when a run row exists, else the metadata `createdAt`. */
  lastActivity: string | null;
  status: WorktreeStatus;
  /** Present when a run row exists. */
  runStatus?: RunStatus;
}

/** One removed entry of `POST …/worktrees/prune` (#111). */
export interface WorktreePruneRemoved {
  runId: string;
  path: string;
  /** Cleanup steps that failed (e.g. the branch is checked out elsewhere). */
  warnings?: string[];
}

export interface WorktreesRouterOptions {
  /** `du` binary for per-entry byte sizing; defaults to `"du"`. */
  duBinary?: string;
  /** Per-`du` timeout; defaults to {@link WORKTREE_DU_TIMEOUT_MS}. */
  duTimeoutMs?: number;
  /** `du` cache TTL; defaults to {@link WORKTREE_DU_CACHE_TTL_MS}. */
  duCacheTtlMs?: number;
}

const PruneBodySchema = z
  .strictObject({
    runId: z.string().min(1).optional(),
    orphans: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.orphans === false) {
      ctx.addIssue({
        code: "custom",
        message: "orphans must be true when present (prune only targets orphans)",
      });
    }
    const selected = (value.runId !== undefined ? 1 : 0) + (value.orphans === true ? 1 : 0);
    if (selected !== 1) {
      ctx.addIssue({
        code: "custom",
        message: 'body must select exactly one target: {runId: "…"} or {orphans: true}',
      });
    }
  });

function requireDb(c: Context<AppEnv>): Db {
  const db = c.get("db");
  if (!db) throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
  return db;
}

function requireWorktrees(c: Context<AppEnv>): WorktreeManager {
  const worktrees = c.get("worktrees");
  if (!worktrees) {
    throw new HttpError(503, "WORKTREES_UNAVAILABLE", "worktree manager is not configured");
  }
  return worktrees;
}

function requireProject(db: Db, projectId: string): Project {
  const project = db.projects.get(projectId);
  if (!project) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", `no project with id ${projectId}`);
  }
  return project;
}

async function parseJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(422, "INVALID_JSON", "request body must be valid JSON");
  }
}

/** A store entry joined with its run row and derived status (#111). */
interface ProjectWorktree {
  entry: WorktreeStoreEntry;
  run: Run | undefined;
  status: WorktreeStatus;
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * Store entries attributable to the project: metadata whose `projectPath`
 * resolves to the project's path, or (metadata gone) a run row owned by the
 * project. Statuses: `active` while the run is queued/running (never
 * prunable), `inspectable` when the run is terminal and the directory still
 * exists, `orphan` for everything else (no run row, or only a leftover
 * directory/metadata remains).
 */
function projectWorktreeEntries(
  worktrees: WorktreeManager,
  db: Db,
  project: Project,
): ProjectWorktree[] {
  const projectPath = resolve(project.path);
  const out: ProjectWorktree[] = [];
  for (const entry of worktrees.list()) {
    const run = db.runs.get(entry.runId);
    const attributed =
      (entry.projectPath !== undefined && resolve(entry.projectPath) === projectPath) ||
      run?.projectId === project.id;
    if (!attributed) continue;
    let status: WorktreeStatus;
    if (run !== undefined && !isTerminalRunStatus(run.status)) {
      status = "active";
    } else if (run !== undefined && run.hostedUntil !== undefined && entry.exists) {
      // Hosted runs (#110) keep a live sandbox bind-mounted at /workspace —
      // pruning the worktree would empty the hosted preview. Treat as active.
      status = "active";
    } else if (run !== undefined && entry.exists) {
      status = "inspectable";
    } else {
      status = "orphan";
    }
    out.push({ entry, run, status });
  }
  return out;
}

/** Epoch ms of an ISO timestamp; 0 for null/unparseable (sorts first, oldest). */
function epochMs(iso: string | null | undefined): number {
  if (iso === null || iso === undefined) return 0;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function createWorktreesRouter(options: WorktreesRouterOptions = {}): Hono<AppEnv> {
  const duBinary = options.duBinary ?? "du";
  const duTimeoutMs = options.duTimeoutMs ?? WORKTREE_DU_TIMEOUT_MS;
  const duCacheTtlMs = options.duCacheTtlMs ?? WORKTREE_DU_CACHE_TTL_MS;
  /** Per-directory `du` results (#111); prune paths are harmless stale entries. */
  const duCache = new Map<string, { at: number; bytes: number | null }>();
  /** In-flight `du` spawns, keyed by path — concurrent callers share one. */
  const inFlightDu = new Map<string, Promise<number | null>>();

  const duBytes = async (path: string, refresh: boolean): Promise<number | null> => {
    if (!refresh) {
      const hit = duCache.get(path);
      if (hit !== undefined && Date.now() - hit.at < duCacheTtlMs) return hit.bytes;
    }
    let bytes: number | null = null;
    try {
      // In-flight dedupe: concurrent callers share one `du` spawn per path.
      let pending = inFlightDu.get(path);
      if (pending === undefined) {
        pending = execFileAsync(duBinary, ["-sB1", path], {
          timeout: duTimeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        })
          .then(({ stdout }) => {
            const value = Number.parseInt(stdout, 10);
            return Number.isFinite(value) && value >= 0 ? value : null;
          })
          .catch(() => null)
          .finally(() => {
            inFlightDu.delete(path);
          });
        inFlightDu.set(path, pending);
      }
      bytes = await pending;
    } catch {
      bytes = null;
    }
    duCache.set(path, { at: Date.now(), bytes });
    return bytes;
  };

  const router = new Hono<AppEnv>();

  router.get("/:id/worktrees", async (c) => {
    const db = requireDb(c);
    const worktrees = requireWorktrees(c);
    const project = requireProject(db, c.req.param("id"));
    const refresh = c.req.query("refresh") === "1";
    const rows = projectWorktreeEntries(worktrees, db, project);
    const views: WorktreeView[] = [];
    let totalBytes = 0;
    let anySized = false;
    for (const row of rows) {
      const diskUsageBytes = row.entry.exists ? await duBytes(row.entry.path, refresh) : null;
      if (diskUsageBytes !== null) {
        totalBytes += diskUsageBytes;
        anySized = true;
      }
      views.push({
        runId: row.entry.runId,
        branch: row.entry.branch ?? branchForRun(row.entry.runId),
        path: row.entry.path,
        diskUsageBytes,
        lastActivity: row.run?.updatedAt ?? row.entry.createdAt ?? null,
        status: row.status,
        ...(row.run === undefined ? {} : { runStatus: row.run.status }),
      });
    }
    // Most recent activity first; unknown activity sorts last.
    views.sort(
      (a, b) => epochMs(b.lastActivity) - epochMs(a.lastActivity) || a.runId.localeCompare(b.runId),
    );
    return c.json({
      worktrees: views,
      totalBytes: anySized || rows.length === 0 ? totalBytes : null,
    });
  });

  router.post("/:id/worktrees/prune", async (c) => {
    const db = requireDb(c);
    const worktrees = requireWorktrees(c);
    const project = requireProject(db, c.req.param("id"));
    const body = PruneBodySchema.parse(await parseJsonBody(c));
    const rows = projectWorktreeEntries(worktrees, db, project);

    if (body.runId !== undefined) {
      const target = rows.find((row) => row.entry.runId === body.runId);
      if (target === undefined) {
        throw new HttpError(
          404,
          "WORKTREE_NOT_FOUND",
          `no worktree for run ${body.runId} on project ${project.id}`,
        );
      }
      if (target.status === "active") {
        throw new HttpError(
          409,
          "WORKTREE_ACTIVE",
          `run ${body.runId} is still ${target.run?.status ?? "running"}; its worktree cannot be pruned until the run finishes`,
        );
      }
    }

    const targets =
      body.runId !== undefined
        ? rows.filter((row) => row.entry.runId === body.runId)
        : rows.filter((row) => row.status === "orphan");
    const removed: WorktreePruneRemoved[] = [];
    for (const target of targets) {
      const result = await worktrees.remove(target.entry.runId);
      // The directory is the disk footprint: when it survives (nothing was
      // removable) the entry was effectively kept, not pruned.
      if (existsSync(target.entry.path)) continue;
      removed.push({
        runId: target.entry.runId,
        path: target.entry.path,
        ...(result.warnings.length === 0 ? {} : { warnings: result.warnings }),
      });
    }
    const kept = rows.length - removed.length;
    if (removed.length > 0) {
      c.get("logger").info(
        { projectId: project.id, removed: removed.map((row) => row.runId), kept },
        "project worktrees pruned",
      );
      recordGcActivity(db, {
        reason: "worktree-prune",
        projectId: project.id,
        removed: removed.length,
        kept,
      });
    }
    return c.json({ removed, kept });
  });

  return router;
}
