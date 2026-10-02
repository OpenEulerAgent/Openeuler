"use client";

import { apiFetch } from "./api";

/**
 * Client view of `GET /api/system/auth-status` (#92) — the one open `/api`
 * route. Lets the settings page (and anything else) show whether the daemon
 * requires a token before any request could authenticate.
 */

export interface AuthStatus {
  authRequired: boolean;
}

export type AuthStatusFetcher = typeof apiFetch;

/** Fetches the daemon's auth mode. Always open — no token required. */
export async function fetchAuthStatus(fetcher: AuthStatusFetcher = apiFetch): Promise<AuthStatus> {
  return fetcher<AuthStatus>("/api/system/auth-status");
}
