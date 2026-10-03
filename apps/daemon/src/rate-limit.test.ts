import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import {
  classifyRequest,
  clientIp,
  resolveRateLimits,
  resolveTrustProxy,
  TokenBucketStore,
} from "./rate-limit.js";

const build = (
  rateLimit?: { mutatePerMin?: number; readPerMin?: number; mutateBurst?: number },
  extra: { trustProxy?: boolean } = {},
) =>
  createApp({
    logger: createLogger("silent"),
    ...(rateLimit === undefined ? {} : { rateLimit }),
    ...extra,
  });

const errorBody = async (res: Response): Promise<{ code: string }> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error;
};

describe("classifyRequest", () => {
  it("splits /api into mutate/read and exempts streams + non-API paths", () => {
    expect(classifyRequest("POST", "/api/projects")).toBe("mutate");
    expect(classifyRequest("PUT", "/api/workflows/x/graph")).toBe("mutate");
    expect(classifyRequest("PATCH", "/api/projects/x")).toBe("mutate");
    expect(classifyRequest("DELETE", "/api/projects/x")).toBe("mutate");
    expect(classifyRequest("GET", "/api/projects")).toBe("read");
    expect(classifyRequest("HEAD", "/api/projects/x/presets")).toBe("read");
    // Streaming routes and /metrics are exempt regardless of method.
    expect(classifyRequest("GET", "/api/runs/stream")).toBe("stream");
    expect(classifyRequest("GET", "/api/runs/abc/events")).toBe("stream");
    expect(classifyRequest("GET", "/metrics")).toBe("stream");
    expect(classifyRequest("GET", "/previews/abc")).toBe("stream");
    // Outside /api: exempt.
    expect(classifyRequest("POST", "/health")).toBe("other");
    expect(classifyRequest("GET", "/health")).toBe("other");
  });
});

describe("resolveRateLimits / resolveTrustProxy", () => {
  it("defaults to 120/min mutate and 600/min read", () => {
    expect(resolveRateLimits({})).toEqual({ mutatePerMin: 120, readPerMin: 600 });
  });

  it("accepts integers >= 0 and rejects garbage", () => {
    expect(resolveRateLimits({ RATE_LIMIT_MUTATE: "0", RATE_LIMIT_READ: "42" })).toEqual({
      mutatePerMin: 0,
      readPerMin: 42,
    });
    expect(resolveRateLimits({ RATE_LIMIT_MUTATE: "-5", RATE_LIMIT_READ: "abc" })).toEqual({
      mutatePerMin: 120,
      readPerMin: 600,
    });
  });

  it("trusts X-Forwarded-For only for the literal TRUST_PROXY=1", () => {
    expect(resolveTrustProxy({})).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: "0" })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: "true" })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: "1" })).toBe(true);
  });
});

describe("clientIp", () => {
  it("ignores X-Forwarded-For unless trustProxy is set", async () => {
    const { app } = build();
    let seenA: string | undefined;
    let seenB: string | undefined;
    app.get("/ip", (c) => {
      seenA = clientIp(c, false);
      seenB = clientIp(c, true);
      return c.json({ ok: true });
    });
    await app.request("/ip", { headers: { "X-Forwarded-For": "1.2.3.4, 5.6.7.8" } });
    // No socket info under app.request → unknown; trustProxy takes the
    // rightmost hop (the one our own proxy appended).
    expect(seenA).toBe("unknown");
    expect(seenB).toBe("5.6.7.8");
  });
});

describe("TokenBucketStore", () => {
  const bucket = { capacity: 3, refillPerSec: 2 };

  it("allows the burst, then rejects until tokens refill", () => {
    const store = new TokenBucketStore();
    expect(store.take("k", bucket, 0)).toEqual({ allowed: true, remaining: 2, retryAfterSec: 0 });
    expect(store.take("k", bucket, 100)).toEqual({ allowed: true, remaining: 1, retryAfterSec: 0 });
    expect(store.take("k", bucket, 200)).toEqual({ allowed: true, remaining: 0, retryAfterSec: 0 });
    const rejected = store.take("k", bucket, 300);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    expect(rejected.retryAfterSec).toBeGreaterThanOrEqual(1);
    // 500ms at 2 tokens/s refills exactly one token.
    expect(store.take("k", bucket, 800)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("never exceeds capacity no matter how long the idle gap", () => {
    const store = new TokenBucketStore();
    store.take("k", bucket, 0);
    const afterIdle = store.take("k", bucket, 3_600_000);
    expect(afterIdle).toEqual({ allowed: true, remaining: 2, retryAfterSec: 0 });
  });

  it("keys buckets independently", () => {
    const store = new TokenBucketStore();
    store.take("a", { capacity: 1, refillPerSec: 0.001 }, 0);
    expect(store.take("b", { capacity: 1, refillPerSec: 0.001 }, 0).allowed).toBe(true);
    expect(store.take("a", { capacity: 1, refillPerSec: 0.001 }, 1).allowed).toBe(false);
  });

  it("prunes least-recently-touched keys at the max-keys bound", () => {
    const store = new TokenBucketStore({ maxKeys: 2, idleTtlMs: 60_000 });
    const one = { capacity: 1, refillPerSec: 0.001 };
    store.take("a", one, 0);
    store.take("b", one, 1_000);
    store.take("a", one, 2_000); // touch "a" → "b" is now oldest
    store.take("c", one, 3_000); // at capacity → evicts "b"
    expect(store.size).toBe(2);
    expect(store.take("b", one, 3_001).allowed).toBe(true); // fresh bucket again
  });

  it("sweeps idle buckets past the TTL", () => {
    const store = new TokenBucketStore({ idleTtlMs: 1_000 });
    const one = { capacity: 5, refillPerSec: 1 };
    store.take("stale", one, 0);
    store.take("fresh", one, 5_000);
    expect(store.sweep(6_000)).toBe(1);
    expect(store.size).toBe(1);
  });
});

describe("rate limiting middleware", () => {
  it("429s with RATE_LIMITED, Retry-After and remaining headers after the burst", async () => {
    const { app } = build({ mutatePerMin: 3 }); // burst = min(30, 3) = 3
    for (let i = 0; i < 3; i += 1) {
      const res = await app.request("/api/projects", { method: "POST" });
      expect(res.status).not.toBe(429);
      expect(res.headers.get("x-ratelimit-remaining")).toMatch(/^\d+$/);
    }
    const blocked = await app.request("/api/projects", { method: "POST" });
    expect(blocked.status).toBe(429);
    expect(await errorBody(blocked)).toMatchObject({ code: "RATE_LIMITED" });
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(blocked.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(blocked.headers.get("cache-control")).toBe("no-store");
  });

  it("limits read (GET) requests independently of the mutate class", async () => {
    const { app } = build({ readPerMin: 2 });
    expect((await app.request("/api/projects")).status).not.toBe(429);
    expect((await app.request("/api/projects")).status).not.toBe(429);
    expect((await app.request("/api/projects")).status).toBe(429);
    // Mutates fall under the (default, generous) mutate bucket, not the read one.
    expect((await app.request("/api/projects", { method: "POST" })).status).not.toBe(429);
  });

  it("exempts SSE/stream routes and /metrics entirely", async () => {
    const { app } = build({ readPerMin: 1, mutatePerMin: 1 });
    for (let i = 0; i < 5; i += 1) {
      // No db → 503, but never RATE_LIMITED: streams are exempt even when limited hard.
      const global = await app.request("/api/runs/stream");
      expect(global.status).not.toBe(429);
      const perRun = await app.request(`/api/runs/run-${i}/events`);
      expect(perRun.status).not.toBe(429);
      const metrics = await app.request("/metrics");
      expect(metrics.status).toBe(200);
    }
  });

  it("leaves non-/api routes unthrottled", async () => {
    const { app } = build({ readPerMin: 1, mutatePerMin: 1 });
    for (let i = 0; i < 6; i += 1) {
      expect((await app.request("/health")).status).toBe(200);
    }
  });

  it("0 disables a class entirely", async () => {
    const { app } = build({ mutatePerMin: 0, readPerMin: 0 });
    for (let i = 0; i < 40; i += 1) {
      expect((await app.request("/api/projects")).status).not.toBe(429);
    }
  });

  it("buckets per client IP when TRUST_PROXY is enabled", async () => {
    const { app } = build({ mutatePerMin: 1 }, { trustProxy: true });
    // app.request carries no socket info; with trustProxy the rightmost XFF
    // hop (the one our own proxy appended) keys the bucket.
    const a1 = await app.request("/api/projects", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.1" },
    });
    const a2 = await app.request("/api/projects", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.1" },
    });
    const b1 = await app.request("/api/projects", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.2" },
    });
    expect(a1.status).not.toBe(429);
    expect(a2.status).toBe(429);
    expect(b1.status).not.toBe(429);
  });

  it("keys on the rightmost hop, so rotating leftmost hops cannot bypass the bucket", async () => {
    const { app } = build({ mutatePerMin: 1 }, { trustProxy: true });
    // Fixed rightmost (the trusted proxy's attestation), rotating leftmost
    // (client-controlled): same bucket → limited.
    const first = await app.request("/api/projects", {
      method: "POST",
      headers: { "X-Forwarded-For": "1.1.1.1, 10.0.0.9" },
    });
    expect(first.status).not.toBe(429);
    const rotated = await app.request("/api/projects", {
      method: "POST",
      headers: { "X-Forwarded-For": "2.2.2.2, 10.0.0.9" },
    });
    expect(rotated.status).toBe(429);
    // A different rightmost hop is a different proxy-observed client → a
    // fresh bucket.
    const other = await app.request("/api/projects", {
      method: "POST",
      headers: { "X-Forwarded-For": "3.3.3.3, 10.0.0.8" },
    });
    expect(other.status).not.toBe(429);
  });

  it("ignores X-Forwarded-For when TRUST_PROXY is off (shared unknown bucket)", async () => {
    const { app } = build({ mutatePerMin: 1 }, { trustProxy: false });
    const first = await app.request("/api/projects", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.1" },
    });
    const second = await app.request("/api/projects", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.2" },
    });
    expect(first.status).not.toBe(429);
    expect(second.status).toBe(429);
  });
});
