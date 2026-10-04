"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  downloadRunArtifact,
  fetchRunArtifacts,
  formatArtifactSize,
  type RunArtifactsBody,
} from "@/lib/artifacts-api";

/**
 * Artifacts tab of the run detail page (#122): the durable capture of a
 * terminal run's `artifacts` patterns — list with sizes, authenticated
 * download, and a copy-path affordance for pasting into a terminal. Live
 * runs explain that artifacts appear when the run finishes.
 */

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; manifest: RunArtifactsBody }
  | { phase: "empty" }
  | { phase: "pending" }
  | { phase: "error"; message: string };

/** Failure classification without leaking ApiError into this module. */
function classifyFailure(status: number, message: string): LoadState {
  if (status === 409) return { phase: "pending" };
  if (status === 404) return { phase: "empty" };
  return { phase: "error", message };
}

export function ArtifactsTab({ runId, terminal }: { runId: string; terminal: boolean }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  /** Bumped by Retry; re-runs the load effect without changing identity deps. */
  const [reloadNonce, setReloadNonce] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    if (!terminal) {
      setState({ phase: "pending" });
      return;
    }
    fetchRunArtifacts(runId)
      .then((manifest) => {
        if (!cancelled) setState({ phase: "ready", manifest });
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        setState(classifyFailure(err?.status ?? 0, err?.message ?? "Failed to load artifacts"));
      });
    return () => {
      cancelled = true;
    };
  }, [runId, terminal, reloadNonce]);

  const copyPath = useCallback((path: string) => {
    setCopied(path);
    void navigator.clipboard?.writeText(path).then(undefined, () => undefined);
    setTimeout(() => setCopied((current) => (current === path ? null : current)), 1500);
  }, []);

  const download = useCallback(
    (path: string) => {
      setDownloadError(null);
      void downloadRunArtifact(runId, path).catch((err: unknown) => {
        setDownloadError(err instanceof Error ? err.message : "Download failed");
      });
    },
    [runId],
  );

  if (state.phase === "loading") {
    return <p className="py-6 text-sm text-muted-fg">Loading artifacts…</p>;
  }

  if (state.phase === "pending") {
    return (
      <p className="py-6 text-sm text-muted-fg" data-testid="artifacts-pending">
        Artifacts are captured when the run finishes.
      </p>
    );
  }

  if (state.phase === "empty") {
    return (
      <p className="py-6 text-sm text-muted-fg" data-testid="artifacts-empty">
        No artifacts were captured for this run — its workflow declared no artifact patterns, or the
        patterns matched no files.
      </p>
    );
  }

  if (state.phase === "error") {
    return (
      <div
        className="rounded-lg border border-danger/40 bg-danger-subtle p-4 text-sm text-danger"
        data-testid="artifacts-error"
      >
        <p>{state.message}</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => setReloadNonce((nonce) => nonce + 1)}
        >
          Retry
        </Button>
      </div>
    );
  }

  const { manifest } = state;

  return (
    <div className="flex flex-col gap-3">
      {manifest.truncated && manifest.warning ? (
        <div
          className="rounded-lg border border-warning/40 bg-warning-subtle px-4 py-2 text-xs text-warning"
          data-testid="artifacts-truncated-banner"
        >
          {manifest.warning}
        </div>
      ) : null}
      {downloadError ? (
        <p className="text-xs text-danger" data-testid="artifacts-download-error">
          {downloadError}
        </p>
      ) : null}

      {manifest.files.length === 0 ? (
        <p className="py-6 text-sm text-muted-fg" data-testid="artifacts-empty">
          The artifact patterns ({manifest.patterns.join(", ")}) matched no files in this run&apos;s
          worktree.
        </p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm" data-testid="artifacts-table">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-fg">
                  <th scope="col" className="px-4 py-2 font-medium">
                    File
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Size
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {manifest.files.map((file) => (
                  <tr key={file.path} className="border-b border-border/60 last:border-0">
                    <td className="max-w-0 truncate px-4 py-2 font-mono text-xs" title={file.path}>
                      {file.path}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted-fg">
                      {formatArtifactSize(file.size)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <span className="inline-flex gap-1">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => download(file.path)}
                          aria-label={`Download ${file.path}`}
                        >
                          Download
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => copyPath(file.path)}
                          aria-label={`Copy path ${file.path}`}
                        >
                          {copied === file.path ? "Copied" : "Copy path"}
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-xs text-muted-fg">
                  <td className="px-4 py-2">
                    {manifest.files.length} file
                    {manifest.files.length === 1 ? "" : "s"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatArtifactSize(manifest.totalBytes)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
