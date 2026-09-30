import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Project } from "@openeuler/core";
import { GitError, gitExec, isGitExitCode } from "./git.js";

/** Machine-readable failure codes for {@link WorktreeError}. */
export type WorktreeErrorCode = "EMPTY_REPO" | "BRANCH_COLLISION" | "INVALID_RUN_ID" | "GIT_FAILED";

/** Typed error thrown by {@link WorktreeManager}. */
export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;

  constructor(code: WorktreeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorktreeError";
    this.code = code;
    Object.setPrototypeOf(this, WorktreeError.prototype);
  }
}

/** Options for {@link WorktreeManager}. */
export interface WorktreeManagerOptions {
  /**
   * Root directory holding per-run worktrees (`<storeRoot>/<runId>`).
   * Defaults to `$OPENEULER_WORKTREES`, then `~/.openeuler/worktrees`.
   * Created on demand. Intended for tests; production uses the env/default.
   */
  storeRoot?: string;
  /** Hard timeout for every git invocation. Default 10s. */
  timeoutMs?: number;
}

/** Location + branch of a run worktree, as returned by {@link WorktreeManager.create}. */
export interface WorktreeInfo {
  /** Absolute path of the worktree working copy (`<storeRoot>/<runId>`). */
  path: string;
  /** Branch checked out in the worktree; always `agentloop/<runId>`. */
  branch: string;
}

/** Uncommitted agent changes inside a worktree. */
export interface WorktreeDiff {
  /** `git diff --stat` summary string (may be empty when clean). */
  stat: string;
  /** Unified diff patch including untracked files (may be empty when clean). */
  patch: string;
}

/** Per-run bookkeeping persisted at `<storeRoot>/meta/<runId>.json`. */
interface WorktreeMetadata {
  runId: string;
  /** Repo the worktree was created from (`project.path`). */
  projectPath: string;
  branch: string;
  worktreePath: string;
  createdAt: string;
}

const BRANCH_PREFIX = "agentloop";
const META_DIR = "meta";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function branchForRun(runId: string): string {
  return `${BRANCH_PREFIX}/${runId}`;
}

function defaultStoreRoot(): string {
  const fromEnv = process.env["OPENEULER_WORKTREES"];
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv);
  return join(homedir(), ".openeuler", "worktrees");
}

function validateRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
    throw new WorktreeError(
      "INVALID_RUN_ID",
      `runId ${JSON.stringify(runId)} is invalid: it must match ${RUN_ID_PATTERN.source} and is used as a directory name under the worktree store`,
    );
  }
}

/**
 * Isolation layer between agent runs and the user's checkout: every run gets
 * its own branch (`agentloop/<runId>`) and its own git worktree under a
 * managed store directory. All git calls go through execFile with a timeout.
 */
export class WorktreeManager {
  readonly #storeRoot: string;
  readonly #timeoutMs: number;

  constructor(options: WorktreeManagerOptions = {}) {
    this.#storeRoot = resolve(options.storeRoot ?? defaultStoreRoot());
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Absolute worktree store root (created on demand by {@link create}). */
  get storeRoot(): string {
    return this.#storeRoot;
  }

  #git(cwd: string, args: readonly string[]): Promise<string> {
    return gitExec(cwd, args, { timeoutMs: this.#timeoutMs });
  }

  #worktreePath(runId: string): string {
    return join(this.#storeRoot, runId);
  }

  #metaPath(runId: string): string {
    return join(this.#storeRoot, META_DIR, `${runId}.json`);
  }

  #readMeta(runId: string): WorktreeMetadata | null {
    const file = this.#metaPath(runId);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as WorktreeMetadata;
    } catch {
      return null;
    }
  }

  #writeMeta(meta: WorktreeMetadata): void {
    mkdirSync(join(this.#storeRoot, META_DIR), { recursive: true });
    writeFileSync(this.#metaPath(meta.runId), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }

  #ensureStore(): void {
    mkdirSync(join(this.#storeRoot, META_DIR), { recursive: true });
  }

  /** Repo path that owns the worktree at `worktreePath`, via `.git/worktrees` layout; null when not a worktree. */
  async #repoForExistingWorktree(worktreePath: string): Promise<string | null> {
    try {
      const commonDir = await this.#git(worktreePath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      if (!isAbsolute(commonDir)) return null;
      return dirname(commonDir);
    } catch {
      return null;
    }
  }

  async #branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.#git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch (err) {
      if (isGitExitCode(err, 1)) return false;
      throw err;
    }
  }

  /**
   * Creates `<storeRoot>/<runId>` as a git worktree of `project`'s repo with a
   * fresh branch `agentloop/<runId>` based on the repo's current HEAD
   * (normally the default branch). Any stale traces of a previous run with the
   * same id are cleaned up first. Throws {@link WorktreeError} EMPTY_REPO when
   * the repo has no commits yet.
   */
  async create(runId: string, project: Project): Promise<WorktreeInfo> {
    validateRunId(runId);
    const branch = branchForRun(runId);
    const projectPath = resolve(project.path);
    const worktreePath = this.#worktreePath(runId);

    this.#ensureStore();

    // Clean stale traces of a previous run with this id (runIds are unique, so
    // this only fires on retries after crashes).
    if (existsSync(worktreePath) || existsSync(this.#metaPath(runId))) {
      await this.#cleanupRun(runId, projectPath);
    }

    try {
      await this.#git(projectPath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    } catch {
      throw new WorktreeError(
        "EMPTY_REPO",
        `repository at ${projectPath} has no commits yet; commit something first (e.g. git commit --allow-empty -m init) before creating a run worktree`,
      );
    }

    if (await this.#branchExists(projectPath, branch)) {
      try {
        await this.#git(projectPath, ["branch", "-D", branch]);
      } catch (err) {
        throw new WorktreeError(
          "BRANCH_COLLISION",
          `branch ${branch} already exists in ${projectPath} and could not be deleted (it may be checked out in another worktree); remove that worktree or pick a new run id`,
          { cause: err },
        );
      }
    }

    try {
      await this.#git(projectPath, ["worktree", "add", worktreePath, "-b", branch]);
    } catch (err) {
      throw new WorktreeError(
        "GIT_FAILED",
        `failed to create worktree for run ${runId} in ${projectPath}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    this.#writeMeta({
      runId,
      projectPath,
      branch,
      worktreePath,
      createdAt: new Date().toISOString(),
    });

    return { path: worktreePath, branch };
  }

  /**
   * Force-removes the run's worktree, prunes git's worktree metadata, deletes
   * the `agentloop/<runId>` branch ref if it still exists, and drops the run's
   * store metadata. Safe when the worktree and/or branch are already gone.
   */
  async remove(runId: string): Promise<void> {
    validateRunId(runId);
    const meta = this.#readMeta(runId);
    const repoPath =
      meta && existsSync(meta.projectPath)
        ? meta.projectPath
        : existsSync(this.#worktreePath(runId))
          ? await this.#repoForExistingWorktree(this.#worktreePath(runId))
          : null;
    await this.#cleanupRun(runId, repoPath ?? undefined);
  }

  async #cleanupRun(runId: string, repoPath?: string): Promise<void> {
    const worktreePath = this.#worktreePath(runId);
    const branch = branchForRun(runId);

    if (repoPath && existsSync(worktreePath)) {
      try {
        await this.#git(repoPath, ["worktree", "remove", "--force", worktreePath]);
      } catch {
        // Already gone or half-deleted; prune + fs fallback below clean up.
      }
    }
    if (repoPath) {
      try {
        await this.#git(repoPath, ["worktree", "prune"]);
      } catch {
        // Best effort: repo may have been removed from disk.
      }
    }
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    if (repoPath && (await this.#branchExists(repoPath, branch))) {
      try {
        await this.#git(repoPath, ["branch", "-D", branch]);
      } catch (err) {
        throw new WorktreeError(
          "GIT_FAILED",
          `failed to delete branch ${branch} from ${repoPath} while removing run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
    const metaFile = this.#metaPath(runId);
    if (existsSync(metaFile)) rmSync(metaFile);
  }

  /**
   * Captures uncommitted agent changes in the worktree as `{ stat, patch }`.
   *
   * Untracked files are included via the intent-to-add trick: each untracked
   * path is registered with `git add -N`, which makes plain `git diff` (and
   * `git diff --stat`) render new-file content without staging blob content.
   * This mutates the worktree's index (empty intent-to-add entries); that is
   * the documented trade-off, preferred over `git diff --no-index` because it
   * keeps a single unified patch that mixes edits and new files.
   */
  async diff(worktreePath: string): Promise<WorktreeDiff> {
    const abs = resolve(worktreePath);
    const status = await this.#git(abs, ["status", "--porcelain", "-z", "--untracked-files=all"]);
    const untracked = this.#parseUntracked(status);
    if (untracked.length > 0) {
      await this.#git(abs, ["add", "-N", "--", ...untracked]);
    }
    const [stat, patch] = await Promise.all([
      this.#git(abs, ["diff", "--stat"]),
      this.#git(abs, ["diff"]),
    ]);
    return { stat, patch };
  }

  /** Untracked paths out of `status --porcelain -z` output (NUL-separated, no quoting). */
  #parseUntracked(statusZ: string): string[] {
    const out: string[] = [];
    for (const record of statusZ.split("\0")) {
      if (record === "") continue;
      // Format: XY <path> (rename records carry a second path; untracked is "?? <path>").
      const xy = record.slice(0, 2);
      const path = record.slice(3);
      if (xy === "??" && path.length > 0) out.push(path);
    }
    return out;
  }

  /**
   * Runs `git worktree prune` in every repo referenced by store metadata (plus
   * `projectPath` when given) and reports orphaned paths — never deletes them;
   * the caller decides:
   *
   * - `<storeRoot>/<runId>` with metadata whose worktree no longer exists or
   *   is no longer registered with its repo (e.g. someone `rm -rf`ed it);
   * - stale directories under the store with no matching run metadata.
   *
   * Orphan metadata files are kept so a later `remove(runId)` can still delete
   * the leftover `agentloop/<runId>` branch ref.
   */
  async pruneAll(projectPath?: string): Promise<string[]> {
    if (!existsSync(this.#storeRoot)) return [];

    const records: WorktreeMetadata[] = [];
    const metaDir = join(this.#storeRoot, META_DIR);
    if (existsSync(metaDir)) {
      for (const entry of readdirSync(metaDir)) {
        if (!entry.endsWith(".json")) continue;
        const runId = entry.slice(0, -".json".length);
        const meta = this.#readMeta(runId);
        if (meta) records.push(meta);
      }
    }

    const repos = new Set<string>(records.map((r) => r.projectPath).filter((p) => existsSync(p)));
    if (projectPath && existsSync(projectPath)) repos.add(resolve(projectPath));

    const live = new Set<string>();
    for (const repo of repos) {
      try {
        await this.#git(repo, ["worktree", "prune"]);
        const list = await this.#git(repo, ["worktree", "list", "--porcelain"]);
        for (const line of list.split("\n")) {
          if (line.startsWith("worktree ")) live.add(line.slice("worktree ".length));
        }
      } catch {
        // Repo disappeared or is not a git repo anymore; nothing to prune there.
      }
    }

    const orphans = new Set<string>();
    for (const record of records) {
      if (!existsSync(record.worktreePath) || !live.has(record.worktreePath)) {
        orphans.add(record.worktreePath);
      }
    }
    const knownRunIds = new Set(records.map((r) => r.runId));
    for (const entry of readdirSync(this.#storeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === META_DIR) continue;
      if (!knownRunIds.has(entry.name)) orphans.add(join(this.#storeRoot, entry.name));
    }
    return [...orphans].sort();
  }
}

export { GitError };
