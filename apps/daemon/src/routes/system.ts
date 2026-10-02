import { execFile } from "node:child_process";
import { constants as fsConstants, accessSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import type { AppEnv } from "../app.js";

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
 */

const execFileAsync = promisify(execFile);

export const SYSTEM_CHECK_CACHE_TTL_MS = 30_000;
export const SYSTEM_CHECK_TIMEOUT_MS = 5_000;

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
   * settings page can show "Auth enabled/disabled" without a token.
   */
  authRequired?: boolean;
}

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

export function createSystemRouter(options: SystemRouterOptions = {}): Hono<AppEnv> {
  const cacheTtlMs = options.cacheTtlMs ?? SYSTEM_CHECK_CACHE_TTL_MS;
  let cached: { at: number; result: SystemCheckResult } | null = null;

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

  return system;
}
