import { apiFetch, daemonBaseUrl } from "./api";
import { notifyUnauthorized, setPendingRetry } from "./auth-gate";
import { authorizationHeaderValue, getStoredToken } from "./token";

/**
 * Client for the run artifacts API (#122): list (`GET /api/runs/:id/artifacts`)
 * and authenticated download (`GET /api/runs/:id/artifacts/:file`). Download
 * cannot be a plain link — the daemon token rides the Authorization header —
 * so it fetches a blob and triggers a local save.
 */

/** One captured file: worktree-relative POSIX path + size in bytes. */
export interface RunArtifactFile {
  path: string;
  size: number;
}

/** Mirrors the daemon's `ArtifactManifest`. */
export interface RunArtifactsBody {
  runId: string;
  runStatus: string;
  capturedAt: string;
  patterns: string[];
  files: RunArtifactFile[];
  totalBytes: number;
  truncated: boolean;
  warning?: string;
}

/** Encodes an artifact path for the URL (each segment, preserving slashes). */
export function artifactPathToUrl(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

/** Fetches a terminal run's artifact manifest; `fetcher` injectable for tests. */
export async function fetchRunArtifacts(
  runId: string,
  fetcher: (path: string) => Promise<RunArtifactsBody> = (path) => apiFetch<RunArtifactsBody>(path),
): Promise<RunArtifactsBody> {
  return fetcher(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
}

/**
 * Downloads one artifact through the authenticated fetch and saves it via a
 * transient object URL. Returns the bytes written (for tests).
 */
export async function downloadRunArtifact(
  runId: string,
  path: string,
  deps: {
    fetchImpl?: typeof fetch;
    save?: (blob: Blob, filename: string) => void;
  } = {},
): Promise<void> {
  const doFetch = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const save =
    deps.save ??
    ((blob: Blob, filename: string): void => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Give Safari's download handler a turn before invalidating the URL.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    });
  const auth = authorizationHeaderValue(getStoredToken());
  const response = await doFetch(
    `${daemonBaseUrl()}/api/runs/${encodeURIComponent(runId)}/artifacts/${artifactPathToUrl(path)}`,
    {
      headers: auth === undefined ? {} : { Authorization: auth },
    },
  );
  if (!response.ok) {
    if (response.status === 401) {
      // Mirror apiFetch's token-gate behavior for this raw blob fetch.
      setPendingRetry(() => downloadRunArtifact(runId, path, deps));
      notifyUnauthorized();
    }
    let message = `download failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // keep the status-line message
    }
    throw new Error(message);
  }
  save(await response.blob(), path.split("/").pop() || "artifact");
}

/** Human-readable byte size (`1.2 KB` style, binary units). */
export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
