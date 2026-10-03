import { ApiError, apiFetch } from "./api";

/**
 * Sandbox image management API client (#100): the settings page's Sandbox
 * section — catalog, async pull/build jobs (poll `GET /api/sandbox/jobs/:id`
 * until terminal), and image deletion with in-use error detection.
 */

/** One `GET /api/sandbox/images` row. */
export interface SandboxImageEntry {
  repository: string;
  tag: string;
  id: string;
  sizeBytes: number;
  /** Epoch ms. */
  createdAt: number;
  /** True when the repository is under the daemon's `openeuler/` namespace. */
  ours: boolean;
}

export type SandboxJobKind = "pull" | "build";

/** One `GET /api/sandbox/jobs/:id` record (in-memory, per daemon process). */
export interface SandboxJob {
  id: string;
  kind: SandboxJobKind;
  ref: string;
  status: "running" | "done" | "failed";
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

/** Injectable transport so flows are testable without a browser. */
export type SandboxFetcher = typeof apiFetch;

/** `202 {jobId}` body of `POST /api/sandbox/images/pull`. */
export interface SandboxPullStarted {
  jobId: string;
}

/** `202 {jobId, tag}` body of `POST /api/sandbox/images/build`. */
export interface SandboxBuildStarted {
  jobId: string;
  tag: string;
}

/** Default delay between job polls in {@link waitForSandboxJob}. */
export const JOB_POLL_INTERVAL_MS = 1_000;

/** `GET /api/sandbox/status` payload (#106); project fields with `?projectId=`. */
export interface SandboxStatus {
  /** True when `docker info` succeeded (CLI present + daemon reachable). */
  available: boolean;
  /** CLI version from `docker --version`; absent when the CLI is missing. */
  version?: string;
  mode: "docker" | "unavailable";
  /** Epoch ms of the daemon-side probe. */
  checkedAt: number;
  /** With `?projectId=`: the project's policy executionMode ("local" when unset). */
  projectMode?: "local" | "sandbox" | "auto";
  /** With `?projectId=`: the resolved effective mode, same logic as the executor. */
  effective?: "local" | "sandbox";
}

/**
 * Docker availability + (optionally) a project's effective execution mode
 * (#106). The daemon caches the probe for 60s.
 */
export async function fetchSandboxStatus(
  projectId?: string,
  fetcher: SandboxFetcher = apiFetch,
): Promise<SandboxStatus> {
  const query = projectId === undefined ? "" : `?projectId=${encodeURIComponent(projectId)}`;
  return fetcher<SandboxStatus>(`/api/sandbox/status${query}`);
}

/**
 * The executor's mode resolution (#102/#106), mirrored client-side so hints
 * can react live to unsaved form state: sandbox stays sandbox, auto follows
 * docker availability, everything else is local.
 */
export function resolveEffectiveMode(
  executionMode: "local" | "sandbox" | "auto",
  available: boolean,
): "local" | "sandbox" {
  if (executionMode === "sandbox") return "sandbox";
  if (executionMode === "auto") return available ? "sandbox" : "local";
  return "local";
}

/** Decision input for the run-detail local-fallback banner (#106). */
export interface LocalFallbackBannerInput {
  /** True when the run detail payload carries live sandbox info (#102). */
  sandboxPresent: boolean;
  /** Project policy executionMode; absent when no policy was saved. */
  projectMode?: "local" | "sandbox" | "auto";
  /** Current docker availability from the status endpoint. */
  available: boolean;
  /**
   * Run status. Absence of sandbox info is only a valid local-run proxy
   * while the run is EXECUTING — terminal runs drop sandbox info from the
   * API, so a completed sandboxed run viewed after docker went down (or a
   * fast-failed SANDBOX_UNAVAILABLE run) must not be mislabeled.
   */
  runStatus?: string;
}

/**
 * True when a run is executing locally while its project's policy wants a
 * sandbox and docker is unavailable — the "Running locally — Docker
 * unavailable" case. A run WITH sandbox info executes sandboxed (no banner);
 * local-policy projects are local by choice (no banner either).
 */
export function showLocalFallbackBanner(input: LocalFallbackBannerInput): boolean {
  if (input.runStatus !== undefined && input.runStatus !== "running" && input.runStatus !== "queued") {
    return false;
  }
  if (input.sandboxPresent) return false;
  if (input.projectMode !== "auto" && input.projectMode !== "sandbox") return false;
  return !input.available;
}

/**
 * Effective-mode hint line (#106) for the settings drawer and the run modal:
 * "effective: sandbox (Docker detected)" / "effective: local (Docker
 * unavailable)" / the honest variants for the remaining corners.
 */
export function effectiveModeHint(input: {
  executionMode: "local" | "sandbox" | "auto";
  available: boolean;
}): string {
  const effective = resolveEffectiveMode(input.executionMode, input.available);
  if (effective === "sandbox") {
    return input.available
      ? "effective: sandbox (Docker detected)"
      : "effective: sandbox (Docker unavailable — sandbox runs will fail)";
  }
  return input.executionMode === "auto"
    ? "effective: local (Docker unavailable)"
    : "effective: local (policy: local)";
}

export async function fetchSandboxImages(
  fetcher: SandboxFetcher = apiFetch,
): Promise<SandboxImageEntry[]> {
  const body = await fetcher<{ images?: SandboxImageEntry[] }>("/api/sandbox/images");
  // Defensive against malformed 200 payloads (proxies, older daemons):
  // anything not shaped like a catalog renders as an empty one.
  return Array.isArray(body?.images) ? body.images : [];
}

export async function startSandboxImagePull(
  ref: string,
  fetcher: SandboxFetcher = apiFetch,
): Promise<SandboxPullStarted> {
  return fetcher<SandboxPullStarted>("/api/sandbox/images/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
  });
}

export async function startSandboxImageBuild(
  input: { name: string; dockerfileText?: string; baseRef?: string },
  fetcher: SandboxFetcher = apiFetch,
): Promise<SandboxBuildStarted> {
  return fetcher<SandboxBuildStarted>("/api/sandbox/images/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteSandboxImage(
  ref: string,
  fetcher: SandboxFetcher = apiFetch,
): Promise<void> {
  await fetcher(`/api/sandbox/images/${encodeURIComponent(ref)}`, { method: "DELETE" });
}

export async function fetchSandboxJob(
  jobId: string,
  fetcher: SandboxFetcher = apiFetch,
): Promise<SandboxJob> {
  return fetcher<SandboxJob>(`/api/sandbox/jobs/${encodeURIComponent(jobId)}`);
}

/**
 * Polls a job until it leaves `running`. `pollMs: 0` turns this into a
 * tight loop (tests); production uses {@link JOB_POLL_INTERVAL_MS}. The
 * optional signal aborts the loop between polls (caller cleanup).
 */
export async function waitForSandboxJob(
  jobId: string,
  options: { pollMs?: number; fetcher?: SandboxFetcher; signal?: AbortSignal } = {},
): Promise<SandboxJob> {
  const pollMs = options.pollMs ?? JOB_POLL_INTERVAL_MS;
  for (;;) {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const job = await fetchSandboxJob(jobId, options.fetcher);
    if (job.status !== "running") return job;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, pollMs);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }
}

/** `repository:tag` display form of a catalog row. */
export function imageRefOf(image: Pick<SandboxImageEntry, "repository" | "tag">): string {
  return `${image.repository}:${image.tag}`;
}

/** True when the daemon answered 409 IMAGE_IN_USE (sandbox holds the image). */
export function isImageInUseError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "IMAGE_IN_USE";
}

/** True when the daemon answered 404 IMAGE_NOT_FOUND. */
export function isImageNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "IMAGE_NOT_FOUND";
}
