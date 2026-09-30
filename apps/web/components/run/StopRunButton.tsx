"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import { apiFetch, ApiError } from "@/lib/api";

/**
 * Stop button with an inline confirm step: the first click arms it, the
 * second POSTs the abort. 409 (already terminal) is treated as success —
 * the run ended on its own in the meantime.
 */
export function StopRunButton({ runId, onAborted }: { runId: string; onAborted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abort = async (): Promise<void> => {
    setAborting(true);
    setError(null);
    try {
      await apiFetch(`/api/runs/${encodeURIComponent(runId)}/abort`, { method: "POST" });
      onAborted();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        onAborted();
      } else {
        setError(cause instanceof ApiError ? cause.message : "Failed to abort run");
      }
    } finally {
      setAborting(false);
      setConfirming(false);
    }
  };

  if (!confirming) {
    return (
      <Button
        variant="secondary"
        className="border-red-200 text-red-600 hover:bg-red-50"
        onClick={() => setConfirming(true)}
      >
        Stop run
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-slate-600">Stop this run?</span>
      <Button
        onClick={() => void abort()}
        disabled={aborting}
        className="bg-red-600 hover:bg-red-500"
      >
        {aborting ? "Stopping…" : "Confirm stop"}
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)} disabled={aborting}>
        Cancel
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
