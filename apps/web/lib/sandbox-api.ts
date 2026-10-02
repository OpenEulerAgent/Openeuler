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
