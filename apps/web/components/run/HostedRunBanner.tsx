"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import {
  HOSTING_COUNTDOWN_TICK_MS,
  HOSTING_EXTEND_QUICK_MINUTES,
  hostingBannerText,
  stopRunHosting,
  extendRunHosting,
  type RunHostingView,
} from "@/lib/hosting";

/**
 * Hosted-run banner (#110): "Hosted — preview live · expires in Xm" over
 * the run detail while the run's sandbox is kept alive past success. Two
 * actions: **+30m** (quick extend) and **Stop hosting** (inline confirm —
 * destroying the sandbox ends the preview). Both refresh the detail via
 * {@link onChanged}; a 409 on either means hosting already ended — also a
 * refresh, never an error toast.
 */
export function HostedRunBanner({
  runId,
  hosting,
  onChanged,
}: {
  runId: string;
  /** Current hosting view from `GET /api/runs/:id`; renders nothing when null. */
  hosting: RunHostingView | null;
  /** Called after a successful stop/extend (or a 409) to refetch the detail. */
  onChanged: () => void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [extending, setExtending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Countdown ticker: only while the banner is actually mounted.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), HOSTING_COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (hosting === null) return null;

  const extend = async (): Promise<void> => {
    setExtending(true);
    setError(null);
    try {
      await extendRunHosting(runId, HOSTING_EXTEND_QUICK_MINUTES);
      onChanged();
    } catch (cause) {
      // 409 = hosting ended on its own mid-click; the refresh shows truth.
      if (cause instanceof ApiError && cause.status === 409) onChanged();
      else setError(cause instanceof ApiError ? cause.message : "Failed to extend hosting");
    } finally {
      setExtending(false);
    }
  };

  const stop = async (): Promise<void> => {
    setStopping(true);
    setError(null);
    try {
      await stopRunHosting(runId);
      onChanged();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) onChanged();
      else setError(cause instanceof ApiError ? cause.message : "Failed to stop hosting");
    } finally {
      setStopping(false);
      setConfirming(false);
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-success/40 bg-success-subtle px-4 py-3 text-sm text-fg"
      data-hosted-banner
      data-hosted-until={hosting.until}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !stopping) setConfirming(false);
      }}
    >
      <span className="font-medium" data-hosted-countdown>
        {hostingBannerText(hosting.until, nowMs)}
      </span>
      <span className="text-xs text-muted-fg">
        sandbox kept alive for previews ({hosting.ports.length} mapped port
        {hosting.ports.length === 1 ? "" : "s"})
      </span>
      <span className="flex-1" />
      {hosting.extendable ? (
        <Button
          variant="secondary"
          size="sm"
          loading={extending}
          disabled={stopping}
          onClick={() => void extend()}
          data-hosted-extend
        >
          +{HOSTING_EXTEND_QUICK_MINUTES}m
        </Button>
      ) : null}
      {confirming ? (
        <>
          <span className="text-xs text-muted-fg">Destroy the sandbox now?</span>
          <Button variant="danger" size="sm" loading={stopping} onClick={() => void stop()}>
            {stopping ? "Stopping…" : "Confirm stop"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(false)}
            disabled={stopping}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="border-danger/40 text-danger hover:bg-danger-subtle"
          disabled={extending}
          onClick={() => setConfirming(true)}
          data-hosted-stop
        >
          Stop hosting
        </Button>
      )}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}
