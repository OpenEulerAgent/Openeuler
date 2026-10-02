import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import pino from "pino";
import { createApp } from "./app.js";
import {
  acceptsQueryToken,
  bearerFromHeader,
  redactTokenQuery,
  resolveAuthToken,
  tokensMatch,
} from "./auth.js";
import { createExecutor } from "./executor.js";
import type { Logger } from "./logger.js";

/**
 * #92 bearer-token auth: unit tests for the pure helpers plus integration
 * coverage through `createApp` — open mode, 401s, the SSE `?token=`
 * fallback (and its strict scoping), minimal `/health`, the open
 * auth-status probe, and "the token never reaches the logs".
 */

const TOKEN = "s3cret-auth-token-92";

interface AuthHarness {
  db: Db;
  logger: Logger;
  /** Every log line the daemon wrote (pino → memory stream). */
  logOutput: () => string;
  request: (input: string, init?: RequestInit) => Promise<Response>;
}

const created: Array<{ db: Db; dir: string }> = [];

const setup = (authToken?: string): AuthHarness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-auth-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const lines: string[] = [];
  const logger = pino({ level: "info" }, { write: (line: string) => lines.push(line) });
  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver());
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot: join(dir, "store") }),
    drivers,
    logger,
  });
  // Long heartbeats: tests abort streams before the first ping.
  const { app } = createApp({
    db,
    logger,
    executor,
    ...(authToken === undefined ? {} : { authToken }),
    globalStream: { heartbeatMs: 60_000 },
    eventStream: { pollIntervalMs: 20, heartbeatMs: 60_000 },
  });
  created.push({ db, dir });
  return {
    db,
    logger,
    logOutput: () => lines.join("\n"),
    request: (input, init) => Promise.resolve(app.request(input, init)),
  };
};

afterEach(() => {
  vi.unstubAllEnvs();
  while (created.length > 0) {
    const item = created.pop() as { db: Db; dir: string };
    item.db.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

describe("resolveAuthToken", () => {
  it("returns undefined without the env var, for empty and for whitespace values", () => {
    expect(resolveAuthToken({})).toBeUndefined();
    expect(resolveAuthToken({ OPENEULER_TOKEN: "" })).toBeUndefined();
    expect(resolveAuthToken({ OPENEULER_TOKEN: "   " })).toBeUndefined();
  });

  it("returns the trimmed token when set", () => {
    expect(resolveAuthToken({ OPENEULER_TOKEN: `  ${TOKEN}  ` })).toBe(TOKEN);
  });
});

describe("tokensMatch", () => {
  it("accepts the equal token and rejects others without throwing on length", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(tokensMatch(TOKEN, "totally-different")).toBe(false);
    expect(tokensMatch(TOKEN, "")).toBe(false);
  });
});

describe("bearerFromHeader", () => {
  it("parses Bearer (case-insensitive) and rejects other schemes/shapes", () => {
    expect(bearerFromHeader(undefined)).toBeUndefined();
    expect(bearerFromHeader(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerFromHeader(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerFromHeader(`Basic ${TOKEN}`)).toBeUndefined();
    expect(bearerFromHeader("Bearer")).toBeUndefined();
    expect(bearerFromHeader("Bearer  ")).toBeUndefined();
  });
});

describe("acceptsQueryToken", () => {
  it("allows exactly the GET streaming routes", () => {
    expect(acceptsQueryToken("GET", "/api/runs/stream")).toBe(true);
    expect(acceptsQueryToken("GET", "/api/runs/uuid-1/events")).toBe(true);
    expect(acceptsQueryToken("GET", "/api/previews/abc")).toBe(true);
    expect(acceptsQueryToken("GET", "/previews/abc/chunks")).toBe(true);
  });

  it("rejects non-streaming routes and non-GET methods", () => {
    expect(acceptsQueryToken("GET", "/api/projects")).toBe(false);
    expect(acceptsQueryToken("GET", "/api/runs")).toBe(false);
    expect(acceptsQueryToken("GET", "/api/runs/uuid-1")).toBe(false);
    expect(acceptsQueryToken("GET", "/api/runs/uuid-1/diff")).toBe(false);
    expect(acceptsQueryToken("POST", "/api/runs/uuid-1/events")).toBe(false);
    expect(acceptsQueryToken("POST", "/api/runs/stream")).toBe(false);
    expect(acceptsQueryToken("GET", "/api/system/auth-status")).toBe(false);
  });
});

describe("redactTokenQuery", () => {
  it("redacts the token param and leaves everything else intact", () => {
    expect(redactTokenQuery(`/api/runs/stream?token=${TOKEN}`)).toBe(
      "/api/runs/stream?token=[redacted]",
    );
    expect(redactTokenQuery(`/api/runs/x/events?afterSeq=3&token=${TOKEN}&other=1`)).toBe(
      "/api/runs/x/events?afterSeq=3&token=[redacted]&other=1",
    );
    expect(redactTokenQuery("/api/runs/stream")).toBe("/api/runs/stream");
  });
});

describe("open mode (no OPENEULER_TOKEN)", () => {
  it("serves /api routes without any token", async () => {
    const h = setup();
    const res = await h.request("/api/projects");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [] });
  });

  it("reports authRequired=false and a full /health payload", async () => {
    const h = setup();
    const status = await h.request("/api/system/auth-status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ authRequired: false });

    const health = await h.request("/health");
    expect(health.status).toBe(200);
    expect(Object.keys((await health.json()) as Record<string, unknown>).sort()).toEqual([
      "maxConcurrentRuns",
      "ok",
      "uptime",
      "version",
    ]);
  });
});

describe("auth mode (OPENEULER_TOKEN set)", () => {
  it("enforces auth via the env var too, not just the option", async () => {
    vi.stubEnv("OPENEULER_TOKEN", "from-env-token");
    const h = setup();
    expect((await h.request("/api/projects")).status).toBe(401);
    const ok = await h.request("/api/projects", {
      headers: { Authorization: "Bearer from-env-token" },
    });
    expect(ok.status).toBe(200);
  });

  it("answers 401 UNAUTHORIZED without and with a wrong bearer token", async () => {
    const h = setup(TOKEN);
    for (const init of [
      undefined,
      { headers: { Authorization: "Bearer wrong-token" } },
      { headers: { Authorization: `Basic ${TOKEN}` } },
      { headers: { Authorization: TOKEN } },
    ]) {
      const res = await h.request("/api/projects", init);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("UNAUTHORIZED");
      // No token echo, ever.
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    }
  });

  it("accepts a valid bearer token (case-insensitive scheme)", async () => {
    const h = setup(TOKEN);
    for (const scheme of ["Bearer", "bearer"]) {
      const res = await h.request("/api/projects", {
        headers: { Authorization: `${scheme} ${TOKEN}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it("keeps auth-status open and reports authRequired=true", async () => {
    const h = setup(TOKEN);
    const res = await h.request("/api/system/auth-status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authRequired: true });
  });

  it("answers /health with a minimal payload (ok + version only)", async () => {
    const h = setup(TOKEN);
    const res = await h.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "version"]);
    expect(body["ok"]).toBe(true);
  });

  it("rejects the query token on non-streaming routes (strict scoping)", async () => {
    const h = setup(TOKEN);
    const res = await h.request(`/api/projects?token=${encodeURIComponent(TOKEN)}`);
    expect(res.status).toBe(401);
  });

  it("authenticates before routing (401 on unknown ids, not 404)", async () => {
    const h = setup(TOKEN);
    const res = await h.request("/api/runs/no-such-run");
    expect(res.status).toBe(401);
    const ok = await h.request("/api/runs/no-such-run", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(404);
  });
});

describe("auth mode — SSE ?token= fallback", () => {
  const stream = async (
    h: AuthHarness,
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; contentType: string }> => {
    const controller = new AbortController();
    const res = await h.request(path, { ...init, signal: controller.signal });
    const contentType = res.headers.get("content-type") ?? "";
    // Teardown: abort before reading — the SSE loops unwind on the signal.
    controller.abort();
    return { status: res.status, contentType };
  };

  it("accepts the correct query token on the global stream", async () => {
    const h = setup(TOKEN);
    const { status, contentType } = await stream(h, `/api/runs/stream?token=${TOKEN}`);
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");
  });

  it("accepts a bearer header on the global stream too", async () => {
    const h = setup(TOKEN);
    const { status } = await stream(h, "/api/runs/stream", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(status).toBe(200);
  });

  it("rejects the global stream without, and with a wrong, query token", async () => {
    const h = setup(TOKEN);
    for (const path of ["/api/runs/stream", "/api/runs/stream?token=wrong", "/api/runs/stream?token="]) {
      const { status } = await stream(h, path);
      expect(status).toBe(401);
    }
  });

  it("does NOT fall back to the query token when a (wrong) header is present", async () => {
    const h = setup(TOKEN);
    const { status } = await stream(h, `/api/runs/stream?token=${TOKEN}`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(status).toBe(401);
  });

  it("accepts the query token on a run's event stream", async () => {
    const h = setup(TOKEN);
    const now = new Date().toISOString();
    h.db.projects.create({ id: "p1", path: "/tmp/p1", name: "p1", defaultBranch: "main", createdAt: now });
    h.db.runs.create({
      id: "run-1",
      projectId: "p1",
      status: "running",
      branch: "openeuler/run-1",
      iteration: 0,
      createdAt: now,
      updatedAt: now,
    });
    const { status, contentType } = await stream(h, `/api/runs/run-1/events?token=${TOKEN}`);
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");
  });
});

describe("log hygiene", () => {
  it("never writes the token to the logs, and redacts the query param", async () => {
    const h = setup(TOKEN);
    const controller = new AbortController();
    // Exercise every channel: valid header, invalid header, valid query,
    // invalid query, 401s and 200s.
    await h.request("/api/projects", { headers: { Authorization: `Bearer ${TOKEN}` } });
    await h.request("/api/projects", { headers: { Authorization: "Bearer nope" } });
    await h.request(`/api/runs/stream?token=${TOKEN}`, { signal: controller.signal });
    await h.request("/api/runs/stream?token=also-wrong-token");
    await h.request("/api/projects");
    controller.abort();

    const output = h.logOutput();
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain("also-wrong-token");
    // The query param is redacted, not dropped: `token=[redacted]`.
    expect(output).toContain("token=[redacted]");
    expect(output).toContain("unauthorized request");
  });
});
