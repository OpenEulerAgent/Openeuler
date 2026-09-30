import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { HttpError } from "./errors.js";
import { createLogger } from "./logger.js";

const build = () => createApp({ logger: createLogger("silent") });

describe("GET /health", () => {
  it("returns ok with version and uptime", async () => {
    const { app } = build();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string; uptime: number };
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("reports the run-concurrency cap (default 2, configurable)", async () => {
    const { app } = build();
    const res = await app.request("/health");
    const body = (await res.json()) as { maxConcurrentRuns: number };
    expect(body.maxConcurrentRuns).toBe(2);

    const custom = createApp({ logger: createLogger("silent"), maxConcurrentRuns: 5 });
    const customRes = await custom.app.request("/health");
    expect(((await customRes.json()) as { maxConcurrentRuns: number }).maxConcurrentRuns).toBe(5);
  });
});

describe("unknown routes", () => {
  it("returns a structured 404", async () => {
    const { app } = build();
    const res = await app.request("/definitely-not-a-route");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("/definitely-not-a-route");
  });
});

describe("error mapping", () => {
  it("maps a thrown Error to a structured 500", async () => {
    const { app } = build();
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(typeof body.error.message).toBe("string");
  });

  it("maps a thrown HttpError to its own status and code", async () => {
    const { app } = build();
    app.get("/conflict", () => {
      throw new HttpError(409, "PROJECT_EXISTS", "project already registered");
    });
    const res = await app.request("/conflict");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: "PROJECT_EXISTS", message: "project already registered" });
  });

  it("maps a ZodError to 422 with details", async () => {
    const { app } = build();
    const schema = z.object({ name: z.string().min(1) });
    app.post("/projects", async (c) => {
      schema.parse(await c.req.json());
      return c.json({ ok: true });
    });
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: Array<{ path: string; message: string }> };
    };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toEqual([
      expect.objectContaining({ path: "name", message: expect.any(String) }),
    ]);
  });
});

describe("CORS", () => {
  it("reflects the configured origin and allows the default localhost:3000", async () => {
    const { app } = build();
    const res = await app.request("/health", { headers: { Origin: "http://localhost:3000" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("answers preflight requests", async () => {
    const { app } = build();
    const res = await app.request("/health", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
  });

  it("honors a custom origin", async () => {
    const { app } = createApp({
      logger: createLogger("silent"),
      corsOrigin: "http://example.test",
    });
    const res = await app.request("/health", { headers: { Origin: "http://example.test" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://example.test");
  });
});

describe("app context", () => {
  it("exposes logger and db (undefined when not provided) to handlers", async () => {
    const { app } = build();
    let seen: unknown;
    app.get("/context", (c) => {
      seen = { logger: c.get("logger"), db: c.get("db") };
      return c.json({ ok: true });
    });
    await app.request("/context");
    expect(seen).toMatchObject({
      db: undefined,
      logger: expect.objectContaining({ info: expect.any(Function) }),
    });
  });
});
