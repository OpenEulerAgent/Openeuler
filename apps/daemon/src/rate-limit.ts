import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./app.js";
import { STREAM_ROUTE_PATTERNS } from "./auth.js";
import { HttpError } from "./errors.js";
import type { Logger } from "./logger.js";

/**
 * Per-IP token-bucket rate limiting (#97), applied to `/api/*` only.
 *
 * Requests are classified into route classes with independent buckets keyed
 * `class:ip`:
 *
 * - `mutate` — POST/PUT/PATCH/DELETE on `/api/*`. Default 120 req/min with
 *   an instantaneous burst of 30 (`RATE_LIMIT_MUTATE`).
 * - `read` — GET/HEAD/OPTIONS on `/api/*`. Default 600 req/min
 *   (`RATE_LIMIT_READ`); the bucket capacity equals the per-minute rate.
 * - `stream` — SSE/stream routes + `/metrics` (see
 *   {@link STREAM_ROUTE_PATTERNS}): **exempt** — long-lived connections and
 *   scrapes must not be shed by request counters.
 * - `other` — everything outside `/api/*` (`/health`, `/metrics`, docs):
 *   exempt; `/health` stays cheap and unauthenticated.
 *
 * A limit of `0` disables that class. When a bucket is empty the middleware
 * answers `429 {"error":{"code":"RATE_LIMITED"}}` with a `Retry-After`
 * (seconds until the next token) and `X-RateLimit-Remaining: 0`; allowed
 * requests carry `X-RateLimit-Remaining` with the tokens left after the
 * request.
 *
 * The client IP comes from the socket's remote address
 * (`@hono/node-server` conn info on `c.env`). `X-Forwarded-For` is honored
 * **only** when `TRUST_PROXY=1` — enable it solely behind a reverse proxy
 * you control, otherwise any client can spoof its bucket key (and bypass
 * shared limits by rotating the header). When trusted, the **rightmost**
 * hop is used: append-style proxies prepend spoofed client hops, so only
 * the hop appended by our own nearest proxy is trustworthy — and only under
 * the single-trusted-proxy-tier assumption documented at {@link clientIp}.
 * When no address is known (e.g. in-process `app.request` tests) all
 * callers share the `unknown` bucket.
 */

export const RATE_LIMIT_MUTATE_ENV = "RATE_LIMIT_MUTATE";
export const RATE_LIMIT_READ_ENV = "RATE_LIMIT_READ";
export const TRUST_PROXY_ENV = "TRUST_PROXY";

export const DEFAULT_RATE_LIMIT_MUTATE = 120;
export const DEFAULT_RATE_LIMIT_READ = 600;
/** Instantaneous mutate burst; capacity is `min(burst, per-minute rate)`. */
export const DEFAULT_MUTATE_BURST = 30;

export type RouteClass = "mutate" | "read" | "stream" | "other";

/** Whether a path belongs to a streaming/scrape route (exempt from limits and body caps). */
export function isStreamRoute(path: string): boolean {
  return STREAM_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}

/** Maps a request onto its rate-limit route class (see module docs). */
export function classifyRequest(method: string, path: string): RouteClass {
  if (isStreamRoute(path)) return "stream";
  if (path !== "/api" && !path.startsWith("/api/")) return "other";
  return method === "GET" || method === "HEAD" || method === "OPTIONS" ? "read" : "mutate";
}

/** Per-minute limits resolved from env; integers >= 0 pass through (0 = disabled), anything else falls back. */
export function resolveRateLimits(env: NodeJS.ProcessEnv = process.env): {
  mutatePerMin: number;
  readPerMin: number;
} {
  return {
    mutatePerMin: parsePerMinute(env[RATE_LIMIT_MUTATE_ENV], DEFAULT_RATE_LIMIT_MUTATE),
    readPerMin: parsePerMinute(env[RATE_LIMIT_READ_ENV], DEFAULT_RATE_LIMIT_READ),
  };
}

function parsePerMinute(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * `X-Forwarded-For` is trusted only for the literal value `1` — an
 * unambiguous opt-in, never a default, because trusting it on a direct
 * exposure lets clients pick their own bucket key.
 */
export function resolveTrustProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TRUST_PROXY_ENV]?.trim() === "1";
}

/** Conn-info shape injected by `@hono/node-server` (`{ incoming, outgoing }`). */
interface ConnBindings {
  incoming?: { socket?: { remoteAddress?: string } };
  server?: ConnBindings;
}

function remoteAddress(c: Context<AppEnv>): string | undefined {
  const env = c.env as ConnBindings | undefined;
  const bindings = env?.server ?? env;
  const address = bindings?.incoming?.socket?.remoteAddress;
  return address !== undefined && address.length > 0 ? address : undefined;
}

/**
 * Bucket key for a request: the socket remote address, or the **rightmost**
 * `X-Forwarded-For` hop when {@link resolveTrustProxy} is on. Append-style
 * proxies add the real client last, so the rightmost hop is the one our own
 * nearest proxy attests — everything to its left is client-controlled and
 * rotatable. This assumes a single trusted proxy tier (the proxy both strips
 * inbound `X-Forwarded-For` and appends the true client); with multiple
 * chained proxies, count and skip that many hops from the right instead.
 * Falls back to `unknown` when neither is available (unit tests via
 * `app.request`).
 */
export function clientIp(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for");
    const rightmost = forwarded?.split(",").pop()?.trim();
    if (rightmost !== undefined && rightmost.length > 0) return rightmost;
  }
  return remoteAddress(c) ?? "unknown";
}

export interface BucketConfig {
  /** Bucket capacity = the instantaneous burst size. */
  capacity: number;
  /** Continuous refill rate in tokens per second (per-minute rate / 60). */
  refillPerSec: number;
}

export interface BucketDecision {
  allowed: boolean;
  /** Whole tokens left after this request (0 when rejected). */
  remaining: number;
  /** Seconds until one token refills (0 when allowed). */
  retryAfterSec: number;
}

interface Bucket {
  tokens: number;
  lastMs: number;
}

/**
 * In-memory token-bucket store. `take` refills continuously based on the
 * caller-supplied clock so tests can drive time explicitly. Memory stays
 * bounded: at most `maxKeys` entries, least-recently-touched evicted first
 * (Map insertion order doubles as the touch order), plus a `sweep` for idle
 * buckets (fully refilled long before the TTL expires for any sane config).
 */
export class TokenBucketStore {
  readonly maxKeys: number;
  readonly idleTtlMs: number;
  #buckets = new Map<string, Bucket>();

  constructor(options: { maxKeys?: number; idleTtlMs?: number } = {}) {
    this.maxKeys = options.maxKeys ?? 10_000;
    this.idleTtlMs = options.idleTtlMs ?? 10 * 60_000;
  }

  get size(): number {
    return this.#buckets.size;
  }

  take(key: string, config: BucketConfig, nowMs: number): BucketDecision {
    const existing = this.#buckets.get(key);
    let tokens: number;
    if (existing === undefined) {
      while (this.#buckets.size >= this.maxKeys) {
        const oldest = this.#buckets.keys().next().value;
        if (oldest === undefined) break;
        this.#buckets.delete(oldest);
      }
      tokens = config.capacity;
    } else {
      const elapsedSec = Math.max(0, nowMs - existing.lastMs) / 1000;
      tokens = Math.min(config.capacity, existing.tokens + elapsedSec * config.refillPerSec);
      this.#buckets.delete(key);
    }
    if (tokens >= 1) {
      const remaining = tokens - 1;
      this.#buckets.set(key, { tokens: remaining, lastMs: nowMs });
      return { allowed: true, remaining: Math.floor(remaining), retryAfterSec: 0 };
    }
    this.#buckets.set(key, { tokens, lastMs: nowMs });
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / config.refillPerSec)),
    };
  }

  /** Drops buckets idle longer than the TTL (a full refill takes far less); returns how many went. */
  sweep(nowMs: number): number {
    let removed = 0;
    for (const [key, bucket] of this.#buckets) {
      if (nowMs - bucket.lastMs > this.idleTtlMs) {
        this.#buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

export interface RateLimitOptions {
  /** Per-minute caps per class; 0 disables that class. */
  config: { mutatePerMin: number; readPerMin: number };
  /** Instantaneous mutate burst; default {@link DEFAULT_MUTATE_BURST}, clamped to the per-minute rate. */
  mutateBurst?: number;
  /** Injectable store/clock for tests. */
  store?: TokenBucketStore;
  now?: () => number;
  /** Whether `X-Forwarded-For` supplies the client IP (see {@link clientIp}). */
  trustProxy?: boolean;
  /** Sweep interval for idle buckets; default 60s. */
  sweepIntervalMs?: number;
  logger?: Logger;
}

export function createRateLimitMiddleware(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const { config, store = new TokenBucketStore(), now = Date.now, logger } = options;
  const mutate: BucketConfig | undefined =
    config.mutatePerMin > 0
      ? {
          capacity: Math.max(
            1,
            Math.min(options.mutateBurst ?? DEFAULT_MUTATE_BURST, config.mutatePerMin),
          ),
          refillPerSec: config.mutatePerMin / 60,
        }
      : undefined;
  const read: BucketConfig | undefined =
    config.readPerMin > 0
      ? { capacity: Math.max(1, config.readPerMin), refillPerSec: config.readPerMin / 60 }
      : undefined;
  if (mutate !== undefined || read !== undefined) {
    const sweeper = setInterval(() => store.sweep(now()), options.sweepIntervalMs ?? 60_000);
    // Never hold the event loop open on its account.
    sweeper.unref?.();
  }
  return async (c, next) => {
    const routeClass = classifyRequest(c.req.method, c.req.path);
    const bucket = routeClass === "mutate" ? mutate : routeClass === "read" ? read : undefined;
    if (bucket === undefined) return next();

    const ip = clientIp(c, options.trustProxy ?? false);
    const decision = store.take(`${routeClass}:${ip}`, bucket, now());
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSec));
      c.header("X-RateLimit-Remaining", "0");
      logger?.info(
        {
          ip,
          routeClass,
          method: c.req.method,
          path: c.req.path,
          retryAfterSec: decision.retryAfterSec,
        },
        "rate limit exceeded",
      );
      throw new HttpError(
        429,
        "RATE_LIMITED",
        `too many ${routeClass} requests from this client; retry after ${decision.retryAfterSec}s`,
      );
    }
    c.header("X-RateLimit-Remaining", String(decision.remaining));
    return next();
  };
}
