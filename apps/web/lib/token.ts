"use client";

/**
 * Daemon token store (#92): when the daemon runs with `OPENEULER_TOKEN`,
 * the browser keeps the bearer token in localStorage and every API call
 * (and SSE URL) carries it. Local-first: the token never leaves the
 * browser except as the auth credential itself.
 */

/** localStorage key the daemon bearer token is stored under. */
export const TOKEN_STORAGE_KEY = "openeuler.token";

/** Browsers can refuse localStorage (private mode, quota); never throw. */
function safeGet(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(storage: Storage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Quota/private-mode: the token just won't persist; apiFetch still sends
    // it for this page lifetime via the in-memory fallback below.
    memoryToken = value;
  }
}

function safeRemove(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Ignore — the memory fallback is cleared regardless.
  }
}

/**
 * In-memory fallback for browsers where localStorage writes fail: the gate
 * stays usable for the current page even if the token won't persist.
 */
let memoryToken: string | null = null;

/** localStorage when available (client); undefined on the server. */
export function tokenStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** The stored daemon token, or null. Trimmed; empty means "not stored". */
export function getStoredToken(storage: Storage | undefined = tokenStorage()): string | null {
  const stored = safeGet(storage, TOKEN_STORAGE_KEY);
  if (stored !== null && stored.trim().length > 0) return stored.trim();
  return memoryToken !== null && memoryToken.trim().length > 0 ? memoryToken.trim() : null;
}

/** Persists the token (trimmed); empty values are rejected. */
export function storeToken(token: string, storage: Storage | undefined = tokenStorage()): void {
  const trimmed = token.trim();
  if (trimmed.length === 0) return;
  memoryToken = trimmed;
  safeSet(storage, TOKEN_STORAGE_KEY, trimmed);
}

/** Drops the stored token (the web "logout" — the daemon gate reappears on the next 401). */
export function clearStoredToken(storage: Storage | undefined = tokenStorage()): void {
  memoryToken = null;
  safeRemove(storage, TOKEN_STORAGE_KEY);
}

/** `Authorization` header value for a token, or undefined when there is none. */
export function authorizationHeaderValue(token: string | null | undefined): string | undefined {
  const trimmed = token?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : `Bearer ${trimmed}`;
}

/** Test helper: reset the in-memory fallback between cases. */
export function __resetMemoryToken(): void {
  memoryToken = null;
}
