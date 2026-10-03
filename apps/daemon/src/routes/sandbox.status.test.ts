import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";
import { parseDockerVersion } from "../sandbox-status.js";

/**
 * `GET /api/sandbox/status` unit tests (#106): availability + CLI version via
 * injected probes, the 60s cache with `?refresh=1` bypass, and the
 * `?projectId=` effective-mode resolution (same logic as the executor).
 */

interface Harness {
  db: Db;
  dir: string;
  probe: ReturnType<typeof vi.fn>;
  versionRunner: ReturnType<typeof vi.fn>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

let harness: Harness;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-status-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const probe = vi.fn(async () => true);
  const versionRunner = vi.fn(async () => ({
    code: 0,
    stdout: "Docker version 27.3.1, build cc13f95\n",
    stderr: "",
  }));
  const { app } = createApp({
    db,
    logger: createLogger("silent"),
    sandbox: {
      status: {
        isDockerAvailable: probe,
        versionRunner,
      },
    },
  });
  harness = {
    db,
    dir,
    probe,
    versionRunner,
    request: (path, init) => Promise.resolve(app.request(path, init)),
  };
});

afterEach(() => {
  harness.db.close();
  rmSync(harness.dir, { recursive: true, force: true });
});

describe("parseDockerVersion", () => {
  it("extracts the version token from the canonical --version line", () => {
    expect(parseDockerVersion("Docker version 27.3.1, build cc13f95\n")).toBe("27.3.1");
    expect(parseDockerVersion("Docker version 24.0\n")).toBe("24.0");
  });

  it("returns undefined for output without a version-looking token", () => {
    expect(parseDockerVersion("")).toBeUndefined();
    expect(parseDockerVersion("nope\n")).toBeUndefined();
  });
});

describe("GET /api/sandbox/status (#106)", () => {
  it("reports docker available with the CLI version", async () => {
    const res = await harness.request("/api/sandbox/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available: boolean;
      version?: string;
      mode: string;
      checkedAt: number;
    };
    expect(body).toMatchObject({ available: true, version: "27.3.1", mode: "docker" });
    expect(typeof body.checkedAt).toBe("number");
    expect(body.checkedAt).toBeGreaterThan(0);
  });

  it("reports unavailable with mode 'unavailable' when the probe fails", async () => {
    const { app } = createApp({
      db: harness.db,
      logger: createLogger("silent"),
      sandbox: {
        status: {
          isDockerAvailable: async () => false,
          versionRunner: async () => ({
            code: 0,
            stdout: "Docker version 27.3.1, build cc13f95\n",
            stderr: "",
          }),
        },
      },
    });
    const res = await Promise.resolve(app.request("/api/sandbox/status"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      available: false,
      version: "27.3.1",
      mode: "unavailable",
    });
  });

  it("omits the version when the docker CLI is missing entirely", async () => {
    const { app } = createApp({
      db: harness.db,
      logger: createLogger("silent"),
      sandbox: {
        status: {
          isDockerAvailable: async () => false,
          versionRunner: async () => {
            throw new Error("spawn docker ENOENT");
          },
        },
      },
    });
    const res = await Promise.resolve(app.request("/api/sandbox/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version?: string };
    expect(body.version).toBeUndefined();
  });

  it("caches the probe for the TTL and re-probes on ?refresh=1", async () => {
    const first = await harness.request("/api/sandbox/status");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    const second = await harness.request("/api/sandbox/status");
    expect(second.status).toBe(200);
    // Within the 60s TTL: one probe, one --version, identical payloads.
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.versionRunner).toHaveBeenCalledTimes(1);
    await expect(second.json()).resolves.toEqual(firstBody);

    const refreshed = await harness.request("/api/sandbox/status?refresh=1");
    expect(refreshed.status).toBe(200);
    expect(harness.probe).toHaveBeenCalledTimes(2);
    expect(harness.versionRunner).toHaveBeenCalledTimes(2);
    const refreshedBody = (await refreshed.json()) as { checkedAt: number };
    expect(refreshedBody.checkedAt).toBeGreaterThanOrEqual(firstBody["checkedAt"] as number);
  });

  it("passes force to the availability probe only on refresh", async () => {
    await harness.request("/api/sandbox/status");
    await harness.request("/api/sandbox/status");
    expect(harness.probe.mock.calls[0]?.[0]).toEqual({});
    await harness.request("/api/sandbox/status?refresh=1");
    expect(harness.probe.mock.calls[1]?.[0]).toEqual({ force: true });
  });
});

describe("GET /api/sandbox/status?projectId= (#106 effective mode)", () => {
  const project = {
    id: "proj-1",
    path: "/tmp/demo",
    name: "demo",
    defaultBranch: "main",
    dirty: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const requestWith = async (
    options: { available: boolean; policy?: Record<string, unknown> },
    path: string,
  ): Promise<Response> => {
    const { app } = createApp({
      db: harness.db,
      logger: createLogger("silent"),
      sandbox: {
        status: {
          isDockerAvailable: async () => options.available,
          versionRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
        },
      },
    });
    return Promise.resolve(app.request(path));
  };

  beforeEach(() => {
    harness.db.projects.create(project);
  });

  it("resolves auto → sandbox when docker is available", async () => {
    harness.db.projects.setSandboxPolicy("proj-1", { executionMode: "auto" });
    const res = await requestWith({ available: true }, "/api/sandbox/status?projectId=proj-1");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      projectId: "proj-1",
      projectMode: "auto",
      effective: "sandbox",
      available: true,
    });
  });

  it("resolves auto → local when docker is unavailable (the local fallback)", async () => {
    harness.db.projects.setSandboxPolicy("proj-1", { executionMode: "auto" });
    const res = await requestWith({ available: false }, "/api/sandbox/status?projectId=proj-1");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      projectMode: "auto",
      effective: "local",
      available: false,
    });
  });

  it("keeps explicit sandbox policy at effective sandbox regardless of availability", async () => {
    harness.db.projects.setSandboxPolicy("proj-1", { executionMode: "sandbox" });
    const res = await requestWith({ available: false }, "/api/sandbox/status?projectId=proj-1");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      projectMode: "sandbox",
      effective: "sandbox",
    });
  });

  it("defaults an unsaved policy to projectMode local / effective local", async () => {
    const res = await requestWith({ available: true }, "/api/sandbox/status?projectId=proj-1");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      projectMode: "local",
      effective: "local",
    });
  });

  it("answers 404 PROJECT_NOT_FOUND for unknown projects", async () => {
    const res = await requestWith({ available: true }, "/api/sandbox/status?projectId=ghost");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("treats an empty projectId query as the plain status payload", async () => {
    const res = await requestWith({ available: true }, "/api/sandbox/status?projectId=");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projectMode?: string };
    expect(body.projectMode).toBeUndefined();
  });
});
