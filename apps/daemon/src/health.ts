import { DEFAULT_MAX_CONCURRENT_RUNS } from "./concurrency.js";
import { getVersion } from "./version.js";

export interface HealthPayload {
  ok: boolean;
  version: string;
  uptime: number;
  /** Global run-concurrency cap the executor was booted with. */
  maxConcurrentRuns: number;
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
