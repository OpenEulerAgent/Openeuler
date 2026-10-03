import type { Run } from "@openeuler/core";
import { TERMINAL_RUN_STATUSES } from "@openeuler/core";
import type { RunSandboxInfo } from "./executor.js";

/**
 * Preview proxy (#108): stream-`fetch` reverse proxy from
 * `/{api/}previews/:runId[/:port]/*` to the run's live sandbox port.
 *
 * Port resolution order (path form wins):
 *
 * 1. `/previews/:runId/:port/*` — the canonical v0.2 form; the port rides
 *    the path so relative subresource links keep working (query params are
 *    lost by naive relative links).
 * 2. `?port=` query param — the iframe convention; every subresource must
 *    re-append it (documented caveat).
 * 3. The run's first **declared** port.
 *
 * Only declared ports are proxied (the v0.2 publish cut, #107): anything
 * else answers 403 with the declare-to-preview hint. WebSocket upgrades are
 * a documented best-effort cut — plain HTTP methods only.
 */

/** Default window for connect+response headers before the proxy gives up. */
export const DEFAULT_PREVIEW_CONNECT_TIMEOUT_MS = 10_000;
/**
 * Pragmatic overall cap per proxied request (connect + headers + full body
 * stream): the ideal split (10s connect / 60s idle between body chunks)
 * needs undici dispatcher knobs the global `fetch` does not expose, so a
 * single 120s ceiling bounds every phase instead.
 */
export const DEFAULT_PREVIEW_OVERALL_TIMEOUT_MS = 120_000;

/** Hint text for the 502 body when the sandbox port cannot be reached. */
export const PREVIEW_UNAVAILABLE_HINT =
  "the sandbox app may have crashed or not started listening yet — check GET /api/runs/<runId> (sandbox status + ports) and the run's sandbox.log events; the port mapping lives only while the sandbox runs";

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1 + the HTTP/1.1 connection set) that
 * must never be forwarded in either direction; `host` is dropped from
 * requests because `fetch` sets it from the target URL.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Header names additionally named by a `Connection:` header value. */
function connectionNamedHeaders(headers: Headers): Set<string> {
  const named = new Set<string>();
  const connection = headers.get("connection");
  if (connection === null) return named;
  for (const token of connection.split(",")) {
    const name = token.trim().toLowerCase();
    if (name.length > 0) named.add(name);
  }
  return named;
}

/**
 * Copies headers minus hop-by-hop (plus anything the `Connection` header
 * names) for forwarding. Requests additionally drop `host` (fetch sets it
 * from the target URL). Multi-value `set-cookie` survives via
 * `getSetCookie()` appends.
 */
export function forwardableHeaders(source: Headers, kind: "request" | "response"): Headers {
  const skip = connectionNamedHeaders(source);
  const out = new Headers();
  for (const [name, value] of source.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (kind === "request" && lower === "host") continue;
    if (skip.has(lower)) continue;
    if (lower === "set-cookie") continue; // re-added individually below
    out.set(name, value);
  }
  const cookies = source.getSetCookie?.() ?? [];
  for (const cookie of cookies) out.append("set-cookie", cookie);
  return out;
}

/** Outcome of resolving a preview request onto a sandbox host port. */
export type PreviewResolution =
  | { outcome: "run_not_found" }
  | { outcome: "gone"; terminal: boolean; status: Run["status"] }
  | { outcome: "invalid_port"; raw: string }
  | { outcome: "no_ports"; detected: readonly number[] }
  | { outcome: "not_declared"; containerPort: number }
  | { outcome: "unmapped"; containerPort: number }
  | { outcome: "ok"; containerPort: number; hostPort: number };

const isTerminalStatus = (status: Run["status"]): boolean =>
  (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

/**
 * Pure resolution: `(run, live sandbox, explicit port?)` → what the route
 * should do. Precedence: no sandbox (410) first — declaring ports cannot
 * revive a finished run — then the explicit port (validated, declared-only),
 * then the first declared port, then the no-ports/403-with-hint paths.
 * `unmapped` = declared + live sandbox whose `hostPorts()` no longer lists
 * the mapping (container stopping/exited).
 */
export function resolvePreviewTarget(
  run: Run | undefined,
  sandbox: RunSandboxInfo | undefined,
  explicitPort: string | number | undefined,
): PreviewResolution {
  if (run === undefined) return { outcome: "run_not_found" };
  if (sandbox === undefined) {
    return { outcome: "gone", terminal: isTerminalStatus(run.status), status: run.status };
  }
  const declared = run.ports ?? [];
  const firstDeclared = declared[0];

  let containerPort: number | undefined;
  if (explicitPort !== undefined) {
    const parsed = typeof explicitPort === "number" ? explicitPort : Number(explicitPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { outcome: "invalid_port", raw: String(explicitPort) };
    }
    containerPort = parsed;
  } else if (firstDeclared !== undefined) {
    containerPort = firstDeclared;
  } else {
    return { outcome: "no_ports", detected: run.detectedPorts ?? [] };
  }

  if (!declared.includes(containerPort)) return { outcome: "not_declared", containerPort };
  const view = sandbox.ports?.find((port) => port.container === containerPort);
  if (view === undefined || view.host === undefined) {
    return { outcome: "unmapped", containerPort };
  }
  return { outcome: "ok", containerPort, hostPort: view.host };
}

/** One `/previews` path split into its (decoded) run, optional port and subpath. */
export interface ParsedPreviewPath {
  /** Percent-decoded run id. */
  runId: string;
  /** Raw digit segment when the canonical `/previews/:runId/:port/*` form is used. */
  explicitPort?: string;
  /** Percent-ENCODED subpath to forward (never decoded — no smuggling). */
  subPath: string;
}

/**
 * Splits a request pathname (percent-encoded, straight from `new URL()`)
 * into `{runId, explicitPort?, subPath}`. Accepts both mounts
 * (`/previews/…` and `/api/previews/…`). Returns `undefined` for a path
 * outside both mounts and `"malformed"` for undecodable run ids. All-digit
 * first segments parse as the port (path form wins by construction — the
 * caller only consults `?port=` when it is absent).
 */
export function parsePreviewPath(pathname: string): ParsedPreviewPath | "malformed" | undefined {
  const prefix = pathname.startsWith("/api/") ? "/api/previews" : "/previews";
  if (!pathname.startsWith(`${prefix}/`)) return undefined;
  const rest = pathname.slice(prefix.length + 1); // "<runId>[/<sub>…]"
  const slash = rest.indexOf("/");
  const runIdEncoded = slash === -1 ? rest : rest.slice(0, slash);
  let runId: string;
  try {
    runId = decodeURIComponent(runIdEncoded);
  } catch {
    return "malformed";
  }
  const tail = slash === -1 ? "" : rest.slice(slash + 1);
  if (tail === "") return { runId, subPath: "" };

  const segEnd = tail.indexOf("/");
  const seg = segEnd === -1 ? tail : tail.slice(0, segEnd);
  const afterSeg = segEnd === -1 ? "" : tail.slice(segEnd + 1);
  if (/^\d+$/.test(seg)) return { runId, explicitPort: seg, subPath: afterSeg };
  return { runId, subPath: tail };
}

/**
 * Removes the proxy's own query params (`token`, `port`) from a raw search
 * string before forwarding. Names are compared AFTER percent-decoding — a
 * `?%74oken=` form decodes to `token` and must be stripped too, or the
 * daemon token would reach the sandbox app's logs. Everything else
 * round-trips byte-identical per pair (no full URLSearchParams round-trip —
 * it would rewrite `%20` to `+`). Returns "" or "?…" (with the leading `?`
 * when non-empty).
 */
export function forwardableSearch(search: string): string {
  if (search === "") return "";
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const kept = raw.split("&").filter((pair) => {
    const eq = pair.indexOf("=");
    const encodedName = eq === -1 ? pair : pair.slice(0, eq);
    try {
      return !["token", "port"].includes(decodeURIComponent(encodedName).toLowerCase());
    } catch {
      return true; // undecodable names are not ours — forward untouched
    }
  });
  return kept.length === 0 ? "" : `?${kept.join("&")}`;
}

/** The synthesized 502 body when the sandbox port cannot be reached. */
export interface PreviewUnavailableDetails {
  runId: string;
  containerPort: number;
  hostPort: number;
  reason: string;
  hint: string;
}

/** Builds the JSON 502 response for an unreachable sandbox port. */
export function previewUnavailableResponse(details: PreviewUnavailableDetails): Response {
  const body = {
    error: {
      code: "PREVIEW_UPSTREAM_UNAVAILABLE",
      message: `preview target for run ${details.runId} (container port ${details.containerPort} → host port ${details.hostPort}) is unreachable: ${details.reason}`,
      details: { ...details },
    },
  };
  return new Response(JSON.stringify(body), {
    status: 502,
    headers: { "content-type": "application/json" },
  });
}

/** The upstream request the proxy service should perform. */
export interface PreviewProxyRequest {
  runId: string;
  containerPort: number;
  hostPort: number;
  method: string;
  /** Target path+query, already encoded and scrubbed; fetches `http://127.0.0.1:<hostPort><path>`. */
  targetPath: string;
  /** Original request headers; hop-by-hop is stripped inside. */
  headers: Headers;
  /** Request body stream, forwarded as-is (duplex half). */
  body: ReadableStream<Uint8Array> | null;
  /** Client-disconnect signal, composed into the upstream abort. */
  clientSignal?: AbortSignal;
}

export interface PreviewProxyOptions {
  /** Connect+headers window. Default {@link DEFAULT_PREVIEW_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** Overall per-request cap. Default {@link DEFAULT_PREVIEW_OVERALL_TIMEOUT_MS}. */
  overallTimeoutMs?: number;
}

export interface PreviewProxy {
  /** Streams one request to the sandbox port and back; NEVER throws — failures become 502 responses. */
  proxy(request: PreviewProxyRequest): Promise<Response>;
}

const describeProxyError = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

/**
 * The streaming proxy itself: one `fetch` per request with bodies streamed
 * both ways (no buffering, no content-length recompute), hop-by-hop headers
 * stripped in both directions, `redirect: "manual"` so app redirects pass
 * through for the iframe to follow (link rewriting is a documented cut).
 * Failures (connection refused, timeout, mid-flight abort) synthesize the
 * actionable 502 body instead of throwing.
 */
export function createPreviewProxy(options: PreviewProxyOptions = {}): PreviewProxy {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_PREVIEW_CONNECT_TIMEOUT_MS;
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_PREVIEW_OVERALL_TIMEOUT_MS;

  return {
    async proxy(request) {
      const { method, hostPort, targetPath } = request;
      const url = `http://127.0.0.1:${hostPort}${targetPath}`;
      const body =
        request.body !== null && method !== "GET" && method !== "HEAD" ? request.body : null;
      const headers = forwardableHeaders(request.headers, "request");

      // Connect guard: abort unless response headers arrive in time; the
      // overall cap (AbortSignal.timeout) bounds headers + body streaming.
      const connectController = new AbortController();
      let headersArrived = false;
      const connectTimer = setTimeout(() => {
        if (!headersArrived) connectController.abort();
      }, connectTimeoutMs);
      connectTimer.unref?.();
      const signals = [connectController.signal, AbortSignal.timeout(overallTimeoutMs)];
      if (request.clientSignal !== undefined) signals.push(request.clientSignal);
      const signal = AbortSignal.any(signals);

      const unavailable = (reason: string): Response =>
        previewUnavailableResponse({
          runId: request.runId,
          containerPort: request.containerPort,
          hostPort: request.hostPort,
          reason,
          hint: PREVIEW_UNAVAILABLE_HINT,
        });

      try {
        const upstream = await fetch(url, {
          method,
          headers,
          ...(body === null ? {} : { body, duplex: "half" as const }),
          redirect: "manual",
          signal,
        });
        headersArrived = true;
        const responseHeaders = forwardableHeaders(upstream.headers, "response");
        // Bodies on bodyless statuses (204/205/304) are illegal in a
        // Response constructor — a misbehaving upstream sending one gets it
        // dropped, not a crash.
        const bodyless =
          upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
        if (bodyless && upstream.body !== null) {
          await upstream.body.cancel();
        }
        const responseBody = bodyless ? null : upstream.body;
        try {
          return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
        } catch {
          return unavailable(`upstream returned a malformed status (${upstream.status})`);
        }
      } catch (err) {
        headersArrived = true;
        if (connectController.signal.aborted) {
          return unavailable(
            `did not respond within ${connectTimeoutMs}ms (connect/headers timeout)`,
          );
        }
        const aborted = err instanceof Error && err.name === "AbortError";
        const reason = aborted
          ? `exceeded the ${overallTimeoutMs}ms overall cap`
          : describeProxyError(err);
        return unavailable(reason);
      } finally {
        clearTimeout(connectTimer);
      }
    },
  };
}
