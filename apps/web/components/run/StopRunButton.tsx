"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch, ApiError } from "@/lib/api";

/**
 * Stop button with an inline confirm step: the first click arms it (and
 * focuses the confirm control; Escape cancels), the second POSTs the abort.
 * 409 (already terminal) is treated as success — the run ended on its own
 * in the meantime.
 */
export function StopRunButton({ runId, onAborted }: { runId: string; onAborted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && !aborting) setConfirming(false);
  };

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
        className="border-danger/40 text-danger hover:bg-danger-subtle"
        onClick={() => setConfirming(true)}
      >
        Stop run
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2" onKeyDown={handleKeyDown}>
      <span className="text-sm text-muted-fg">Stop this run?</span>
      <Button ref={confirmRef} variant="danger" onClick={() => void abort()} loading={aborting}>
        {aborting ? "Stopping…" : "Confirm stop"}
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)} disabled={aborting}>
        Cancel
      </Button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}
