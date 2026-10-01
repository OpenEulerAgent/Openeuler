import { apiFetch } from "./api";

/**
 * Client view of `GET /api/system/check` (#53): the wizard's environment
 * preflight payload plus the pure display model rendered as status rows.
 */

export interface SystemCheck {
  git: { ok: boolean; version?: string; hint?: string };
  opencode: { ok: boolean; version?: string; authenticated?: boolean; hint?: string };
  worktrees: { ok: boolean; path: string | null };
}

export type SystemCheckFetcher = typeof apiFetch;

/** Fetch the environment check; `refresh` bypasses the daemon's 30s cache. */
export async function fetchSystemCheck(
  fetcher: SystemCheckFetcher = apiFetch,
  options: { refresh?: boolean } = {},
): Promise<SystemCheck> {
  const query = options.refresh ? "?refresh=1" : "";
  return fetcher<SystemCheck>(`/api/system/check${query}`);
}

/** Display severity for one check row: git/worktrees failures are blockers. */
export type SystemCheckRowStatus = "ok" | "warn" | "error";

export interface SystemCheckRow {
  id: "git" | "opencode" | "worktrees";
  label: string;
  status: SystemCheckRowStatus;
  detail: string;
  hint?: string;
}

const OPENCODE_INSTALL_HINT =
  "Install the opencode CLI from https://opencode.ai/docs/install — until then only the fake driver can run workflows";

/**
 * Pure display model for the wizard's environment step. git and worktrees are
 * hard requirements (error when missing); opencode issues are warnings the
 * user may continue past.
 */
export function systemCheckRows(check: SystemCheck): SystemCheckRow[] {
  const rows: SystemCheckRow[] = [];

  rows.push(
    check.git.ok
      ? {
          id: "git",
          label: "git",
          status: "ok",
          detail: check.git.version === undefined ? "git found" : `git ${check.git.version}`,
        }
      : {
          id: "git",
          label: "git",
          status: "error",
          detail: "git not available",
          hint: check.git.hint,
        },
  );

  if (!check.opencode.ok) {
    rows.push({
      id: "opencode",
      label: "opencode CLI",
      status: "warn",
      detail: "opencode CLI not available",
      hint: check.opencode.hint ?? OPENCODE_INSTALL_HINT,
    });
  } else if (check.opencode.authenticated === true) {
    rows.push({
      id: "opencode",
      label: "opencode CLI",
      status: "ok",
      detail:
        check.opencode.version === undefined
          ? "installed and authenticated"
          : `opencode ${check.opencode.version} · authenticated`,
    });
  } else {
    rows.push({
      id: "opencode",
      label: "opencode CLI",
      status: "warn",
      detail:
        check.opencode.version === undefined
          ? "installed but not authenticated"
          : `opencode ${check.opencode.version} · not authenticated`,
      hint: "Run: opencode auth login",
    });
  }

  rows.push(
    check.worktrees.ok
      ? {
          id: "worktrees",
          label: "worktree store",
          status: "ok",
          detail: `runs land in ${check.worktrees.path}`,
        }
      : {
          id: "worktrees",
          label: "worktree store",
          status: "error",
          detail: `worktree store not writable: ${check.worktrees.path ?? "unknown path"}`,
          hint: "Check the OPENEULER_WORKTREES directory permissions, then re-check",
        },
  );

  return rows;
}

/** Whether the wizard may continue past the environment step. */
export function environmentBlocksContinue(check: SystemCheck): boolean {
  return !check.git.ok || !check.worktrees.ok;
}
