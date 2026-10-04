import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  MAX_ARTIFACT_FILES,
  MAX_ARTIFACT_TOTAL_BYTES,
  TERMINAL_RUN_STATUSES,
  matchesArtifactPath,
} from "@openeuler/core";
import type { Run, RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import type { WorktreeManager } from "./worktree.js";

/**
 * Durable run artifacts (#122): when a run turns terminal, the files its
 * workflow's `artifacts` patterns select are copied OUT of the (ephemeral)
 * worktree into `<storeRoot>/<runId>/`, with a `manifest.json` describing
 * the capture. The copy outlives worktree cleanup — that is the point — and
 * orphaned stores (no run row anymore) are garbage-collected with worktree
 * cleanup.
 */

/** Same runId shape the worktree store enforces (ids become dir names). */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Manifest file name inside a run's artifact directory. */
export const ARTIFACT_MANIFEST_FILE = "manifest.json";

/** One captured file: worktree-relative POSIX path + size in bytes. */
export interface ArtifactFileEntry {
  path: string;
  size: number;
}

/** Capture manifest persisted at `<storeRoot>/<runId>/manifest.json`. */
export interface ArtifactManifest {
  runId: string;
  /** Terminal run status at capture time. */
  runStatus: RunStatus;
  /** ISO timestamp of the capture. */
  capturedAt: string;
  patterns: string[];
  files: ArtifactFileEntry[];
  totalBytes: number;
  /** True when caps or per-file copy problems truncated the capture. */
  truncated: boolean;
  /** Partial-capture warning, present iff `truncated`. */
  warning?: string;
}

/** Result of {@link ArtifactStore.capture}. */
export interface ArtifactCaptureResult {
  manifest: ArtifactManifest;
  /** Non-fatal problems encountered while walking (per matching file). */
  warnings: string[];
}

export interface ArtifactStoreOptions {
  /**
   * Root directory holding per-run artifact sets (`<storeRoot>/<runId>`).
   * Defaults to `$OPENEULER_ARTIFACTS`, then `~/.openeuler/artifacts`. The
   * daemon passes `<data dir>/artifacts` explicitly. Created on demand.
   */
  storeRoot?: string;
  /** Cap on captured files per run. Default {@link MAX_ARTIFACT_FILES}. */
  maxFiles?: number;
  /** Cap on total captured bytes per run. Default {@link MAX_ARTIFACT_TOTAL_BYTES}. */
  maxTotalBytes?: number;
}

function validateRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
    throw new Error(
      `runId ${JSON.stringify(runId)} is invalid: it must match ${RUN_ID_PATTERN.source} and is used as a directory name under the artifact store`,
    );
  }
}

function defaultStoreRoot(): string {
  const fromEnv = process.env["OPENEULER_ARTIFACTS"];
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv);
  return join(homedir(), ".openeuler", "artifacts");
}

/** Collects worktree-relative POSIX paths of regular files matching `patterns`. */
function* walkMatches(
  root: string,
  rel: string,
  patterns: readonly string[],
): Generator<{ relPath: string; absPath: string }> {
  const abs = rel === "" ? root : join(root, ...rel.split("/"));
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return; // Unreadable subtree: skip, never fail the capture.
  }
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      yield* walkMatches(root, childRel, patterns);
      continue;
    }
    // Symlinks (and specials) are skipped outright: a link could point
    // anywhere on disk, and following it would copy — and later serve —
    // bytes from outside the worktree.
    if (!entry.isFile()) continue;
    if (matchesArtifactPath(childRel, patterns)) {
      yield { relPath: childRel, absPath: join(abs, entry.name) };
    }
  }
}

/**
 * Terminal-state artifact store (#122). Pure filesystem machinery — the
 * engine decides WHEN to capture (run terminal + patterns configured), the
 * daemon serves the results; nothing here talks to the db.
 */
export class ArtifactStore {
  readonly #storeRoot: string;
  readonly #maxFiles: number;
  readonly #maxTotalBytes: number;

  constructor(options: ArtifactStoreOptions = {}) {
    this.#storeRoot = resolve(options.storeRoot ?? defaultStoreRoot());
    this.#maxFiles = options.maxFiles ?? MAX_ARTIFACT_FILES;
    this.#maxTotalBytes = options.maxTotalBytes ?? MAX_ARTIFACT_TOTAL_BYTES;
  }

  /** Absolute artifact store root (created on demand by {@link capture}). */
  get storeRoot(): string {
    return this.#storeRoot;
  }

  /** `<storeRoot>/<runId>` (does not imply existence). */
  dirFor(runId: string): string {
    validateRunId(runId);
    return join(this.#storeRoot, runId);
  }

  manifestPath(runId: string): string {
    return join(this.dirFor(runId), ARTIFACT_MANIFEST_FILE);
  }

  /**
   * Reads a run's manifest; null when none exists (patterns not configured,
   * capture never ran, or the store was pruned).
   */
  manifest(runId: string): ArtifactManifest | null {
    const file = this.manifestPath(runId);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as ArtifactManifest;
    } catch {
      return null;
    }
  }

  /**
   * Copies every pattern-matching regular file from `worktreePath` into
   * `<storeRoot>/<runId>/` and writes the manifest. Deterministic order
   * (path-sorted) so cap truncation is reproducible. Re-capture (a resumed
   * run turning terminal again) replaces the previous set wholesale. A
   * capture failure partway through keeps what was copied and still writes a
   * manifest recording the error as a partial-capture warning.
   */
  async capture(options: {
    runId: string;
    worktreePath: string;
    patterns: readonly string[];
    runStatus: RunStatus;
  }): Promise<ArtifactCaptureResult> {
    const { runId, worktreePath, patterns, runStatus } = options;
    const dir = this.dirFor(runId);
    // Stage the replacement: a crash mid-copy leaves the previous complete
    // set (and its manifest) untouched. The final directory is created up
    // front so the API can distinguish "capture pending" from "no capture".
    const staging = `${dir}.staging`;
    const warnings: string[] = [];
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    mkdirSync(staging, { recursive: true });

    const matched = [...walkMatches(resolve(worktreePath), "", patterns)].sort((a, b) =>
      a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
    );

    const files: ArtifactFileEntry[] = [];
    let totalBytes = 0;
    let truncated = false;
    let copied = 0;
    for (const match of matched) {
      if (files.length >= this.#maxFiles || totalBytes >= this.#maxTotalBytes) {
        truncated = true;
        break;
      }
      let bytes: Buffer;
      let size: number;
      let source: number | undefined;
      try {
        // O_NOFOLLOW closes the walk-to-copy symlink race: a link swapped in
        // after the walk fails the open instead of copying outside bytes.
        source = openSync(match.absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const stats = fstatSync(source);
        if (!stats.isFile()) continue;
        size = stats.size;
        if (totalBytes + size > this.#maxTotalBytes) {
          truncated = true;
          break;
        }
        bytes = readFileSync(source);
        if (bytes.length !== size) {
          warnings.push(`skipped ${match.relPath}: the file changed while being captured`);
          continue;
        }
      } catch (err) {
        warnings.push(
          `skipped ${match.relPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      } finally {
        if (source !== undefined) closeSync(source);
      }
      try {
        const target = join(staging, ...match.relPath.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      } catch (err) {
        warnings.push(
          `failed to copy ${match.relPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      files.push({ path: match.relPath, size });
      totalBytes += size;
      copied += 1;
    }

    const partial = truncated || warnings.length > 0;
    const manifest: ArtifactManifest = {
      runId,
      runStatus,
      capturedAt: new Date().toISOString(),
      patterns: [...patterns],
      files,
      totalBytes,
      truncated: partial,
      ...(partial
        ? {
            warning: truncated
              ? `partial capture: stopped after ${files.length} file(s) / ${totalBytes} bytes ` +
                `(caps: ${this.#maxFiles} files, ${this.#maxTotalBytes} bytes); ` +
                `${matched.length - copied} matching file(s) left behind`
              : `partial capture: ${warnings.length} matching file(s) could not be read or copied`,
          }
        : {}),
    };
    const manifestFile = join(staging, ARTIFACT_MANIFEST_FILE);
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    rmSync(dir, { recursive: true, force: true });
    try {
      renameSync(staging, dir);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    return { manifest, warnings };
  }

  /** Removes a run's artifact set. Returns true when something existed. */
  remove(runId: string): boolean {
    const dir = this.dirFor(runId);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /**
   * Garbage-collects with worktree cleanup (#122): artifact sets whose run
   * row no longer exists are removed; sets of live runs survive (they must
   * outlive worktree pruning). Returns the removed run ids.
   */
  removeOrphans(knownRunIds: Iterable<string>): string[] {
    if (!existsSync(this.#storeRoot)) return [];
    const known = new Set(knownRunIds);
    const removed: string[] = [];
    for (const entry of readdirSync(this.#storeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // A capture in progress stages beside its run directory; it belongs to
      // that run and must survive a concurrent orphan sweep.
      const baseName = entry.name.endsWith(".staging")
        ? entry.name.slice(0, -".staging".length)
        : entry.name;
      if (known.has(baseName)) continue;
      if (!RUN_ID_PATTERN.test(baseName) || baseName === "." || baseName === "..") continue;
      rmSync(join(this.#storeRoot, entry.name), { recursive: true, force: true });
      removed.push(baseName);
    }
    return removed.sort();
  }
}

/**
 * The engine's terminal-capture hook (#122): no-op unless the run row is
 * terminal, its pinned graph declares `artifacts` patterns, and its
 * worktree still exists. Best-effort by contract — every failure is logged
 * and swallowed (a capture problem must never fail a finished run).
 */
export async function captureTerminalArtifacts(options: {
  store: ArtifactStore;
  db: Pick<Db, "runs" | "workflowRevisions">;
  worktrees: Pick<WorktreeManager, "existing">;
  runId: string;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}): Promise<void> {
  const { store, db, worktrees, runId, log } = options;
  try {
    const run = db.runs.get(runId);
    if (run === undefined) return;
    if (!(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return;
    const patterns = artifactPatternsFor(db, run);
    if (patterns === undefined || patterns.length === 0) return;
    const worktree = worktrees.existing(runId);
    if (worktree === null) return;
    const { manifest, warnings } = await store.capture({
      runId,
      worktreePath: worktree.path,
      patterns,
      runStatus: run.status,
    });
    for (const warning of warnings) log.warn({ runId }, `artifact capture: ${warning}`);
    log.info(
      {
        runId,
        files: manifest.files.length,
        totalBytes: manifest.totalBytes,
        truncated: manifest.truncated,
      },
      "run artifacts captured",
    );
  } catch (err) {
    log.warn({ err, runId }, "artifact capture failed (continuing)");
  }
}

/**
 * A run's artifact patterns: read from its PINNED graph revision, so edits
 * after run creation never change what a running run captures. Undefined
 * for ad-hoc and pre-revision legacy runs (= no capture).
 */
export function artifactPatternsFor(
  db: Pick<Db, "workflowRevisions">,
  run: Run,
): string[] | undefined {
  if (run.workflowRevisionId === undefined) return undefined;
  const revision = db.workflowRevisions.get(run.workflowRevisionId);
  return revision?.graph.artifacts;
}
