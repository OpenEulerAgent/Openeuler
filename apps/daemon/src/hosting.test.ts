import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import type { FakeDriverOptions } from "@openeuler/drivers";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createFakeSandboxProvider } from "@openeuler/sandbox";
import { createExecutor } from "./executor.js";
import type { Executor, ExecutorOptions } from "./executor.js";
import {
  reattachHostedRuns,
  runHostingSweep,
  startHostingSweeper,
} from "./hosting.js";
import { createLogger } from "./logger.js";

/**
 * Hosted-run lifecycle (#110), fake provider + fake clock: the executor's
 * host-on-success decision (success only, sandboxed only, declared ports
 * only), stop/extend, the TTL sweeper (expiry destroys + ops event, the
 * provider-label fallback for hosting that outlived a restart), the boot
 * reattach sweep, and the sweeper service tick. The docker-gated e2e
 * lives in hosting.e2e.test.ts.
 */

const logger = createLogger("silent");

interface Harness {
  dir: string;
  db: Db;
  worktrees: WorktreeManager;
  executor: Executor;
  driver: ReturnType<typeof createFakeDriver>;
  provider: ReturnType<typeof createFakeSandboxProvider>;
  projectId: string;
  enqueue(overrides?: {
    ports?: number[];
    hosting?: { enabled: boolean; keepAliveMinutes?: number };
  }): string;
  rebuildExecutor(opts?: Partial<ExecutorOptions>): void;
}

const created: Harness[] = [];

const setup = (
  fakeOpts: FakeDriverOptions = {},
  executorOpts: Partial<ExecutorOptions> = {},
): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-hosting-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  execFileSync("git", ["add", "-A"], { cwd: repoPath, stdio: "pipe" });
  execFileSync(
    "git",
    ["-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init"],
    { cwd: repoPath, stdio: "pipe" },
  );
  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: repoPath,
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  db.projects.setSandboxPolicy(project.id, {
    executionMode: "sandbox",
    image: "busybox:1.36",
  });

  const provider = createFakeSandboxProvider();
  const drivers = createDriverRegistry();
  const driver = createFakeDriver(fakeOpts);
  drivers.registerDriver(driver);
  const worktrees = new WorktreeManager({ storeRoot: join(dir, "store") });

  const harness: Harness = {
    dir,
    db,
    worktrees,
    driver,
    provider,
    executor: null as unknown as Executor,
    projectId: project.id,
    enqueue(overrides = {}) {
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.runs.create({
        id: runId,
        projectId: project.id,
        status: "queued",
        branch: `agentloop/${runId}`,
        iteration: 0,
        task: "serve it",
        ...(overrides.ports === undefined ? {} : { ports: overrides.ports }),
        ...(overrides.hosting === undefined ? {} : { hosting: overrides.hosting }),
        createdAt: now,
        updatedAt: now,
      });
      db.stepRuns.create({
        id: crypto.randomUUID(),
        runId,
        stepId: "adhoc",
        iteration: 1,
        status: "queued",
        output: "",
      });
      return runId;
    },
    rebuildExecutor(opts = {}) {
      harness.executor = createExecutor({
        db,
        worktrees,
        drivers,
        logger,
        sandbox: { provider, isDockerAvailable: async () => true },
        ...opts,
      });
    },
  };
  harness.rebuildExecutor(executorOpts);
  created.push(harness);
  return harness;
};

afterEach(() => {
  while (created.length > 0) {
    const harness = created.pop() as Harness;
    harness.db.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

const waitForStatus = async (h: Harness, runId: string, status: RunStatus): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (h.db.runs.get(runId)?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${status}: currently ${h.db.runs.get(runId)?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const waitForIdle = async (h: Harness): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (h.executor.activeRunIds().length > 0) {
    if (Date.now() > deadline) throw new Error("executor never went idle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("executor hosting on success (#110)", () => {
  it("a successful sandboxed run with hosting + declared ports keeps its sandbox + arms hostedUntil", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" });
    const runId = h.enqueue({ ports: [8000], hosting: { enabled: true } });

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await waitForIdle(h);

    // Sandbox alive, row success + hostedUntil ~ now + 60m (default TTL).
    const run = h.db.runs.get(runId);
    expect(run?.status).toBe("success");
    expect(run?.hostedUntil).toBeDefined();
    const until = Date.parse(run?.hostedUntil ?? "");
    expect(until).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 61 * 60_000);
    expect(h.provider.destroyCalls).toHaveLength(0);
    expect(await h.provider.list({ run: runId })).toHaveLength(1);

    // custom keepAliveMinutes is honored.
    const custom = h.enqueue({ ports: [8000], hosting: { enabled: true, keepAliveMinutes: 15 } });
    h.executor.startRun(custom);
    await waitForStatus(h, custom, "success");
    await waitForIdle(h);
    const customUntil = Date.parse(h.db.runs.get(custom)?.hostedUntil ?? "");
    expect(customUntil).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(customUntil).toBeLessThanOrEqual(Date.now() + 16 * 60_000);
  });

  it("the hosted sandbox keeps serving sandboxInfo (previews stay resolvable)", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" });
    const runId = h.enqueue({ ports: [8000], hosting: { enabled: true } });

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await waitForIdle(h);

    const info = await h.executor.sandboxInfo(runId);
    expect(info?.status).toBe("running");
    expect(info?.ports).toEqual([{ container: 8000, host: 32768, declared: true }]);
    // Not an active run anymore — hosting outlives execution.
    expect(h.executor.activeRunIds()).toEqual([]);
  });

  it("a failed run NEVER hosts (destroyed as usual)", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "x" }], exitCode: 7, output: "x" });
    const runId = h.enqueue({ ports: [8000], hosting: { enabled: true } });

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "failed");
    await waitForIdle(h);

    expect(h.db.runs.get(runId)?.hostedUntil).toBeUndefined();
    expect(h.provider.destroyCalls).toHaveLength(1);
    expect(await h.provider.list({ run: runId })).toEqual([]);
  });

  it("an aborted run NEVER hosts", async () => {
    const h = setup({
      events: [{ type: "message-delta", seq: 1, delta: "working" }],
      delayMs: 60_000,
    });
    const runId = h.enqueue({ ports: [8000], hosting: { enabled: true } });

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "running");
    const deadline = Date.now() + 5_000;
    while (h.provider.createdSpecs.length === 0) {
      if (Date.now() > deadline) throw new Error("sandbox never created");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await h.executor.abortRun(runId);
    await waitForIdle(h);

    expect(h.db.runs.get(runId)?.status).toBe("aborted");
    expect(h.db.runs.get(runId)?.hostedUntil).toBeUndefined();
    expect(await h.provider.list({ run: runId })).toEqual([]);
  });

  it("hosting without declared ports (or on local runs) is ignored", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" });
    const portless = h.enqueue({ hosting: { enabled: true } });
    h.executor.startRun(portless);
    await waitForStatus(h, portless, "success");
    await waitForIdle(h);
    expect(h.db.runs.get(portless)?.hostedUntil).toBeUndefined();
    expect(await h.provider.list({ run: portless })).toEqual([]);

    // Local execution (auto policy + docker unavailable): no sandbox to host.
    h.db.projects.setSandboxPolicy(h.projectId, { executionMode: "auto", image: "busybox:1.36" });
    h.rebuildExecutor({ sandbox: { provider: h.provider, isDockerAvailable: async () => false } });
    const local = h.enqueue({ ports: [8000], hosting: { enabled: true } });
    h.executor.startRun(local);
    await waitForStatus(h, local, "success");
    await waitForIdle(h);
    expect(h.db.runs.get(local)?.hostedUntil).toBeUndefined();
  });
});

describe("executor stopHosting / extendHosting (#110)", () => {
  const hostRun = async (h: Harness): Promise<string> => {
    const runId = h.enqueue({ ports: [8000], hosting: { enabled: true } });
    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await waitForIdle(h);
    return runId;
  };

  it("stopHosting destroys the sandbox, clears hostedUntil, keeps the run success", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" });
    const runId = await hostRun(h);

    expect(await h.executor.stopHosting(runId)).toEqual({ outcome: "stopped" });
    expect(h.db.runs.get(runId)).toMatchObject({ status: "success" });
    expect(h.db.runs.get(runId)?.hostedUntil).toBeUndefined();
    expect(await h.provider.list({ run: runId })).toEqual([]);
    expect(await h.executor.sandboxInfo(runId)).toBeUndefined();
    // A second stop is not_hosted (409 at the route).
    expect(await h.executor.stopHosting(runId)).toEqual({ outcome: "not_hosted" });
  });

  it("stopHosting falls back to provider-label destroy when this executor holds no handle", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" });
    const runId = await hostRun(h);
    // Simulate a daemon restart: fresh executor (no hosted handle) over the
    // same db + provider, hosting kept alive on the row.
    h.rebuildExecutor();
    expect(h.db.runs.get(runId)?.hostedUntil).toBeDefined();

    expect(await h.executor.stopHosting(runId)).toEqual({ outcome: "stopped" });
    expect(await h.provider.list({ run: runId })).toEqual([]);
    expect(h.db.runs.get(runId)?.hostedUntil).toBeUndefined();
  });

  it("extendHosting bumps hostedUntil by the minutes, caps 24h from now; 409s when not hosted", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" });
    const runId = await hostRun(h);

    // Bump: 60m window + 30m → ~90m from now.
    expect(await h.executor.extendHosting(runId, 30)).toMatchObject({ outcome: "extended" });
    const extended = Date.parse(h.db.runs.get(runId)?.hostedUntil ?? "");
    expect(extended).toBeGreaterThan(Date.now() + 89 * 60_000);
    expect(extended).toBeLessThanOrEqual(Date.now() + 91 * 60_000);

    // Cap: no extend pushes hostedUntil more than 24h past NOW.
    expect(await h.executor.extendHosting(runId, 10_000)).toMatchObject({ outcome: "extended" });
    const capped = Date.parse(h.db.runs.get(runId)?.hostedUntil ?? "");
    expect(capped).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000 + 1_000);
    expect(capped).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
    // At the cap, another extend cannot meaningfully move it (the cap is
    // 24h from each extend's "now" — only the tiny clock drift sneaks in).
    expect(await h.executor.extendHosting(runId, 30)).toMatchObject({ outcome: "extended" });
    const recapped = Date.parse(h.db.runs.get(runId)?.hostedUntil ?? "");
    expect(recapped).toBeGreaterThanOrEqual(capped);
    expect(recapped).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000 + 5_000);

    // Not hosted → not_hosted (409 at the route).
    expect(await h.executor.extendHosting("no-such-run", 5)).toEqual({ outcome: "not_hosted" });
  });
});

describe("hosting TTL sweep (#110)", () => {
  const hostRun = async (h: Harness): Promise<string> => {
    const runId = h.enqueue({ ports: [8000], hosting: { enabled: true, keepAliveMinutes: 5 } });
    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await waitForIdle(h);
    return runId;
  };

  it("expired hosting destroys the sandbox, clears hostedUntil, records ops.hosting-expired; run stays success", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" });
    const runId = await hostRun(h);
    const until = h.db.runs.get(runId)?.hostedUntil ?? "";

    // Fake clock past the (5-minute) TTL; the executor hook owns teardown.
    const counts = await runHostingSweep({
      db: h.db,
      provider: h.provider,
      logger,
      now: () => Date.now() + 10 * 60_000,
      stopHosted: async (id) => (await h.executor.stopHosting(id)).outcome === "stopped",
    });

    expect(counts).toEqual({ expired: 1, kept: 0 });
    expect(h.db.runs.get(runId)).toMatchObject({ status: "success" });
    expect(h.db.runs.get(runId)?.hostedUntil).toBeUndefined();
    expect(await h.provider.list({ run: runId })).toEqual([]);
    const event = h.db.activity
      .list({ limit: 20 })
      .find((row) => row.type === "ops.hosting-expired" && row.runId === runId);
    expect(event?.payload).toMatchObject({ runId, until });
  });

  it("unexpired hosting is kept untouched", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" });
    const runId = await hostRun(h);

    const counts = await runHostingSweep({
      db: h.db,
      provider: h.provider,
      logger,
      now: () => Date.now() + 60_000, // inside the 5-minute window
      stopHosted: async () => {
        throw new Error("must not be called");
      },
    });

    expect(counts).toEqual({ expired: 0, kept: 1 });
    expect(h.db.runs.get(runId)?.hostedUntil).toBeDefined();
    expect(await h.provider.list({ run: runId })).toHaveLength(1);
  });

  it("an extend landing mid-sweep is honored — the fresh row re-read prevents clobbering", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" });
    const runId = await hostRun(h);

    // The sweep starts with a stale snapshot; the user extends BEFORE the
    // loop reaches this run (as if an earlier iteration awaited a destroy).
    const hostedSnapshot = h.db.runs.list().filter((run) => run.hostedUntil !== undefined);
    expect(hostedSnapshot).toHaveLength(1);
    const extendResult = await h.executor.extendHosting(runId, 30);
    expect(extendResult.outcome).toBe("extended");

    const counts = await runHostingSweep({
      db: h.db,
      provider: h.provider,
      logger,
      now: () => Date.now() + 10 * 60_000, // past the ORIGINAL 5-minute TTL
      stopHosted: async () => {
        throw new Error("must not stop a just-extended run");
      },
    });

    expect(counts).toEqual({ expired: 0, kept: 1 });
    expect(h.db.runs.get(runId)?.hostedUntil).toBeDefined();
    expect(await h.provider.list({ run: runId })).toHaveLength(1);
    const events = h.db.activity
      .list({ limit: 20 })
      .filter((row) => row.type === "ops.hosting-expired" && row.runId === runId);
    expect(events).toEqual([]);
  });

  it("the provider-label fallback expires hosting this executor does not own (post-restart)", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" });
    const runId = await hostRun(h);
    const until = h.db.runs.get(runId)?.hostedUntil ?? "";
    h.rebuildExecutor(); // restart: no handle anywhere

    const counts = await runHostingSweep({
      db: h.db,
      provider: h.provider,
      logger,
      now: () => Date.parse(until) + 1,
    });

    expect(counts).toEqual({ expired: 1, kept: 0 });
    expect(h.provider.destroyCalls.length).toBeGreaterThanOrEqual(1);
    expect(await h.provider.list({ run: runId })).toEqual([]);
    expect(h.db.runs.get(runId)?.hostedUntil).toBeUndefined();
    expect(
      h.db.activity
        .list({ limit: 20 })
        .some((row) => row.type === "ops.hosting-expired" && row.runId === runId),
    ).toBe(true);
  });
});

describe("hosting restart reattach (#110)", () => {
  it("a hosted run whose sandbox survived gets a fresh window; one whose sandbox died is cleared", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" });
    const runId = h.enqueue({ ports: [8000], hosting: { enabled: true, keepAliveMinutes: 30 } });
    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await waitForIdle(h);
    h.db.runs.update(runId, { hostedUntil: "2020-01-01T00:00:00.000Z" }); // stale, pre-restart

    const counts = await reattachHostedRuns({ db: h.db, provider: h.provider, logger });

    expect(counts).toEqual({ reattached: 1, cleared: 0 });
    const until = Date.parse(h.db.runs.get(runId)?.hostedUntil ?? "");
    expect(until).toBeGreaterThan(Date.now() + 29 * 60_000); // fresh 30m window
    expect(until).toBeLessThanOrEqual(Date.now() + 31 * 60_000);

    // Sandbox gone (operator removed the container): hosting clears, run stays success.
    await h.executor.stopHosting(runId);
    const goneRun = h.enqueue({ ports: [8000], hosting: { enabled: true } });
    h.executor.startRun(goneRun);
    await waitForStatus(h, goneRun, "success");
    await waitForIdle(h);
    await h.executor.stopHosting(goneRun);
    h.db.runs.update(goneRun, { hostedUntil: "2020-01-01T00:00:00.000Z" }); // pretend hosted pre-restart
    const after = await reattachHostedRuns({ db: h.db, provider: h.provider, logger });
    expect(after).toEqual({ reattached: 0, cleared: 1 });
    expect(h.db.runs.get(goneRun)?.hostedUntil).toBeUndefined();
    expect(h.db.runs.get(goneRun)?.status).toBe("success");
  });
});

describe("hosting sweeper service (#110)", () => {
  it("ticks the sweep on its interval and stops cleanly", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" });
    const runId = h.enqueue({ ports: [8000], hosting: { enabled: true, keepAliveMinutes: 5 } });
    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await waitForIdle(h);
    // Force the TTL into the past so the service's first tick expires it.
    h.db.runs.update(runId, { hostedUntil: new Date(Date.now() - 1_000).toISOString() });

    let sweeps = 0;
    const sweeper = startHostingSweeper({
      db: h.db,
      provider: h.provider,
      logger,
      intervalMs: 20,
      stopHosted: async (id) => {
        sweeps += 1;
        return (await h.executor.stopHosting(id)).outcome === "stopped";
      },
    });
    try {
      const deadline = Date.now() + 2_000;
      while (h.db.runs.get(runId)?.hostedUntil !== undefined) {
        if (Date.now() > deadline) throw new Error("sweeper never expired the hosted run");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(sweeps).toBeGreaterThanOrEqual(1);
      expect(await h.provider.list({ run: runId })).toEqual([]);
    } finally {
      sweeper.stop();
    }
    // Stopped: no more ticks land.
    const settled = sweeps;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sweeps).toBe(settled);
  });
});
