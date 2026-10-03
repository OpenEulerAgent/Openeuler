import { apiFetch } from "./api";

/**
 * Hosted-run helpers (#110): the pure countdown/decision layer behind the
 * run detail's hosted banner, plus the thin API client for the daemon's
 * stop/extend endpoints. The hosting view itself comes from
 * `GET /api/runs/:id` → `hosting: { until, ports: [{container, host}],
 * extendable } | null`.
 */

/** Hosting view as served by the run detail payload (#110). */
export interface RunHostingView {
  /** ISO timestamp the hosted sandbox expires. */
  until: string;
  /** Live container→host mappings while the sandbox is alive. */
  ports: Array<{ container: number; host: number }>;
  /** True while the hosting can be extended (capped 24h from "now"). */
  extendable: boolean;
}

/** Quick-extend minutes offered by the banner's button. */
export const HOSTING_EXTEND_QUICK_MINUTES = 30;

/** Countdown label refresh cadence while the banner is mounted. */
export const HOSTING_COUNTDOWN_TICK_MS = 1_000;

/** Ms remaining before the hosted sandbox expires (negative when past). */
export function hostingRemainingMs(until: string, nowMs: number): number {
  return Date.parse(until) - nowMs;
}

/**
 * Compact countdown label: `<1m` under a minute, `Xm` under an hour,
 * `Xh Ym` beyond (e.g. `42m`, `1h 05m`); `expired` at/past the timestamp.
 */
export function hostingCountdownLabel(until: string, nowMs: number): string {
  const remaining = hostingRemainingMs(until, nowMs);
  if (remaining <= 0) return "expired";
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${String(rest).padStart(2, "0")}m`;
}

/**
 * The hosted banner's headline (#110): "Hosted — preview live · expires
 * in Xm". The live/dead nuance comes from the preview pill, not the
 * banner (the ports view says whether mappings exist).
 */
export function hostingBannerText(until: string, nowMs: number): string {
  return `Hosted — preview live · expires in ${hostingCountdownLabel(until, nowMs)}`;
}

/** True while the row (detail or table) is hosted: `hostedUntil` present. */
export function isRunHosted(run: { hostedUntil?: string }): boolean {
  return run.hostedUntil !== undefined;
}

/** Injectable transport so flows are testable without a browser. */
export type HostingFetcher = typeof apiFetch;

/** Stops a run's hosting now: sandbox destroyed, run stays `success`. */
export async function stopRunHosting(
  runId: string,
  fetcher: HostingFetcher = apiFetch,
): Promise<void> {
  await fetcher(`/api/runs/${encodeURIComponent(runId)}/hosting/stop`, { method: "POST" });
}

/** Extends a hosted run's TTL by whole minutes (capped 24h from now). */
export async function extendRunHosting(
  runId: string,
  minutes: number,
  fetcher: HostingFetcher = apiFetch,
): Promise<RunHostingView> {
  const body = await fetcher<{ hosting: RunHostingView }>(
    `/api/runs/${encodeURIComponent(runId)}/hosting/extend`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes }),
    },
  );
  return body.hosting;
}
