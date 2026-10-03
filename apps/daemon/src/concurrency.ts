/**
 * Upper bound on runs executing at once when `MAX_CONCURRENT_RUNS` is unset
 * or invalid: a conservative default of 2 concurrent agent runs.
 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 2;

/**
 * Parses a `MAX_CONCURRENT_RUNS` value: an integer >= 1 passes through,
 * anything else (unset, empty, fractional, < 1, non-numeric) falls back to
 * {@link DEFAULT_MAX_CONCURRENT_RUNS}.
 */
export function resolveMaxConcurrentRuns(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_MAX_CONCURRENT_RUNS;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_CONCURRENT_RUNS;
  return parsed;
}

/**
 * Upper bound on live provider sandboxes when `MAX_SANDBOXES` is unset or
 * invalid (#105). Flat default (8) covers several maxConcurrentRuns settings
 * plus keepForDebug stragglers; the executor queues sandbox-mode runs that
 * would cross it.
 */
export const DEFAULT_MAX_SANDBOXES = 8;

/**
 * Parses a `MAX_SANDBOXES` value: an integer >= 2 passes through, anything
 * else (unset, empty, fractional, < 2, non-numeric) falls back to
 * {@link DEFAULT_MAX_SANDBOXES}. The floor of 2 keeps one live run plus one
 * debug-kept sandbox reachable even on tiny deployments.
 */
export function resolveMaxSandboxes(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_MAX_SANDBOXES;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 2) return DEFAULT_MAX_SANDBOXES;
  return parsed;
}

/**
 * Delay before a sandbox-capped run is re-enqueued (#105). 30s: long enough
 * for a normal run sandbox to free the slot, short enough to feel live.
 */
export const DEFAULT_SANDBOX_CAP_RETRY_MS = 30_000;
