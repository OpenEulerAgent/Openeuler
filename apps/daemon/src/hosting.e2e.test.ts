import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import {
  createDockerAvailabilityProbe,
  createDockerSandboxProvider,
  docker,
} from "@openeuler/sandbox";
import type { SandboxProvider } from "@openeuler/sandbox";
import { createApp } from "./app.js";
import { createExecutor } from "./executor.js";
import type { Executor, RunHostingView } from "./executor.js";
import { runHostingSweep } from "./hosting.js";
import { createLogger } from "./logger.js";

/**
 * Real-docker e2e of hosted runs (#110), following the #108 preview-proxy
 * integration patterns: a sandboxed busybox run whose driver onStart boots
 * `busybox httpd` in the container, created with `hosting` + declared
 * ports. After the run SUCCEEDS the sandbox must stay alive and the
 * preview proxy must keep serving; extend bumps the TTL; Stop hosting
 * destroys now (409 afterwards); the TTL sweeper expires a forced-past
 * window (destroy + `ops.hosting-expired`). Auto-skips without a docker
 * daemon (`DOCKER_E2E=0` or a failed probe).
 */

const BUSYBOX = "busybox:1.36";

const dockerLive =
  process.env.DOCKER_E2E === "0"
    ? false
    : await createDockerAvailabilityProbe().check({ force: true });

interface Harness {
  dir: string;
  db: Db;
  executor: Executor;
  provider: SandboxProvider;
  projectId: string;
  runIds: string[];
  request: (path: string, init?: RequestInit) => Promise<Response>;
  enqueue(ports: number[], hosting: { enabled: boolean; keepAliveMinutes?: number }): string;
}

let harness: Harness | null = null;

const setup = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-hosting-e2e-"));
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
    image: BUSYBOX,
  });

  const drivers = createDriverRegistry();
  drivers.registerDriver(
    createFakeDriver({
      events: [{ type: "done", seq: 1, output: "serving" }],
      output: "Server listening on port 3000",
      onStart: async (opts) => {
        if (opts.exec === undefined) throw new Error("expected exec seam");
        await opts.exec.run([
          "sh",
          "-c",
          [
            "mkdir -p /www",
            "echo 'hello hosted' > /www/index.html",
            // Daemonizes: the exec returns while httpd keeps serving past
            // the run's own success — exactly the hosted-run shape.
            "httpd -p 3000 -h /www",
          ].join(" && "),
        ]);
      },
    }),
  );
  const provider = createDockerSandboxProvider();
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot: join(dir, "store") }),
    drivers,
    logger: createLogger("silent"),
    sandbox: { provider, isDockerAvailable: async () => true },
  });
  const { app } = createApp({ db, logger: createLogger("silent"), executor });

  const runIds: string[] = [];
  const h: Harness = {
    dir,
    db,
    executor,
    provider,
    projectId: project.id,
    runIds,
    request: (path, init) => Promise.resolve(app.request(path, init)),
    enqueue(ports, hosting) {
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.runs.create({
        id: runId,
        projectId: project.id,
        status: "queued",
        branch: `agentloop/${runId}`,
        iteration: 0,
        task: "serve it",
        ports,
        hosting,
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
      runIds.push(runId);
      return runId;
    },
  };
  return h;
};

const waitForStatus = async (h: Harness, runId: string, status: RunStatus): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (h.db.runs.get(runId)?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${status}: currently ${h.db.runs.get(runId)?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const waitForIdle = async (h: Harness): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (h.executor.activeRunIds().length > 0) {
    if (Date.now() > deadline) throw new Error("executor never went idle");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Container names still alive for one of this suite's run ids. */
const containersFor = async (runId: string): Promise<string[]> => {
  const result = await docker(["ps", "-aq", "--filter", `label=run=${runId}`], {
    timeoutMs: 30_000,
  });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

/** Polls GET /previews/:runId/3000/ until it answers 200 (httpd boot). */
const waitUntilServing = async (h: Harness, runId: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = await h.request(`/previews/${runId}/3000/`);
    if (res.status === 200) return;
    if (Date.now() > deadline) throw new Error(`httpd never came up (last: ${res.status})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe.skipIf(!dockerLive)("hosted runs e2e (real sandbox, #110)", () => {
  beforeAll(async () => {
    const present = await docker(["image", "inspect", BUSYBOX], { timeoutMs: 30_000 });
    if (present.code !== 0) {
      const pull = await docker(["pull", BUSYBOX], { timeoutMs: 300_000 });
      if (pull.code !== 0) throw new Error(`failed to pull ${BUSYBOX}: ${pull.stderr}`);
    }
  }, 360_000);

  it("hosts past success: preview serves AFTER the run, extend bumps, Stop hosting destroys", async () => {
    const h = setup();
    harness = h;
    const runId = h.enqueue([3000], { enabled: true, keepAliveMinutes: 5 });

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await waitForIdle(h);

    // Hosted: row stays success with a ~5m TTL, container alive.
    const run = h.db.runs.get(runId);
    expect(run?.status).toBe("success");
    const until = Date.parse(run?.hostedUntil ?? "");
    expect(until).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 5_000);
    expect(await containersFor(runId)).toHaveLength(1);

    // THE point of #110: the preview proxy still serves after success.
    await waitUntilServing(h, runId);
    const index = await h.request(`/previews/${runId}/3000/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("hello hosted");

    // The detail carries the hosting view with the live mapping.
    const detail = (await (await h.request(`/api/runs/${runId}`)).json()) as {
      hosting: RunHostingView;
    };
    expect(Date.parse(detail.hosting.until)).toBe(until);
    expect(detail.hosting.ports).toEqual([{ container: 3000, host: expect.any(Number) }]);
    expect(detail.hosting.extendable).toBe(true);

    // Extend +30m: hostedUntil moves ~30 minutes out.
    const extend = await h.request(`/api/runs/${runId}/hosting/extend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: 30 }),
    });
    expect(extend.status).toBe(200);
    const extended = (await extend.json()) as { hosting: RunHostingView };
    expect(Date.parse(extended.hosting.until)).toBeGreaterThan(until + 29 * 60_000);
    expect(await containersFor(runId)).toHaveLength(1);

    // Stop hosting: destroys NOW, run stays success, preview goes 410.
    const stop = await h.request(`/api/runs/${runId}/hosting/stop`, { method: "POST" });
    expect(stop.status).toBe(200);
    expect(h.db.runs.get(runId)).toMatchObject({ status: "success" });
    expect(h.db.runs.get(runId)?.hostedUntil).toBeUndefined();
    expect(await containersFor(runId)).toEqual([]);
    const gone = await h.request(`/previews/${runId}/3000/`);
    expect(gone.status).toBe(410);
    const secondStop = await h.request(`/api/runs/${runId}/hosting/stop`, { method: "POST" });
    expect(secondStop.status).toBe(409);
  }, 240_000);

  it("TTL expiry destroys the hosted sandbox and records ops.hosting-expired", async () => {
    const h = setup();
    harness = h;
    const runId = h.enqueue([3000], { enabled: true, keepAliveMinutes: 5 });

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await waitForIdle(h);
    await waitUntilServing(h, runId);
    expect(await containersFor(runId)).toHaveLength(1);

    // Short-TTL expiry, compressed: force the window into the past and run
    // one hosting sweep (the same pass the 1-minute sweeper would tick).
    const forcedUntil = new Date(Date.now() - 1_000).toISOString();
    h.db.runs.update(runId, { hostedUntil: forcedUntil });
    const counts = await runHostingSweep({
      db: h.db,
      provider: h.provider,
      logger: createLogger("silent"),
      stopHosted: async (id) => (await h.executor.stopHosting(id)).outcome === "stopped",
    });
    expect(counts).toEqual({ expired: 1, kept: 0 });

    expect(await containersFor(runId)).toEqual([]);
    expect(h.db.runs.get(runId)).toMatchObject({ status: "success" });
    expect(h.db.runs.get(runId)?.hostedUntil).toBeUndefined();
    const expired = h.db.activity
      .list({ limit: 20 })
      .find((row) => row.type === "ops.hosting-expired" && row.runId === runId);
    expect(expired?.payload).toMatchObject({ runId, until: forcedUntil });
  }, 240_000);

  afterAll(async () => {
    // Belt and braces: zero leftovers even when a test fails midway.
    if (harness !== null) {
      await harness.executor.shutdown().catch(() => {});
      for (const runId of harness.runIds) {
        for (const id of await containersFor(runId)) {
          await docker(["rm", "-f", id], { timeoutMs: 30_000 }).catch(() => {});
        }
      }
      harness.db.close();
      rmSync(harness.dir, { recursive: true, force: true });
      harness = null;
    }
  });
});
