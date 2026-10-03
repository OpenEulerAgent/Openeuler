import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectSandboxPolicy } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { cacheVolumeName } from "@openeuler/engine";
import { SandboxError, createFakeSandboxProvider } from "@openeuler/sandbox";
import type { DockerCliRunner, SandboxProvider } from "@openeuler/sandbox";
import { recordSandboxKeptActivity } from "./activity.js";
import { countActiveSandboxes } from "./metrics.js";
import {
  CACHE_VOLUME_PREFIX,
  DEFAULT_DEBUG_GRACE_MS,
  DEFAULT_GC_GRACE_MS,
  cacheVolumePrefixFor,
  checkDiskPressure,
  pruneOrphanCacheVolumes,
  removeProjectCacheVolumes,
  runSandboxGc,
  startPeriodicSandboxGc,
} from "./sandbox-gc.js";
import { createLogger } from "./logger.js";

/**
 * Unit coverage for the sandbox GC (#105): reconciliation decisions (fake
 * provider + fake clock), orphan cache-volume pruning, disk-pressure
 * parsing, the periodic runner, and the MAX_SANDBOXES env resolution. All
 * docker CLI surface is scripted — no real daemon is touched here (the
 * docker-gated e2e lives in sandbox-gc.integration.test.ts).
 */

const logger = createLogger("silent");

const HOUR = 60 * 60 * 1000;

/** Scripted docker CLI runner keyed by command (records every call). */
class FakeDockerRunner {
  readonly calls: string[][] = [];
  /** Volume names `volume ls` reports (mutated by successful `volume rm`). */
  volumes = new Set<string>();
  /** `system df --format json` stdout. */
  systemDfStdout = "";
  /** `docker info --format {{.DockerRootDir}}` stdout. */
  dockerRootDir = "/var/lib/docker";
  /** When set, every call rejects with this error. */
  failWith: Error | null = null;

  run: DockerCliRunner = async (args) => {
    this.calls.push([...args]);
    if (this.failWith !== null) throw this.failWith;
    const joined = args.join(" ");
    if (args[0] === "volume" && args[1] === "ls") {
      return { code: 0, stdout: [...this.volumes].join("\n"), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "rm") {
      const name = args[2] ?? "";
      if (!this.volumes.has(name)) {
        return { code: 1, stdout: "", stderr: `Error: no such volume: ${name}` };
      }
      this.volumes.delete(name);
      return { code: 0, stdout: name, stderr: "" };
    }
    if (joined.startsWith("system df")) {
      return { code: 0, stdout: this.systemDfStdout, stderr: "" };
    }
    if (joined.startsWith("info")) {
      return { code: 0, stdout: this.dockerRootDir, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected docker call: ${joined}` };
  };
}

interface Harness {
  db: Db;
  dir: string;
  provider: ReturnType<typeof createFakeSandboxProvider>;
  runner: FakeDockerRunner;
  projectId: string;
  /** Creates a run row (status default `success`) + returns its id. */
  addRun(status?: "queued" | "running" | "success" | "failed" | "interrupted"): string;
  /** Creates a provider sandbox labeled for the run. */
  addSandbox(runId: string): Promise<string>;
}

const created: Harness[] = [];

const setup = (policy?: ProjectSandboxPolicy): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-gc-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: "/tmp/repo",
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  if (policy !== undefined) db.projects.setSandboxPolicy(project.id, policy);
  const provider = createFakeSandboxProvider();
  const harness: Harness = {
    db,
    dir,
    provider,
    runner: new FakeDockerRunner(),
    projectId: project.id,
    addRun(status = "success") {
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.runs.create({
        id: runId,
        projectId: project.id,
        status: "queued",
        branch: `agentloop/${runId}`,
        iteration: 0,
        task: "gc test",
        createdAt: now,
        updatedAt: now,
      });
      db.runs.update(runId, { status }); // bumps updatedAt to ~now
      return runId;
    },
    async addSandbox(runId: string) {
      const handle = await provider.create({
        runId,
        image: "busybox:1.36",
        mounts: [],
        env: {},
        labels: { run: runId },
      });
      return handle.id;
    },
  };
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

const gc = (h: Harness, extra: Record<string, unknown> = {}) =>
  runSandboxGc({
    db: h.db,
    provider: h.provider,
    logger,
    runner: h.runner.run,
    ...extra,
  });

const gcEvents = (h: Harness): Array<Record<string, unknown>> =>
  h.db.activity
    .list({ limit: 100 })
    .filter((row) => row.type === "ops.gc")
    .map((row) => row.payload ?? {});

describe("runSandboxGc (#105)", () => {
  it("destroys a terminal sandbox beyond grace and records the ops.gc counts", async () => {
    const h = setup();
    const runId = h.addRun("failed");
    await h.addSandbox(runId);

    const counts = await gc(h, { now: () => Date.now() + 2 * HOUR });

    expect(counts).toEqual({ destroyed: 1, kept: 0, orphans: 0, cacheVolumesPruned: 0 });
    expect(await h.provider.list()).toEqual([]);
    const events = gcEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ destroyed: 1, kept: 0, orphans: 0, cacheVolumesPruned: 0 });
  });

  it("keeps a terminal sandbox within the grace window", async () => {
    const h = setup();
    const runId = h.addRun("success");
    await h.addSandbox(runId);

    const counts = await gc(h, { now: () => Date.now() + 30 * 60 * 1000 });

    expect(counts).toEqual({ destroyed: 0, kept: 1, orphans: 0, cacheVolumesPruned: 0 });
    expect(await h.provider.list({ run: runId })).toHaveLength(1);
    // Periodic passes only emit ops.gc when something was collected.
    expect(gcEvents(h)).toHaveLength(0);
  });

  it("keeps sandboxes of runs the executor holds (active map)", async () => {
    const h = setup();
    const runId = h.addRun("success"); // terminal ROW, but executor-live
    await h.addSandbox(runId);

    const counts = await gc(h, { now: () => Date.now() + 10 * HOUR, activeRunIds: () => [runId] });

    expect(counts).toEqual({ destroyed: 0, kept: 1, orphans: 0, cacheVolumesPruned: 0 });
  });

  it("keeps sandboxes of queued/running run rows (crash leftovers, grace applies later)", async () => {
    const h = setup();
    const queued = h.addRun("queued");
    const running = h.addRun("running");
    await h.addSandbox(queued);
    await h.addSandbox(running);

    const counts = await gc(h, { now: () => Date.now() + 10 * HOUR });

    expect(counts).toEqual({ destroyed: 0, kept: 2, orphans: 0, cacheVolumesPruned: 0 });
  });

  it("keeps a keepForDebug sandbox within the debug grace (policy OR kept-activity)", async () => {
    const h = setup({ executionMode: "sandbox", image: "busybox:1.36", keepForDebug: true });
    const policyRun = h.addRun("success");
    await h.addSandbox(policyRun);
    // Same project, no keepForDebug policy signal… but the feed says kept.
    const activityRun = h.addRun("success");
    await h.addSandbox(activityRun);
    recordSandboxKeptActivity(h.db, {
      runId: activityRun,
      container: "whatever",
      image: "busybox:1.36",
    });

    const counts = await gc(h, { now: () => Date.now() + 2 * HOUR }); // past basic grace

    expect(counts).toEqual({ destroyed: 0, kept: 2, orphans: 0, cacheVolumesPruned: 0 });
  });

  it("destroys a keepForDebug sandbox past the debug grace (default 4h)", async () => {
    const h = setup({ executionMode: "sandbox", image: "busybox:1.36", keepForDebug: true });
    const runId = h.addRun("success");
    await h.addSandbox(runId);

    const counts = await gc(h, { now: () => Date.now() + DEFAULT_DEBUG_GRACE_MS + HOUR });

    expect(counts).toEqual({ destroyed: 1, kept: 0, orphans: 0, cacheVolumesPruned: 0 });
    expect(await h.provider.list()).toEqual([]);
  });

  it("reaps orphans: no run label, or a label naming an unknown run", async () => {
    const h = setup();
    const known = h.addRun("running");
    await h.addSandbox(known);
    const unlabeled = await h.provider.create({
      runId: "never-committed",
      image: "busybox:1.36",
      mounts: [],
      env: {},
      labels: {},
    });
    const ghost = await h.provider.create({
      runId: "ghost",
      image: "busybox:1.36",
      mounts: [],
      env: {},
      labels: { run: "no-such-run" },
    });

    const counts = await gc(h);

    expect(counts).toEqual({ destroyed: 0, kept: 1, orphans: 2, cacheVolumesPruned: 0 });
    const alive = await h.provider.list();
    expect(alive).toHaveLength(1);
    expect(alive[0]?.labels).toEqual({ run: known });
    expect(h.provider.destroyCalls.map((call) => call.sandboxId)).toEqual(
      expect.arrayContaining([unlabeled.id, ghost.id]),
    );
    const events = gcEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ orphans: 2, kept: 1 });
  });

  it("never throws when the provider list fails; boot sweep still emits an error event", async () => {
    const h = setup();
    const failing: SandboxProvider = {
      id: "failing",
      create: () => Promise.reject(new SandboxError("SANDBOX_UNAVAILABLE", "docker down")),
      list: () => Promise.reject(new SandboxError("SANDBOX_UNAVAILABLE", "docker down")),
    };

    const counts = await runSandboxGc({
      db: h.db,
      provider: failing,
      logger,
      runner: h.runner.run,
    });
    expect(counts).toEqual({ destroyed: 0, kept: 0, orphans: 0, cacheVolumesPruned: 0 });
    expect(gcEvents(h)).toHaveLength(0);

    const boot = await runSandboxGc(
      { db: h.db, provider: failing, logger, runner: h.runner.run },
      { emitWhenIdle: true },
    );
    expect(boot.destroyed).toBe(0);
    expect(gcEvents(h)).toHaveLength(1);
    expect(gcEvents(h)[0]).toMatchObject({ error: expect.stringContaining("docker down") });
  });

  it("boot sweeps emit ops.gc even with zero counts (mirrors the recovery sweep)", async () => {
    const h = setup();
    await runSandboxGc(
      { db: h.db, provider: h.provider, logger, runner: h.runner.run },
      { emitWhenIdle: true },
    );
    const events = gcEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ destroyed: 0, kept: 0, orphans: 0, cacheVolumesPruned: 0 });
  });

  it("the metrics gauge reflects the post-GC sandbox count", async () => {
    const h = setup();
    const stale = h.addRun("failed");
    await h.addSandbox(stale);
    expect(await countActiveSandboxes({ sandbox: { provider: h.provider } })).toBe(1);

    await gc(h, { now: () => Date.now() + 2 * HOUR });

    expect(await countActiveSandboxes({ sandbox: { provider: h.provider } })).toBe(0);
  });
});

describe("cache volume hygiene (#105, from #148 QA)", () => {
  it("prunes orphan cache volumes but keeps live projects' and foreign volumes", async () => {
    const h = setup();
    const live = cacheVolumeName(h.projectId, "/workspace/node_modules");
    const orphan = cacheVolumeName(crypto.randomUUID(), "/workspace/.pnpm-store");
    h.runner.volumes.add(live);
    h.runner.volumes.add(orphan);
    h.runner.volumes.add("totally-foreign-volume");

    const pruned = await pruneOrphanCacheVolumes({ db: h.db, logger, runner: h.runner.run });

    expect(pruned).toBe(1);
    expect(h.runner.volumes.has(live)).toBe(true);
    expect(h.runner.volumes.has(orphan)).toBe(false);
    expect(h.runner.volumes.has("totally-foreign-volume")).toBe(true);
    const rmCalls = h.runner.calls.filter((call) => call[1] === "rm");
    expect(rmCalls).toEqual([["volume", "rm", orphan]]);
  });

  it("prunes orphan cache volumes as part of a GC pass (counted in ops.gc)", async () => {
    const h = setup();
    const orphan = cacheVolumeName(crypto.randomUUID(), "/workspace/node_modules");
    h.runner.volumes.add(orphan);

    const counts = await gc(h);

    expect(counts.cacheVolumesPruned).toBe(1);
    expect(gcEvents(h)[0]).toMatchObject({ cacheVolumesPruned: 1 });
  });

  it("removeProjectCacheVolumes removes exactly the project's volumes, tolerating missing ones", async () => {
    const h = setup();
    const mine = cacheVolumeName(h.projectId, "/workspace/node_modules");
    const other = cacheVolumeName(crypto.randomUUID(), "/workspace/node_modules");
    h.runner.volumes.add(mine);
    h.runner.volumes.add(other);

    const removed = await removeProjectCacheVolumes(h.projectId, {
      db: h.db,
      logger,
      runner: h.runner.run,
    });

    expect(removed).toBe(1);
    expect(h.runner.volumes.has(mine)).toBe(false);
    expect(h.runner.volumes.has(other)).toBe(true);
    // Already-missing volumes resolve 0, never throw.
    const again = await removeProjectCacheVolumes(h.projectId, {
      db: h.db,
      logger,
      runner: h.runner.run,
    });
    expect(again).toBe(0);
  });

  it("volume-list failures degrade to zero (docker down never breaks the caller)", async () => {
    const h = setup();
    h.runner.failWith = new SandboxError("SANDBOX_UNAVAILABLE", "docker CLI unavailable");
    expect(
      await removeProjectCacheVolumes(h.projectId, { db: h.db, logger, runner: h.runner.run }),
    ).toBe(0);
    expect(await pruneOrphanCacheVolumes({ db: h.db, logger, runner: h.runner.run })).toBe(0);
  });

  it("cacheVolumePrefixFor matches the engine's cacheVolumeName shape", () => {
    const projectId = crypto.randomUUID();
    const name = cacheVolumeName(projectId, "/workspace/node_modules");
    expect(name.startsWith(cacheVolumePrefixFor(projectId))).toBe(true);
    expect(name.startsWith(CACHE_VOLUME_PREFIX)).toBe(true);
    // A sibling project's prefix must not match.
    expect(name.startsWith(cacheVolumePrefixFor(crypto.randomUUID()))).toBe(false);
  });
});

const systemDf = (rows: Array<{ Type: string; Size: string; Reclaimable?: string }>): string =>
  rows.map((row) => JSON.stringify(row)).join("\n");

describe("disk pressure (#105)", () => {
  const GB = 1_000_000_000;

  it("parses `docker system df` and compares against the backing filesystem", async () => {
    const h = setup();
    h.runner.systemDfStdout = systemDf([
      { Type: "Images", Size: "80GB", Reclaimable: "40GB (50%)" },
      { Type: "Containers", Size: "5GB", Reclaimable: "0B (0%)" },
      { Type: "Local Volumes", Size: "15GB", Reclaimable: "10GB (66%)" },
    ]);
    const fsTotalBytes = async () => 100 * GB;

    const snapshot = await checkDiskPressure({ runner: h.runner.run, fsTotalBytes });

    expect(snapshot).toMatchObject({
      dockerDataBytes: 100 * GB,
      reclaimableBytes: 50 * GB,
      fsTotalBytes: 100 * GB,
      usedPct: 100,
    });
  });

  it("warns via an ops.gc event above the threshold — no warning below it", async () => {
    const h = setup();
    h.runner.systemDfStdout = systemDf([
      { Type: "Images", Size: "90GB", Reclaimable: "60GB (66%)" },
      { Type: "Local Volumes", Size: "5GB" },
    ]);
    const fsTotalBytes = async () => 100 * GB;

    const { warnOnDiskPressure } = await import("./sandbox-gc.js");
    const hot = await warnOnDiskPressure({
      db: h.db,
      runner: h.runner.run,
      fsTotalBytes,
    });
    expect(hot?.usedPct).toBe(95);
    const events = gcEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ warning: expect.stringContaining("disk-pressure") });

    h.runner.systemDfStdout = systemDf([{ Type: "Images", Size: "10GB" }]);
    const cool = await warnOnDiskPressure({ db: h.db, runner: h.runner.run, fsTotalBytes });
    expect(cool?.usedPct).toBe(10);
    expect(gcEvents(h)).toHaveLength(1); // nothing new
  });

  it("resolves undefined when the numbers cannot be gathered", async () => {
    const h = setup();
    h.runner.failWith = new SandboxError("SANDBOX_UNAVAILABLE", "docker CLI unavailable");
    expect(await checkDiskPressure({ runner: h.runner.run })).toBeUndefined();
    expect(
      await checkDiskPressure({
        runner: new FakeDockerRunner().run,
        fsTotalBytes: async () => undefined,
      }),
    ).toBeUndefined();
  });
});

describe("startPeriodicSandboxGc (#105)", () => {
  it("runs passes on the interval; stop() clears the timer and is idempotent", async () => {
    const h = setup();
    const stale = h.addRun("failed");
    await h.addSandbox(stale);
    h.runner.systemDfStdout = systemDf([{ Type: "Images", Size: "1GB" }]);
    const fsTotalBytes = async () => 1000 * 1_000_000_000;

    const periodic = startPeriodicSandboxGc({
      db: h.db,
      provider: h.provider,
      logger,
      runner: h.runner.run,
      intervalMs: 30,
      fsTotalBytes,
      now: () => Date.now() + 2 * HOUR, // stale terminal rows are past grace
    });

    // Boot sweep always emits, collects the stale sandbox.
    const boot = await periodic.bootSweep();
    expect(boot.destroyed).toBe(1);
    expect(gcEvents(h)).toHaveLength(1);

    // Periodic tick with nothing to do stays silent (no feed spam).
    await periodic.runNow();
    expect(gcEvents(h)).toHaveLength(1);

    periodic.stop();
    periodic.stop(); // idempotent
    const ticks = h.runner.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.runner.calls.length).toBe(ticks); // no further docker calls
  });
});

describe("runSandboxGc grace defaults", () => {
  it("basic grace is 1h, debug grace 4h", () => {
    expect(DEFAULT_GC_GRACE_MS).toBe(60 * 60 * 1000);
    expect(DEFAULT_DEBUG_GRACE_MS).toBe(4 * 60 * 60 * 1000);
  });
});
