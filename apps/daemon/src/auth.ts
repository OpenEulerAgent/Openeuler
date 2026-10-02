import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./app.js";
import { HttpError } from "./errors.js";
import type { Logger } from "./logger.js";

/**
 * Opt-in bearer-token auth (#92): when `OPENEULER_TOKEN` is set, every
 * `/api/*` route requires `Authorization: Bearer <token>`; unset means open
 * mode (local dev). `/health` stays open but answers with a minimal payload
 * (see `minimalHealthPayload`), and `GET /api/system/auth-status` stays open
 * so the web app can discover the mode before it has a token.
 */

/** Env var that enables auth mode; empty/whitespace counts as unset. */
export const AUTH_TOKEN_ENV = "OPENEULER_TOKEN";

/** The one open `/api` route: lets the web render its token gate proactively. */
export const AUTH_STATUS_PATH = "/api/system/auth-status";

/**
 * Streaming / scrape routes: the SSE endpoints, the (v0.2) preview streams
 * and the Prometheus scrape endpoint. Originally defined for the `?token=`
 * fallback below; also reused by the rate limiter (#97), which exempts these
 * long-lived connections from request buckets, and by the payload cap,
 * which never inspects them.
 */
export const STREAM_ROUTE_PATTERNS: readonly RegExp[] = [
  // Global run-status stream (#51).
  /^\/api\/runs\/stream$/,
  // Per-run event stream (replay + tail).
  /^\/api\/runs\/[^/]+\/events$/,
  // Live preview streams (v0.2; matched ahead of the route landing). The
  // query-token fallback below stays GET-scoped (see acceptsQueryToken);
  // widening these exemptions beyond GET must be justified by M7.
  /^\/(api\/)?previews(\/|$)/,
  // Prometheus scrape endpoint (#94): GET-only, sits outside `/api`; many
  // scraper configs cannot set headers, so it takes `?token=` like SSE.
  /^\/metrics$/,
];

/**
 * `GET` routes that may authenticate via `?token=` — the header-less
 * fallback, primarily because `EventSource` cannot set headers (SSE/streaming
 * routes), plus the read-only `/metrics` scrape endpoint for Prometheus
 * setups that cannot send headers. Every other route ignores query tokens.
 * The tradeoff: the token lands in access logs and proxies between browser
 * and daemon — acceptable on a LAN, which is what this auth mode protects.
 */
const QUERY_TOKEN_PATH_PATTERNS: readonly RegExp[] = STREAM_ROUTE_PATTERNS;

/** Whether a request may authenticate via `?token=` (GET streaming routes only). */
export function acceptsQueryToken(method: string, path: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  return QUERY_TOKEN_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** Reads + trims {@link AUTH_TOKEN_ENV}; empty/whitespace counts as unset. */
export function resolveAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[AUTH_TOKEN_ENV];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Constant-time token equality: both sides are sha256-hashed first so
 * `timingSafeEqual` always sees equal-length buffers (a raw compare would
 * throw on length mismatch, and the length itself would leak timing).
 */
export function tokensMatch(expected: string, presented: string): boolean {
  const hash = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(hash(expected), hash(presented));
}

/** Parses an `Authorization: Bearer <token>` header; null when the header is present but malformed. */
export function bearerFromHeader(header: string | undefined): string | undefined | null {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Replaces any `token=` query param value with `[redacted]` — applied to
 * everything the daemon logs from a request URL so SSE query tokens never
 * reach the logs.
 */
export function redactTokenQuery(url: string): string {
  return url.replace(/([?&])token=[^&]*/gi, "$1token=[redacted]");
}

export interface AuthMiddlewareOptions {
  /** The configured token; already resolved (non-empty). */
  token: string;
  /** Structured logging of rejects — never includes the presented token. */
  logger?: Logger;
}

/**
 * Middleware guarding every `/api/*` route (mounted under `/api/*`). Order:
 * open auth-status → `Authorization: Bearer` (timing-safe) → `?token=` on
 * GET streaming routes only → 401 `UNAUTHORIZED`. Rejections are logged
 * with the (redacted) path only.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler<AppEnv> {
  const { token, logger } = options;
  return async (c, next) => {
    if (c.req.path === AUTH_STATUS_PATH) return next();

    const headerToken = bearerFromHeader(c.req.header("Authorization"));
    if (typeof headerToken === "string" && tokensMatch(token, headerToken)) return next();

    // Header-less fallback for EventSource, scoped to GET streaming routes.
    // A present-but-wrong (or malformed, e.g. Basic) Authorization header
    // must NOT fall through to the query param — only a truly absent
    // header may.
    if (headerToken === undefined && acceptsQueryToken(c.req.method, c.req.path)) {
      const queryToken = c.req.query("token");
      if (queryToken !== undefined && queryToken !== "" && tokensMatch(token, queryToken)) {
        return next();
      }
    }

    logger?.info(
      { method: c.req.method, url: redactTokenQuery(c.req.url) },
      "unauthorized request",
    );
    throw new HttpError(401, "UNAUTHORIZED", "missing or invalid bearer token");
  };
}
