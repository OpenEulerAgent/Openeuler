"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { getStoredToken, authorizationHeaderValue } from "@/lib/token";
import {
  buildPreviewUrl,
  DECLARE_PORT_HINT,
  defaultPreviewPort,
  isPreviewPortSelectable,
  PREVIEW_IFRAME_SANDBOX,
  PREVIEW_POLL_INTERVAL_MS,
  PREVIEW_PROBE_TIMEOUT_MS,
  previewPillMeta,
  previewStateAfterProbe,
  showTerminalPreviewNote,
  type PreviewPortView,
  type PreviewState,
} from "@/lib/preview";

/**
 * The run detail **Preview** tab (#109): port-selector chips over a lazily
 * mounted iframe through the daemon's same-origin preview proxy
 * (`/previews/:runId/:port/*`, #108). Mounting IS activation — the run
 * detail only renders this component while the tab is active, so the frame
 * and the HEAD reachability poll start on selection and stop (interval +
 * in-flight abort) on leaving the tab or unmount.
 */
export function PreviewTab({
  runId,
  ports,
  terminal,
}: {
  runId: string;
  /** Port views from `GET /api/runs/:id` (#107); empty renders the empty state. */
  ports: PreviewPortView[];
  /** True once the run reached a terminal status (sandbox gone with it). */
  terminal: boolean;
}) {
  const [selected, setSelected] = useState<number | null>(() => defaultPreviewPort(ports));
  const [reloadKey, setReloadKey] = useState(0);
  const [probeNonce, setProbeNonce] = useState(0);
  const [state, setState] = useState<PreviewState>("connecting");

  // A refreshed detail can drop a port; fall back rather than frame a ghost.
  const tracked =
    selected !== null && ports.some((port) => port.container === selected)
      ? selected
      : defaultPreviewPort(ports);

  const token = getStoredToken();
  const previewUrl = tracked === null ? null : buildPreviewUrl(runId, tracked, token);
  const authHeader = authorizationHeaderValue(token);

  // Reachability pill: one immediate HEAD through the proxy (aborted after
  // 3s) and a re-probe every 5s while mounted. Any answer maps through
  // previewStateAfterProbe; network/abort failures are "lost".
  useEffect(() => {
    if (previewUrl === null) return;
    let cancelled = false;
    let inFlight: AbortController | null = null;
    const probe = async (): Promise<void> => {
      inFlight = new AbortController();
      const timeout = setTimeout(() => inFlight?.abort(), PREVIEW_PROBE_TIMEOUT_MS);
      try {
        // The probe authenticates with the Authorization header — fetch can
        // set one (unlike the iframe), and the daemon honors ?token= on GET
        // only (#92), so a HEAD would 401 in auth mode without the header.
        const response = await fetch(previewUrl, {
          method: "HEAD",
          cache: "no-store",
          ...(authHeader === undefined ? {} : { headers: { Authorization: authHeader } }),
          signal: inFlight.signal,
        });
        if (!cancelled) setState(previewStateAfterProbe(response.ok));
      } catch {
        if (!cancelled) setState("lost");
      } finally {
        clearTimeout(timeout);
        inFlight = null;
      }
    };
    void probe();
    const poll = setInterval(() => void probe(), PREVIEW_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
      inFlight?.abort();
    };
  }, [previewUrl, authHeader, probeNonce]);

  const selectPort = (container: number): void => {
    if (container === tracked) return;
    setSelected(container);
    setState("connecting");
  };

  const retry = (): void => {
    setState("connecting");
    // Re-runs the probe effect: immediate probe + a fresh poll interval.
    setProbeNonce((nonce) => nonce + 1);
  };

  const openInNewTab = (): void => {
    if (previewUrl === null) return;
    // Absolute from location.origin: next.config proxies /previews onto the
    // daemon, so the same-origin URL (token included) works in any tab.
    const absolute = `${window.location.origin}${previewUrl}`;
    // Open synchronously (keeps the user-gesture for popup blockers), then
    // copy the URL — the clipboard is best-effort.
    window.open(absolute, "_blank", "noopener,noreferrer");
    try {
      void navigator.clipboard.writeText(absolute).then(undefined, () => undefined);
    } catch {
      // Clipboard unavailable (permissions, insecure context) — the tab
      // still opened; the URL is visible in its address bar.
    }
  };

  const pill = previewPillMeta(state);

  return (
    <div className="flex flex-col gap-3" data-preview-tab>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Preview ports">
        {ports.map((port) => {
          const selectable = isPreviewPortSelectable(port);
          const active = tracked === port.container;
          return (
            <button
              key={port.container}
              type="button"
              disabled={!selectable}
              aria-pressed={active}
              data-preview-chip={port.container}
              data-declared={port.declared ? "true" : "false"}
              title={
                selectable
                  ? port.host !== undefined
                    ? `container :${port.container} → host :${port.host}`
                    : `container port :${port.container}`
                  : (port.hint ?? DECLARE_PORT_HINT)
              }
              onClick={() => selectPort(port.container)}
              className={cn(
                "rounded-md px-2.5 py-1 font-mono text-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                "disabled:cursor-not-allowed disabled:opacity-50",
                active
                  ? "bg-accent text-accent-fg"
                  : "border border-border bg-surface text-fg hover:bg-elevated",
              )}
            >
              :{port.container}
              {port.declared ? null : <span> — detected</span>}
            </button>
          );
        })}
      </div>

      {/* Terminal teardown (#109): hosted sandboxes land with the next
          issue; until then previews die with the run's sandbox. */}
      {showTerminalPreviewNote({ terminal, ports }) ? (
        <p
          className="rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-warning"
          data-preview-terminal-note
        >
          Run finished — sandbox closed; declare hosting (next issue) to keep previews alive
        </p>
      ) : null}

      {previewUrl === null ? (
        <div data-preview-empty>
          <EmptyState
            title="Nothing to preview yet"
            description="Declare container ports when starting the run (ports: [3000, …]) to publish them from its sandbox. Ports your agents print while working are detected automatically and listed here — declare one on a future run to preview it."
          />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={pill.variant} title={pill.title} data-preview-state={state}>
              {pill.label}
            </Badge>
            {state === "lost" ? (
              <Button variant="secondary" size="sm" onClick={retry}>
                Retry
              </Button>
            ) : null}
            <span className="flex-1" />
            {/* Re-keying the iframe forces a clean reload of the previewed
                app without touching the run or the poll. */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReloadKey((key) => key + 1)}
              data-preview-reload
            >
              Reload
            </Button>
            <Button variant="secondary" size="sm" onClick={openInNewTab}>
              Open in new tab
            </Button>
          </div>

          <iframe
            key={`${tracked}-${reloadKey}`}
            src={previewUrl}
            title={`Live preview of port ${tracked} (run ${runId})`}
            sandbox={PREVIEW_IFRAME_SANDBOX}
            data-preview-frame
            className="h-[540px] w-full rounded-lg border border-border bg-surface"
          />
          <p className="text-xs text-muted-fg">
            Proxied live from the run&rsquo;s sandbox — reloading the frame never interrupts the
            run.
          </p>
        </>
      )}
    </div>
  );
}
