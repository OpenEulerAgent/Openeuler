"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Run, StepRun } from "@openeuler/core";
import { Button } from "@/components/Button";
import { apiFetch, ApiError } from "@/lib/api";
import { nextRunHref, resumeEndpoint, resumePossible, retryEndpoint } from "@/lib/run-recovery";

interface RetryResponse {
  run: Run;
}

/**
 * Banner shown on an interrupted run's detail page: the daemon died under
 * this run (restart/crash). Resume re-enqueues it in place when the agent
 * context survived (all sessions recorded); Retry always works and navigates
 * to the fresh run.
 */
export function InterruptedRunBanner({
  run,
  steps,
  onChanged,
}: {
  run: Run;
  steps: readonly StepRun[];
  onChanged: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"resume" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (run.status !== "interrupted") return null;
  const canResume = resumePossible(steps);

  const resume = async (): Promise<void> => {
    setBusy("resume");
    setError(null);
    try {
      await apiFetch(resumeEndpoint(run.id), { method: "POST" });
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Failed to resume run");
    } finally {
      setBusy(null);
    }
  };

  const retry = async (): Promise<void> => {
    setBusy("retry");
    setError(null);
    try {
      const body = await apiFetch<RetryResponse>(retryEndpoint(run.id), { method: "POST" });
      router.push(nextRunHref(body.run.id));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Failed to retry run");
      setBusy(null);
    }
  };

  return (
    <section
      role="alert"
      className="rounded-xl border border-violet-200 bg-violet-50 px-5 py-4 text-sm text-violet-800 shadow-sm"
    >
      <p className="font-medium">
        This run was interrupted by a daemon restart. Its branch and recorded step history are
        preserved.
      </p>
      <p className="mt-1 text-violet-600">
        {canResume
          ? "All started steps recorded their agent sessions — the run can resume in place from where it stopped."
          : "At least one started step recorded no agent session, so the run cannot resume in place. Retry it as a new run instead."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canResume ? (
          <Button onClick={() => void resume()} disabled={busy !== null}>
            {busy === "resume" ? "Resuming…" : "Resume run"}
          </Button>
        ) : null}
        <Button
          variant={canResume ? "secondary" : "primary"}
          onClick={() => void retry()}
          disabled={busy !== null}
        >
          {busy === "retry" ? "Retrying…" : "Retry as new run"}
        </Button>
        {error ? <span className="text-xs text-red-600">{error}</span> : null}
      </div>
    </section>
  );
}
