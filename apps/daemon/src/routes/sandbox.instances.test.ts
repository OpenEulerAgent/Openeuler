import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import type { SandboxProvider, SandboxSpec } from "@openeuler/sandbox";
import { createFakeSandboxProvider } from "@openeuler/sandbox";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";
import type { SandboxInstancesBody } from "./sandbox.js";

/**
 * `GET /api/sandbox/instances` + stop/destroy actions (#112): listing joins
 * (run rows incl. hosted, project names, usage from stats()), 404s for
 * unknown ids, 501s for providers without by-id stop/destroy, and auth —
 * all against the fake sandbox provider with scripted sandboxes and runs.
 */

interface Harness {
  db: Db;
  dir: string;
  provider: ReturnType<typeof createFakeSandboxProvider>;
  /** Advances the fake provider clock (distinct createdAt per sandbox). */
  tick: () => void;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

const spec = (overrides: Partial<SandboxSpec> = {}): SandboxSpec => ({
  runId: "run-unused",
  image: "openeuler/worker:latest",
  mounts: [],
  env: {},
  ...overrides,
});

let harness: Harness;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-instances-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  let clock = 1_700_000_000_000;
  const provider = createFakeSandboxProvider({ now: () => clock });
  const { app } = createApp({
    db,
    logger: createLogger("silent"),
    sandbox: { provider },
  });
  harness = {
    db,
    dir,
    provider,
    tick: () => {
      clock += 1_000;
    },
    request: (path, init) => Promise.resolve(app.request(path, init)),
  };
});

afterEach(() => {
  harness.db.close();
  rmSync(harness.dir, { recursive: true, force: true });
});

interface Seed {
  projectId: string;
  runId: string;
}

/** One project + run row pair; the caller creates the labeled sandbox. */
const seedRun = (
  overrides: Partial<{ status: string; hostedUntil: string; policy: boolean }> = {},
): Seed => {
  const projectId = harness.db.projects.create({
    id: `proj-${Math.random().toString(36).slice(2, 8)}`,
    path: "/tmp/demo",
    name: "demo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  }).id;
  if (overrides.policy) {
    harness.db.projects.setSandboxPolicy(projectId, {
      executionMode: "sandbox",
      image: "openeuler/worker:latest",
      memoryMb: 1024,
    });
  }
  const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
  harness.db.runs.create({
    id: runId,
    projectId,
    status: (overrides.status as never) ?? "running",
    branch: `agentloop/${runId}`,
    iteration: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(overrides.hostedUntil === undefined ? {} : { hostedUntil: overrides.hostedUntil }),
  });
  return { projectId, runId };
};

const listInstances = async (): Promise<SandboxInstancesBody> => {
  const res = await harness.request("/api/sandbox/instances");
  expect(res.status).toBe(200);
  return (await res.json()) as SandboxInstancesBody;
};

describe("GET /api/sandbox/instances (#112)", () => {
  it("lists sandboxes newest-first with the run join (project name, run status)", async () => {
    const first = seedRun();
    const second = seedRun({ status: "success" });
    await harness.provider.create(
      spec({
        runId: first.runId,
        labels: { run: first.runId },
        resources: { cpus: 1, memoryMb: 512 },
      }),
    );
    harness.tick();
    const newer = await harness.provider.create(
      spec({ runId: second.runId, labels: { run: second.runId } }),
    );

    const body = await listInstances();
    expect(body.instances).toHaveLength(2);
    expect(body.instances[0]?.id).toBe(newer.id);
    expect(body.instances[0]?.run).toMatchObject({
      id: second.runId,
      status: "success",
      project: { id: second.projectId, name: "demo" },
    });
    expect(body.instances[1]?.runId).toBe(first.runId);
    expect(typeof body.checkedAt).toBe("number");
  });

  it("maps stats() usage onto cpuPercent/memMb and the policy memory limit", async () => {
    const seed = seedRun({ policy: true });
    await harness.provider.create(
      spec({
        runId: seed.runId,
        labels: { run: seed.runId },
        resources: { cpus: 1, memoryMb: 512 },
      }),
    );

    const hostCpus = cpus().length || 1;
    const body = await listInstances();
    expect(body.instances[0]?.usage).toEqual({
      cpuPercent: Math.min(100, Math.round((1 / hostCpus) * 1000) / 10),
      memMb: 512,
      memLimitMb: 1024,
    });
  });

  it("falls back to the engine default memory limit when the policy sets none", async () => {
    const seed = seedRun(); // no policy
    await harness.provider.create(spec({ runId: seed.runId, labels: { run: seed.runId } }));
    const body = await listInstances();
    expect(body.instances[0]?.usage).toEqual({ memLimitMb: 2048 });
  });

  it("keeps runId for labeled sandboxes whose run row is gone, null for unlabeled", async () => {
    await harness.provider.create(spec({ labels: { run: "run-vanished" } }));
    await harness.provider.create(spec({}));
    const body = await listInstances();
    const byRunId = new Map(body.instances.map((instance) => [instance.runId, instance]));
    expect(byRunId.get("run-vanished")).toMatchObject({ runId: "run-vanished" });
    expect(byRunId.get("run-vanished")?.run).toBeUndefined();
    expect(byRunId.get(null)).toMatchObject({ runId: null, image: "openeuler/worker:latest" });
    expect(byRunId.get(null)?.run).toBeUndefined();
  });

  it("marks hosted runs on the join", async () => {
    const seed = seedRun({
      status: "success",
      hostedUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    await harness.provider.create(spec({ runId: seed.runId, labels: { run: seed.runId } }));
    const body = await listInstances();
    expect(body.instances[0]?.run).toMatchObject({ id: seed.runId, hosted: true });
  });

  it("omits usage when stats() fails but still lists the sandboxes", async () => {
    const seed = seedRun();
    await harness.provider.create(spec({ runId: seed.runId, labels: { run: seed.runId } }));
    const flaky: SandboxProvider = {
      id: "flaky",
      create: (specArg) => harness.provider.create(specArg),
      list: (selector) => harness.provider.list(selector),
      stats: async () => {
        throw new Error("docker stats exploded");
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-instances-2-"));
    const db = createDatabase({ path: join(dir, "test.db") });
    try {
      const { app } = createApp({
        db,
        logger: createLogger("silent"),
        sandbox: { provider: flaky },
      });
      const res = await Promise.resolve(app.request("/api/sandbox/instances"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as SandboxInstancesBody;
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0]?.usage).toBeUndefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers 503 SANDBOX_UNAVAILABLE when no provider is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-instances-3-"));
    const db = createDatabase({ path: join(dir, "test.db") });
    try {
      const { app } = createApp({ db, logger: createLogger("silent") });
      const res = await Promise.resolve(app.request("/api/sandbox/instances"));
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("SANDBOX_UNAVAILABLE");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /api/sandbox/instances/:id/stop (#112)", () => {
  it("stops a listed sandbox gracefully and keeps it listed as stopped", async () => {
    const handle = await harness.provider.create(spec({ labels: { run: "r-stop" } }));
    const res = await harness.request(`/api/sandbox/instances/${handle.id}/stop`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ stopped: handle.id });

    const body = await listInstances();
    expect(body.instances[0]).toMatchObject({ id: handle.id, status: "stopped" });
    expect(harness.provider.stopCalls.map((call) => call.sandboxId)).toEqual([handle.id]);
  });

  it("answers 404 SANDBOX_NOT_FOUND for unknown ids", async () => {
    const res = await harness.request("/api/sandbox/instances/ghost/stop", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SANDBOX_NOT_FOUND");
  });

  it("answers 501 when the provider cannot stop by id", async () => {
    const handle = await harness.provider.create(spec());
    const limited: SandboxProvider = {
      id: "limited",
      create: (specArg) => harness.provider.create(specArg),
      list: (selector) => harness.provider.list(selector),
    };
    const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-instances-4-"));
    const db = createDatabase({ path: join(dir, "test.db") });
    try {
      const { app } = createApp({
        db,
        logger: createLogger("silent"),
        sandbox: { provider: limited },
      });
      const res = await Promise.resolve(
        app.request(`/api/sandbox/instances/${handle.id}/stop`, { method: "POST" }),
      );
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("SANDBOX_STOP_UNSUPPORTED");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DELETE /api/sandbox/instances/:id (#112)", () => {
  it("destroys a listed sandbox (idempotent 404 once gone)", async () => {
    const handle = await harness.provider.create(spec({ labels: { run: "r-destroy" } }));
    const res = await harness.request(`/api/sandbox/instances/${handle.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deleted: handle.id });
    expect(await harness.provider.list()).toEqual([]);

    const again = await harness.request(`/api/sandbox/instances/${handle.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });

  it("answers 404 for unknown ids and 501 without provider destroy", async () => {
    const missing = await harness.request("/api/sandbox/instances/ghost", { method: "DELETE" });
    expect(missing.status).toBe(404);

    const handle = await harness.provider.create(spec());
    const limited: SandboxProvider = {
      id: "limited",
      create: (specArg) => harness.provider.create(specArg),
      list: (selector) => harness.provider.list(selector),
    };
    const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-instances-5-"));
    const db = createDatabase({ path: join(dir, "test.db") });
    try {
      const { app } = createApp({
        db,
        logger: createLogger("silent"),
        sandbox: { provider: limited },
      });
      const res = await Promise.resolve(
        app.request(`/api/sandbox/instances/${handle.id}`, { method: "DELETE" }),
      );
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("SANDBOX_DESTROY_UNSUPPORTED");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("auth (#112)", () => {
  it("requires the bearer token on every instances route", async () => {
    const handle = await harness.provider.create(spec());
    const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-instances-6-"));
    const db = createDatabase({ path: join(dir, "test.db") });
    try {
      const { app } = createApp({
        db,
        logger: createLogger("silent"),
        authToken: "sekret",
        sandbox: { provider: harness.provider },
      });
      const authed = { headers: { authorization: "Bearer sekret" } };
      const open = await Promise.resolve(app.request("/api/sandbox/instances"));
      expect(open.status).toBe(401);
      const openStop = await Promise.resolve(
        app.request(`/api/sandbox/instances/${handle.id}/stop`, { method: "POST" }),
      );
      expect(openStop.status).toBe(401);
      const openDelete = await Promise.resolve(
        app.request(`/api/sandbox/instances/${handle.id}`, { method: "DELETE" }),
      );
      expect(openDelete.status).toBe(401);

      const listed = await Promise.resolve(app.request("/api/sandbox/instances", authed));
      expect(listed.status).toBe(200);
      const stopped = await Promise.resolve(
        app.request(`/api/sandbox/instances/${handle.id}/stop`, {
          method: "POST",
          ...authed,
        }),
      );
      expect(stopped.status).toBe(200);
      const deleted = await Promise.resolve(
        app.request(`/api/sandbox/instances/${handle.id}`, {
          method: "DELETE",
          ...authed,
        }),
      );
      expect(deleted.status).toBe(200);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
