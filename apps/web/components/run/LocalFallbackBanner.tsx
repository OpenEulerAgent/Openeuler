"use client";

import { useEffect, useState } from "react";
import { fetchSandboxStatus, showLocalFallbackBanner, type SandboxStatus } from "@/lib/sandbox-api";

/**
 * "Running locally — Docker unavailable" banner (#106): a run executing
 * locally (no live sandbox info, #102) while its project's policy wants a
 * sandbox and docker is currently unavailable — the auto-mode fallback.
 * Everything else stays quiet, including fetch failures.
 */
export function LocalFallbackBanner({
  projectId,
  sandboxPresent,
  runStatus,
}: {
  projectId: string;
  /** True when the run detail payload carries live sandbox info. */
  sandboxPresent: boolean;
  /** Current run status — the banner only describes EXECUTING runs. */
  runStatus?: string;
}) {
  const [status, setStatus] = useState<SandboxStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSandboxStatus(projectId).then(
      (payload) => {
        if (!cancelled) setStatus(payload);
      },
      () => {
        if (!cancelled) setStatus(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (
    status === null ||
    !showLocalFallbackBanner({
      sandboxPresent,
      projectMode: status.projectMode,
      available: status.available,
      runStatus,
    })
  ) {
    return null;
  }

  return (
    <p
      className="rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-warning"
      data-local-fallback-banner
    >
      Running locally — Docker unavailable
    </p>
  );
}
