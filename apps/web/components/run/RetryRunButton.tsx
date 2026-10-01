"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { apiFetch, ApiError } from "@/lib/api";
import { nextRunHref, retryEndpoint } from "@/lib/run-recovery";
import type { Run } from "@openeuler/core";

interface RetryResponse {
  run: Run;
}

/**
 * Header Retry action (#52, semantics from #19): POSTs the retry endpoint
 * and navigates to the fresh run's detail page. 409 (run no longer
 * finished) collapses to a plain error message.
 */
export function RetryRunButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const body = await apiFetch<RetryResponse>(retryEndpoint(runId), { method: "POST" });
      router.push(nextRunHref(body.run.id));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Failed to retry run");
      setBusy(false);
    }
  };

  return (
    <span className="flex items-center gap-2">
      <Button variant="secondary" onClick={() => void retry()} loading={busy}>
        {busy ? "Retrying…" : "Retry"}
      </Button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </span>
  );
}
