import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  parseCorsOrigins,
  resolveFramePolicy,
  resolveMaxBodyBytes,
} from "./security.js";

const ONE_MB = 1_048_576;

const build = (options: Parameters<typeof createApp>[0] = {}) =>
  createApp({ logger: createLogger("silent"), ...options });

describe("parseCorsOrigins", () => {
  it("parses comma-separated allowlists, trimming and deduping", () => {
    expect(parseCorsOrigins("http://a.test, http://b.test,,http://a.test")).toEqual([
      "http://a.test",
      "http://b.test",
    ]);
  });

  it("keeps the single-value form working and falls back to the default on empty", () => {
    expect(parseCorsOrigins("http://localhost:3000")).toEqual(["http://localhost:3000"]);
    expect(parseCorsOrigins("  ")).toEqual(["http://localhost:3000"]);
  });

  it("lets a lone * opt into wildcard mode", () => {
    expect(parseCorsOrigins(" * ")).toEqual(["*"]);
    expect(parseCorsOrigins("http://a.test,*")).toEqual(["*"]);
  });
});

describe("resolveMaxBodyBytes", () => {
  it("defaults to 1 MiB and only accepts integers >= 1", () => {
    expect(resolveMaxBodyBytes(undefined)).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(DEFAULT_MAX_BODY_BYTES).toBe(ONE_MB);
    expect(resolveMaxBodyBytes("2048")).toBe(2048);
    expect(resolveMaxBodyBytes("0")).toBe(ONE_MB);
    expect(resolveMaxBodyBytes("nope")).toBe(ONE_MB);
  });
});

describe("resolveFramePolicy", () => {
  it("denies framing outright by default (XFO DENY + frame-ancestors 'none')", () => {
    expect(resolveFramePolicy({ corsOrigins: ["http://localhost:3000"] })).toEqual({
      contentSecurityPolicy: "frame-ancestors 'none'",
      xFrameOptions: "DENY",
    });
  });

  it("PREVIEW_IFRAME allows self + the CORS allowlist and drops XFO", () => {
    expect(
      resolveFramePolicy({ previewIframe: true, corsOrigins: ["http://localhost:3000"] }),
    ).toEqual({
      contentSecurityPolicy: "frame-ancestors 'self' http://localhost:3000",
      xFrameOptions: undefined,
    });
  });

  it("an explicit FRAME_ANCESTORS wins; XFO only for 'none'", () => {
    expect(resolveFramePolicy({ frameAncestors: "'none'", corsOrigins: [] })).toEqual({
      contentSecurityPolicy: "frame-ancestors 'none'",
      xFrameOptions: "DENY",
    });
    expect(
      resolveFramePolicy({ frameAncestors: "'self' https://trusted.test", corsOrigins: [] }),
    ).toEqual({
      contentSecurityPolicy: "frame-ancestors 'self' https://trusted.test",
      xFrameOptions: undefined,
    });
  });
});

describe("payload cap", () => {
  it("413s an oversized body (measured when Content-Length is absent)", async () => {
    const { app } = build();
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(ONE_MB + 1),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("413s on a declared Content-Length without reading the body", async () => {
    const { app } = build();
    const res = await app.request(
      new Request("http://localhost/api/projects", {
        method: "POST",
        body: "small",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(ONE_MB + 1),
        },
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("covers graph PUTs and prompt-sized POSTs implicitly, at the default 1 MiB", async () => {
    const { app } = build();
    const graph = await app.request("/api/workflows/wf/graph", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph: { nodes: "x".repeat(ONE_MB) } }),
    });
    expect(graph.status).toBe(413);
    // A body just under the cap passes through to the route (any status but 413).
    const ok = await app.request("/api/workflows/wf/graph", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph: { small: true } }),
    });
    expect(ok.status).not.toBe(413);
  });

  it("scopes the cap to /api/* and exempts stream routes", async () => {
    const { app } = build();
    // /health is not /api: an oversized POST answers 404, not 413.
    const health = await app.request("/health", {
      method: "POST",
      body: "x".repeat(ONE_MB + 1),
    });
    expect(health.status).toBe(404);
    // Stream routes are exempt (GET, no body — must never see 413/429).
    const stream = await app.request("/api/runs/stream");
    expect(stream.status).not.toBe(413);
  });
});

describe("CORS allowlist", () => {
  it("reflects each allowlisted origin exactly", async () => {
    const { app } = build({ corsOrigin: "http://a.test, http://b.test" });
    for (const origin of ["http://a.test", "http://b.test"]) {
      const res = await app.request("/health", { headers: { Origin: origin } });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("sends no ACAO header for foreign origins (request and preflight)", async () => {
    const { app } = build({ corsOrigin: "http://a.test,http://b.test" });
    const res = await app.request("/health", { headers: { Origin: "http://evil.test" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await app.request("/api/projects", {
      method: "OPTIONS",
      headers: {
        Origin: "http://evil.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("still answers allowlisted preflights, now with security headers", async () => {
    const { app } = build({ corsOrigin: "http://a.test" });
    const res = await app.request("/api/projects", {
      method: "OPTIONS",
      headers: {
        Origin: "http://a.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://a.test");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("security headers", () => {
  const expectBaseline = (res: Response): void => {
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()",
    );
  };

  it("lands on /health, /api responses, 404s and error responses alike", async () => {
    const { app } = build();
    // Routes must be registered before the first request (matcher freezes).
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    expectBaseline(await app.request("/health"));

    const api = await app.request("/api/projects");
    expectBaseline(api);
    expect(api.headers.get("cache-control")).toBe("no-store");

    expectBaseline(await app.request("/definitely-not-a-route"));
    expectBaseline(await app.request("/boom"));
  });

  it("no-stores /api responses but respects handler-set Cache-Control", async () => {
    const { app } = build();
    app.get("/api/event-stream", (c) =>
      c.newResponse(null, 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      }),
    );
    expect((await app.request("/api/system/auth-status")).headers.get("cache-control")).toBe(
      "no-store",
    );
    // Handlers that pick their own directive (SSE streams send `no-cache`)
    // are never overridden.
    expect((await app.request("/api/event-stream")).headers.get("cache-control")).toBe("no-cache");
    expect((await app.request("/health")).headers.get("cache-control")).toBeNull();
    expect((await app.request("/metrics")).headers.get("cache-control")).toBeNull();
  });

  it("relaxes framing for the M7 preview-iframe placeholder", async () => {
    const { app } = build({ previewIframe: true });
    const res = await app.request("/health");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self' http://localhost:3000",
    );
  });

  it("honors an explicit FRAME_ANCESTORS override", async () => {
    const { app } = build({ frameAncestors: "'self' https://trusted.test" });
    const res = await app.request("/health");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self' https://trusted.test",
    );
  });
});
