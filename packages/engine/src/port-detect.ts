import { MAX_RUN_PORTS } from "@openeuler/core";

/**
 * Pure port detection over agent output text (#107).
 *
 * Scans a step/node's final output for the lines real dev servers print —
 * Next.js (`ready on http://localhost:3000`), Vite (`Local:
 * http://localhost:5173/`), Flask/Uvicorn (`Running on
 * http://127.0.0.1:5000`), Rails/Puma (`Listening on tcp://0.0.0.0:3000`),
 * python `http.server` (`Serving HTTP on 0.0.0.0 port 8000`), Express
 * (`Server listening on port 3000`), `PORT=3000` env lines — and returns the
 * found ports, deduped, in first-seen order, capped at
 * {@link MAX_RUN_PORTS}.
 *
 * False-positive guards:
 * - ports `0`, `80`, `443` are never detected (dates, "HTTP/1.1 80"-style
 *   noise and https URLs make them unusable signals);
 * - a bare `:NNNN` only counts right after serving/running/started;
 * - the generic `port NNNN` phrase requires a 3-5 digit number, so
 *   "serial port 3"-style text never matches;
 * - dates (`2026-10-02`), timestamps (`05:30:44`), exit codes and
 *   port-less URLs match nothing;
 * - bracketed IPv6 hosts (`http://[::1]:5173`, `[::]:3000`) are detected;
 *   a decimal like `3000.5` never matches (the trailing-dot guard only
 *   rejects a digit after the dot, so sentence-ending periods are fine).
 */

/** Ports never reported: too false-positive-prone in real output (#107). */
const EXCLUDED_PORTS = new Set([0, 80, 443]);

/**
 * High-signal patterns: an explicit listen phrase, a `scheme://host:port`
 * URL, a bare `host:port` reference, or a `PORT=` assignment. Any port
 * value 1..65535 (minus {@link EXCLUDED_PORTS}) counts in these contexts.
 */
const STRONG_PATTERNS: RegExp[] = [
  // "listening on :3000" — `(?![\d.])` must not reject a sentence-ending
  // period ("listening on :3000."), only a following digit ("port 30005").
  /\blistening\s+on\s+:(\d{1,5})(?!\d)(?!\.\d)/gi,
  // "listening on port 3000"
  /\blistening\s+on\s+port\s+(\d{1,5})(?!\d)(?!\.\d)/gi,
  // "listening on tcp://0.0.0.0:3000" (Rails/Puma) — the listen phrase plus
  // a tcp URL; captured from the URL tail.
  /\blistening\s+on\s+tcp:\/\/[^\s/:]+:(\d{1,5})(?!\d)(?!\.\d)/gi,
  // "on port 3000" / "server started on port 8080"
  /\bon\s+port\s+(\d{1,5})(?!\d)(?!\.\d)/gi,
  // generic "port NNNN" (python http.server: "Serving HTTP on 0.0.0.0 port
  // 8000") — 3-5 digits only, killing "port 3"/"port 22" noise.
  /\bport\s+(\d{3,5})(?!\d)(?!\.\d)/gi,
  // "http://localhost:3000" / "http://0.0.0.0:8000/" / "http://[::1]:5173/"
  // (Vite IPv6) — any URL with a port; the host part admits bracketed IPv6.
  /\bhttps?:\/\/[^\s/:?#]*(?:\[[^\]]*\])?[^\s/:?#]*:(\d{1,5})(?!\d)/gi,
  // bare "localhost:3000" / "127.0.0.1:5000" / "0.0.0.0:8000" / "[::1]:3000"
  // / "[::]:3000" (Puma IPv6) / any IPv4. No leading \b before the bracket
  // forms — `[` is a non-word char, so \b can never match after a space.
  /(?:\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)|(?:\d{1,3}\.){3}\d{1,3}|\[::1?\]):(\d{1,5})(?!\d)(?!\.\d)/gi,
  // "PORT=3000" / "port=8000" env-style lines (case-insensitive).
  /\bport[=:](\d{1,5})(?!\d)/gi,
];

/**
 * Weak pattern (#107 issue body): a bare `:NNNN` only counts when it
 * directly follows a serving/running/started phrase ("dev server running
 * :3000"). 3-5 digits.
 */
const WEAK_PATTERN = /\b(?:serving|running|started)\s+(?:on\s+)?:(\d{3,5})(?!\d)/gi;

const isValidPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= 65535 && !EXCLUDED_PORTS.has(port);

/**
 * Detects listening ports in one output text: strong contexts first (in
 * pattern order), then the weak `:NNNN`-after-serving/running/started form.
 * Results are re-sorted to true first-appearance order in the text,
 * deduped, capped at {@link MAX_RUN_PORTS}.
 */
export function detectPorts(text: string): number[] {
  const hits: Array<{ index: number; port: number }> = [];
  const seen = new Set<number>();
  for (const pattern of [...STRONG_PATTERNS, WEAK_PATTERN]) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const port = Number.parseInt(raw, 10);
      if (!isValidPort(port) || seen.has(port)) continue;
      seen.add(port);
      hits.push({ index: match.index ?? 0, port });
    }
  }
  return hits
    .sort((a, b) => a.index - b.index)
    .map((hit) => hit.port)
    .slice(0, MAX_RUN_PORTS);
}

/**
 * Merges a run's recorded detected-ports list with newly detected ones
 * (#107): union preserving first-seen order, deduped, capped at
 * {@link MAX_RUN_PORTS}. Pure — the caller persists the result.
 */
export function mergeDetectedPorts(
  current: readonly number[] | undefined,
  newlyDetected: readonly number[],
): number[] {
  const merged: number[] = [];
  const seen = new Set<number>();
  for (const port of [...(current ?? []), ...newlyDetected]) {
    if (seen.has(port)) continue;
    seen.add(port);
    merged.push(port);
  }
  return merged.slice(0, MAX_RUN_PORTS);
}

/**
 * The run's previewable port list in display order (#107): declared ports
 * first (their declaration order — they are the published ones), then
 * detected-but-undeclared ports (detection order), deduped and capped at
 * {@link MAX_RUN_PORTS}. Pure — used by the executor/API view builder.
 */
export function runPortList(
  declared: readonly number[] | undefined,
  detected: readonly number[] | undefined,
): number[] {
  const ordered: number[] = [];
  const seen = new Set<number>();
  for (const port of [...(declared ?? []), ...(detected ?? [])]) {
    if (seen.has(port)) continue;
    seen.add(port);
    ordered.push(port);
  }
  return ordered.slice(0, MAX_RUN_PORTS);
}
