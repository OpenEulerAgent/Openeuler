/**
 * Preview-panel helpers (#109): the pure URL/decision layer behind the run
 * detail **Preview** tab. The tab lists a run's port views (`GET
 * /api/runs/:id` → `ports: [{container, host?, declared, hint?}]`, #107),
 * frames the daemon's preview proxy same-origin (`/previews/:runId/:port/*`
 * #108 — next.config rewrites the mount onto the daemon) and tracks
 * reachability with a HEAD poll. Everything here is pure and unit-tested;
 * {@link PreviewTab} owns the effects.
 */

/** One previewable port as served by the run detail payload (#107). */
export interface PreviewPortView {
  /** Container-side port number. */
  container: number;
  /**
   * Ephemeral host port, present only while the run's sandbox lives AND the
   * port is declared (published). Gone with the sandbox.
   */
  host?: number;
  /** True when the port was declared on the run at creation. */
  declared: boolean;
  /** Present when the port cannot be previewed (detected, not declared). */
  hint?: string;
}

/** Connection pill states: probing → answered → unreachable. */
export type PreviewState = "connecting" | "live" | "lost";

/** HEAD-probe abort timeout: a hung proxy must not wedge the pill. */
export const PREVIEW_PROBE_TIMEOUT_MS = 3_000;

/** Reachability re-probe cadence while the Preview tab is active. */
export const PREVIEW_POLL_INTERVAL_MS = 5_000;

/**
 * iframe sandbox for previewed apps (#109). Why each token:
 *
 * - `allow-scripts` — previewed services are real apps (Vite/Next dev
 *   servers, static sites with JS); without scripts nothing renders.
 * - `allow-same-origin` — the proxy is framed same-origin (next.config
 *   rewrite); without this the frame gets an opaque origin and the app's
 *   storage, cookies and relative fetches break.
 * - `allow-forms` — login/search POSTs inside the preview.
 * - `allow-modals` — `alert`/`confirm` from the previewed app surface
 *   in-panel instead of silently dying.
 *
 * Deliberately absent: top navigation and popups — the previewed app stays
 * inside the frame. The trust boundary is the token-gated, run-scoped proxy
 * (#108), not the sandbox attribute.
 */
export const PREVIEW_IFRAME_SANDBOX = "allow-forms allow-scripts allow-same-origin allow-modals";

/** Canonical same-origin proxy URL for one run port. */
export function buildPreviewUrl(runId: string, port: number, token?: string | null): string {
  const base = `/previews/${encodeURIComponent(runId)}/${port}/`;
  const trimmed = token?.trim() ?? "";
  // The stored daemon token (#92) rides as ?token= — an iframe src cannot
  // carry an Authorization header, and the proxy accepts query tokens.
  return trimmed.length > 0 ? `${base}?token=${encodeURIComponent(trimmed)}` : base;
}

/** Fallback tooltip when an undeclared port carries no daemon hint. */
export const DECLARE_PORT_HINT = "declare ports on the run to preview";

/**
 * A port is previewable only when declared (#107 v0.2 cut): detected-but-
 * undeclared ports render as disabled chips carrying their hint.
 */
export function isPreviewPortSelectable(port: PreviewPortView): boolean {
  return port.declared;
}

/**
 * Default chip: the FIRST port with a live host mapping; without mappings
 * (local run, terminal run) the first declared port keeps the tab usable —
 * the poll then reports the honest state (lost / gone). Null when nothing
 * is selectable (only undeclared ports, or none at all).
 */
export function defaultPreviewPort(ports: readonly PreviewPortView[]): number | null {
  const hosted = ports.find((port) => port.host !== undefined);
  if (hosted !== undefined) return hosted.container;
  const declared = ports.find((port) => port.declared);
  return declared !== undefined ? declared.container : null;
}

/** HEAD probe result → pill state (`connecting` is the pre-probe state). */
export function previewStateAfterProbe(reachable: boolean): PreviewState {
  return reachable ? "live" : "lost";
}

/** Pill presentation per {@link PreviewState}. */
export interface PreviewPillMeta {
  label: string;
  variant: "neutral" | "success" | "danger";
  /** Tooltip explaining what the state means. */
  title: string;
}

const PILL_META: Record<PreviewState, PreviewPillMeta> = {
  connecting: {
    label: "Connecting…",
    variant: "neutral",
    title: "probing the run's preview proxy",
  },
  live: { label: "Live", variant: "success", title: "the preview proxy answered" },
  lost: {
    label: "Lost",
    variant: "danger",
    title: "the preview proxy is unreachable — the sandbox may have stopped; retry to re-probe",
  },
};

export function previewPillMeta(state: PreviewState): PreviewPillMeta {
  return PILL_META[state];
}

/**
 * Terminal-run teardown notice (#109): once a run finishes, its sandbox and
 * published ports are gone — the inline note says so when NO port carries a
 * host mapping anymore. Hosted runs (#110) never show it: their sandbox is
 * deliberately alive past success and the hosted banner carries the
 * messaging (expiry countdown + extend/stop).
 */
export function showTerminalPreviewNote(input: {
  terminal: boolean;
  ports: readonly PreviewPortView[];
  /** True while the run's sandbox is hosted past success (#110). */
  hosted?: boolean;
}): boolean {
  if (input.hosted === true) return false;
  return (
    input.terminal && input.ports.length > 0 && input.ports.every((port) => port.host === undefined)
  );
}
