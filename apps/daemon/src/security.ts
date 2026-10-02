import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./app.js";
import { HttpError } from "./errors.js";
import { isStreamRoute } from "./rate-limit.js";

/**
 * Hardening middleware (#97): payload caps, the CORS allowlist and security
 * headers. See the "Hardening" notes in README / docs/DEV.md for the env
 * knobs (`MAX_BODY_BYTES`, `FRAME_ANCESTORS`, `PREVIEW_IFRAME`).
 */

/** Default browser origin the web app is served from. */
export const DEFAULT_CORS_ORIGIN = "http://localhost:3000";

/**
 * Parses a `CORS_ORIGIN` value into an exact-match allowlist: comma
 * separated, entries trimmed, empties dropped. A `*` anywhere means "any
 * origin" (hono's wildcard mode) — explicit and loud rather than a mixed
 * list where `*` would silently shadow the rest. An empty value falls back
 * to {@link DEFAULT_CORS_ORIGIN}.
 */
export function parseCorsOrigins(raw: string): string[] {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.includes("*")) return ["*"];
  return parts.length > 0 ? [...new Set(parts)] : [DEFAULT_CORS_ORIGIN];
}

/**
 * Hono `cors` origin setting for an allowlist: a single entry stays a string
 * (hono's exact-match mode, which also keeps `*` wildcard semantics), a
 * list becomes an array (exact match against any entry).
 */
export function corsOriginSetting(origins: readonly string[]): string | string[] {
  return origins.length === 1 ? (origins[0] ?? DEFAULT_CORS_ORIGIN) : [...origins];
}

/** Request-body cap: 1 MiB by default (`MAX_BODY_BYTES`). */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** Integer >= 1 passes through; unset/empty/invalid falls back to the default. */
export function resolveMaxBodyBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_MAX_BODY_BYTES;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_BODY_BYTES;
}

/** Methods whose bodies get measured when Content-Length is absent (hono caches the read; handlers re-parse freely). */
const BODY_MEASURED_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Rejects `/api/*` request bodies larger than the cap with
 * `413 {"error":{"code":"PAYLOAD_TOO_LARGE"}}` — this is what bounds graph
 * PUTs and prompt payloads without per-route code. The cheap path reads the
 * declared `Content-Length`; when it is absent (e.g. chunked or test
 * requests) the body is buffered once via hono's cached body read, so route
 * handlers still see it. Stream routes (SSE, `/metrics`) are exempt — they
 * carry no request bodies.
 */
export function createPayloadCapMiddleware(options: {
  maxBytes: number;
}): MiddlewareHandler<AppEnv> {
  const { maxBytes } = options;
  return async (c, next) => {
    if (isStreamRoute(c.req.path)) return next();
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        `request body of ${declared} bytes exceeds the ${maxBytes} byte limit`,
      );
    }
    if (c.req.header("content-length") === undefined && BODY_MEASURED_METHODS.has(c.req.method)) {
      const body = await c.req.arrayBuffer();
      if (body.byteLength > maxBytes) {
        throw new HttpError(
          413,
          "PAYLOAD_TOO_LARGE",
          `request body of ${body.byteLength} bytes exceeds the ${maxBytes} byte limit`,
        );
      }
    }
    return next();
  };
}

export interface FramePolicy {
  /** Full `Content-Security-Policy` value (only `frame-ancestors` today). */
  contentSecurityPolicy: string;
  /** `X-Frame-Options` value, or undefined when it cannot express the policy (allowlists). */
  xFrameOptions?: string;
}

/**
 * Framing policy resolution (#97):
 *
 * 1. An explicit `FRAME_ANCESTORS` value (env or option) wins — it is used
 *    verbatim as the `frame-ancestors` sources; `X-Frame-Options: DENY` is
 *    only sent when the sources are exactly `'none'` (aligned semantics).
 * 2. Otherwise `PREVIEW_IFRAME=1` (the M7 preview-iframe placeholder)
 *    allows framing by the app itself plus every allowlisted CORS origin —
 *    `X-Frame-Options` is dropped because it cannot express an allowlist.
 * 3. Default: framing denied outright — `frame-ancestors 'none'` +
 *    `X-Frame-Options: DENY`. Nothing legitimately frames the daemon today.
 */
export function resolveFramePolicy(input: {
  frameAncestors?: string;
  previewIframe?: boolean;
  corsOrigins: readonly string[];
}): FramePolicy {
  const explicit = input.frameAncestors?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    const sources = explicit.replace(/^frame-ancestors\s+/i, "");
    return {
      contentSecurityPolicy: `frame-ancestors ${sources}`,
      xFrameOptions: sources === "'none'" ? "DENY" : undefined,
    };
  }
  if (input.previewIframe) {
    const origins = input.corsOrigins.filter((origin) => origin !== "*");
    return {
      contentSecurityPolicy: `frame-ancestors ${["'self'", ...origins].join(" ")}`,
      xFrameOptions: undefined,
    };
  }
  return { contentSecurityPolicy: "frame-ancestors 'none'", xFrameOptions: "DENY" };
}

/** Minimal Permissions-Policy: nothing on the daemon needs device access. */
const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()";

/**
 * Security headers on **every** response (mounted ahead of CORS so even
 * preflight 204s carry them): `X-Content-Type-Options: nosniff`, the
 * {@link FramePolicy} headers, `Referrer-Policy: no-referrer` and the
 * minimal `Permissions-Policy`. `/api/*` responses additionally get
 * `Cache-Control: no-store` — API data must never come from a cache.
 */
export function createSecurityHeadersMiddleware(frame: FramePolicy): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Security-Policy", frame.contentSecurityPolicy);
    if (frame.xFrameOptions !== undefined) headers.set("X-Frame-Options", frame.xFrameOptions);
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Permissions-Policy", PERMISSIONS_POLICY);
    const path = c.req.path;
    // Only when the handler did not choose its own directive (SSE streams
    // deliberately send `no-cache`).
    if ((path === "/api" || path.startsWith("/api/")) && !headers.has("Cache-Control")) {
      headers.set("Cache-Control", "no-store");
    }
  };
}
