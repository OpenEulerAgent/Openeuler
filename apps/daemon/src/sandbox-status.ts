import type { DockerCliRunner } from "@openeuler/sandbox";
import { defaultDockerCliRunner, docker, dockerAvailable } from "@openeuler/sandbox";

/**
 * Docker availability detection (#106): backs `GET /api/sandbox/status`.
 *
 * A missing docker must never brick the product — `executionMode: "auto"`
 * projects fall back to local execution, and the web surfaces the state
 * (dashboard pill, run-detail banner, effective-mode hints). This service
 * resolves the availability ONCE per TTL (default 60s) plus the CLI version
 * (`docker --version` answers without a daemon), so polling dashboards stay
 * cheap; `?refresh=1` bypasses the cache (and forces the underlying probe).
 */

/** Status cache TTL; the daemon-side twin of the web's 60s poll. */
export const DOCKER_STATUS_TTL_MS = 60_000;

/** Timeout for the `docker --version` round-trip. */
export const DOCKER_VERSION_TIMEOUT_MS = 5_000;

export type DockerStatusMode = "docker" | "unavailable";

/** `GET /api/sandbox/status` payload (before any per-project fields). */
export interface DockerStatus {
  /** True when `docker info` succeeded (CLI present + daemon reachable). */
  available: boolean;
  /** CLI version from `docker --version`; absent when the CLI is missing. */
  version?: string;
  mode: DockerStatusMode;
  /** Epoch ms of the probe that produced this payload. */
  checkedAt: number;
}

/** Construction options for {@link createDockerStatusService}; all injectable for tests. */
export interface DockerStatusOptions {
  /**
   * Pre-built service (index.ts shares its boot-warmed instance with the
   * router); when set the remaining knobs are ignored.
   */
  service?: DockerStatusService;
  /** Availability probe; defaults to `dockerAvailable()` (30s internal cache). */
  isDockerAvailable?: (options?: { force?: boolean }) => Promise<boolean>;
  /** Injectable `docker --version` runner; defaults to the execFile CLI runner. */
  versionRunner?: DockerCliRunner;
  /** Cache TTL in ms; defaults to {@link DOCKER_STATUS_TTL_MS}. */
  ttlMs?: number;
}

export interface DockerStatusService {
  /** Cached status; `refresh: true` re-probes (and forces the inner probe). */
  status(options?: { refresh?: boolean }): Promise<DockerStatus>;
}

/**
 * "Docker version 24.0.7, build afdd53b" → "24.0.7" — the first
 * version-looking token of the first line, tolerant of format drift.
 */
export function parseDockerVersion(stdout: string): string | undefined {
  const firstLine = stdout.split("\n")[0] ?? "";
  const match = /(\d+[^\s,]*)/.exec(firstLine);
  return match === null ? undefined : match[1];
}

export function createDockerStatusService(
  options: Omit<DockerStatusOptions, "service"> = {},
): DockerStatusService {
  const ttlMs = options.ttlMs ?? DOCKER_STATUS_TTL_MS;
  const probe = options.isDockerAvailable ?? ((opts) => dockerAvailable(opts));
  const versionRunner = options.versionRunner ?? defaultDockerCliRunner;
  let cached: DockerStatus | null = null;
  /** Single-flight: concurrent callers share one in-flight measurement. */
  let inFlight: Promise<DockerStatus> | null = null;

  const measure = async (force: boolean): Promise<DockerStatus> => {
    const available = await probe(force ? { force: true } : {});
    // `docker --version` answers without a daemon; a missing CLI / timeout
    // simply omits the field (availability is the story, the version a bonus).
    let version: string | undefined;
    try {
      const result = await docker(["--version"], {
        runner: versionRunner,
        timeoutMs: DOCKER_VERSION_TIMEOUT_MS,
      });
      version = result.code === 0 ? parseDockerVersion(result.stdout) : undefined;
    } catch {
      version = undefined;
    }
    return {
      available,
      ...(version === undefined ? {} : { version }),
      mode: available ? "docker" : "unavailable",
      checkedAt: Date.now(),
    };
  };

  return {
    async status(opts = {}): Promise<DockerStatus> {
      const refresh = opts.refresh === true;
      if (!refresh && cached !== null && Date.now() - cached.checkedAt < ttlMs) {
        return cached;
      }
      if (inFlight === null) {
        inFlight = measure(refresh)
          .then((measured) => {
            cached = measured;
            return measured;
          })
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    },
  };
}
