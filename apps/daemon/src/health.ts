import { DEFAULT_MAX_CONCURRENT_RUNS } from "./concurrency.js";
import { getVersion } from "./version.js";

export interface HealthPayload {
  ok: boolean;
  version: string;
  uptime: number;
  /** Global run-concurrency cap the executor was booted with. */
  maxConcurrentRuns: number;
}

/** Minimal `/health` shape answered while token auth is enabled (#92). */
export interface MinimalHealthPayload {
  ok: boolean;
  version: string;
}

export function healthPayload(
  maxConcurrentRuns: number = DEFAULT_MAX_CONCURRENT_RUNS,
): HealthPayload {
  return {
    ok: true,
    version: getVersion(),
    uptime: Math.floor(process.uptime()),
    maxConcurrentRuns,
  };
}

/**
 * `ok` + version only: `/health` stays reachable without a token (liveness
 * probes) but leaks nothing about run capacity or uptime once the daemon is
 * locked down (#92).
 */
export function minimalHealthPayload(): MinimalHealthPayload {
  return { ok: true, version: getVersion() };
}
