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
