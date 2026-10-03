import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import type { FakeDriver } from "@openeuler/drivers";
import { WorktreeManager, cacheVolumeName } from "@openeuler/engine";
import {
  SandboxError,
  createDockerAvailabilityProbe,
  createDockerSandboxProvider,
  docker,
} from "@openeuler/sandbox";
import type { SandboxProvider } from "@openeuler/sandbox";
import { createExecutor } from "./executor.js";
import type { Executor } from "./executor.js";
import { createLogger } from "./logger.js";

/**
 * Real-docker e2e of sandboxed run execution (#102), following the #99/#101
 * integration patterns: a fake driver whose onStart drives the run's exec
 * seam INSIDE a real container. Verifies the issue checklist end to end —
 * worktree↔container bind mount round-trip (incl. git status), cache
 * volumes persisting across runs, abort tearing the container down, typed
 * create failures, and keepForDebug retention. Auto-skips without a docker
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
  worktrees: WorktreeManager;
  executor: Executor;
  driver: FakeDriver;
  provider: SandboxProvider;
  projectId: string;
  runIds: string[];
  enqueue(ports?: number[]): string;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

let harness: Harness | null = null;

const setup = (fakeOpts: Parameters<typeof createFakeDriver>[0]): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-e2e-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  git(repoPath, "add", "-A");
  git(repoPath, "-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init");

  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: repoPath,
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });

  const drivers = createDriverRegistry();
  const driver = createFakeDriver(fakeOpts);
  drivers.registerDriver(driver);
  const worktrees = new WorktreeManager({ storeRoot: join(dir, "store") });
  const provider = createDockerSandboxProvider();
  const executor = createExecutor({
    db,
    worktrees,
    drivers,
    logger: createLogger("silent"),
    sandbox: { provider, isDockerAvailable: async () => true },
  });

  const runIds: string[] = [];
  const h: Harness = {
    dir,
    db,
    worktrees,
    executor,
    driver,
    provider,
    projectId: project.id,
    runIds,
    enqueue(ports?: number[]) {
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.runs.create({
        id: runId,
        projectId: project.id,
        status: "queued",
        branch: `agentloop/${runId}`,
        iteration: 0,
        task: "make it green",
        ...(ports === undefined || ports.length === 0 ? {} : { ports }),
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

describe.skipIf(!dockerLive)("executor sandbox e2e (real daemon, #102)", () => {
  beforeAll(async () => {
    const present = await docker(["image", "inspect", BUSYBOX], { timeoutMs: 30_000 });
    if (present.code !== 0) {
      const pull = await docker(["pull", BUSYBOX], { timeoutMs: 300_000 });
      if (pull.code !== 0) throw new Error(`failed to pull ${BUSYBOX}: ${pull.stderr}`);
    }
  });

  it("a sandboxed run writes into /workspace → the worktree (bind rw), git sees it, sandbox destroyed", async () => {
    harness = setup({
      events: [{ type: "done", seq: 1, output: "done" }],
      output: "done",
      onStart: async (opts) => {
        // Awaited by the fake driver before any event streams, so the file
        // exists on disk before the run can finish (no destroy race).
        await opts.exec?.run(["touch", "/workspace/hello.txt"]);
      },
    });
    const h = harness;
    h.db.projects.setSandboxPolicy(h.projectId, {
      executionMode: "sandbox",
      image: BUSYBOX,
    });
    const runId = h.enqueue();

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await waitForIdle(h);

    // The bind mount is rw: the container write landed in the HOST worktree…
    const worktreePath = join(h.worktrees.storeRoot, runId);
    expect(existsSync(join(worktreePath, "hello.txt"))).toBe(true);
    // …and git status of the worktree shows it (issue checklist). The
    // engine's step-diff snapshots `git add -A`, so the new file may read
    // as staged (`A `) instead of untracked (`??`).
    expect(git(worktreePath, "status", "--porcelain")).toMatch(/\?{2} hello\.txt|A {2}hello\.txt/);

    // Driver executed in the container workspace.
    expect(h.driver.calls[0]?.cwd).toBe("/workspace");

    // Terminal → exactly one sandbox created and destroyed; nothing leaks.
    const leftovers = await containersFor(runId);
    expect(leftovers).toEqual([]);
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
    harness = null;
  }, 120_000);

  it("policy.cachePaths volumes persist across sequential runs (second run reads the first's file)", async () => {
    const markerOutputs: string[] = [];
    harness = setup({
      events: [{ type: "done", seq: 1, output: "done" }],
      output: "done",
      onStart: async (opts) => {
        if (opts.exec === undefined) throw new Error("expected exec seam");
        if (markerOutputs.length === 0) {
          await opts.exec.run([
            "sh",
            "-c",
            "mkdir -p /workspace/.cache-demo && echo hello > /workspace/.cache-demo/marker.txt",
          ]);
        } else {
          const read = await opts.exec.run(["cat", "/workspace/.cache-demo/marker.txt"]);
          markerOutputs.push(read.stdout.trim());
        }
      },
    });
    const h = harness;
    h.db.projects.setSandboxPolicy(h.projectId, {
      executionMode: "sandbox",
      image: BUSYBOX,
      cachePaths: ["/workspace/.cache-demo"],
    });

    const first = h.enqueue();
    h.executor.startRun(first);
    await waitForStatus(h, first, "success");
    await waitForIdle(h);
    markerOutputs.push("first-done"); // flip to read-mode for the second run

    const second = h.enqueue();
    h.executor.startRun(second);
    await waitForStatus(h, second, "success");
    await waitForIdle(h);

    expect(markerOutputs).toEqual(["first-done", "hello"]);

    for (const runId of [first, second]) {
      expect(await containersFor(runId)).toEqual([]);
    }
    // The named cache volume persists BY DESIGN; this suite removes its own.
    await docker(["volume", "rm", "-f", cacheVolumeName(h.projectId, "/workspace/.cache-demo")], {
      timeoutMs: 30_000,
    });
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
    harness = null;
  }, 180_000);

  it("aborting mid-run tears the sandbox down (container gone)", async () => {
    harness = setup({
      events: [{ type: "message-delta", seq: 1, delta: "working" }],
      delayMs: 60_000,
      onStart: (opts) => {
        // In-flight when abort lands: the seam rejection is the abort path
        // (caught here — the void'ed promise must never reject unhandled).
        void opts.exec?.run(["sh", "-c", "sleep 120"]).catch(() => {});
      },
    });
    const h = harness;
    h.db.projects.setSandboxPolicy(h.projectId, {
      executionMode: "sandbox",
      image: BUSYBOX,
    });
    const runId = h.enqueue();

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "running");
    // Wait for the container to exist (sandbox created) before aborting.
    const deadline = Date.now() + 30_000;
    while ((await containersFor(runId)).length === 0) {
      if (Date.now() > deadline) throw new Error("sandbox container never appeared");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const abort = await h.executor.abortRun(runId);
    expect(abort).toEqual({ outcome: "aborted" });
    await waitForIdle(h);

    expect(h.db.runs.get(runId)?.status).toBe("aborted");
    expect(await containersFor(runId)).toEqual([]);
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
    harness = null;
  }, 120_000);

  it("sandbox create failure fails the run typed+actionable", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "done" }], output: "done" });
    const failing: SandboxProvider = {
      id: "docker",
      create: () =>
        Promise.reject(
          new SandboxError(
            "SANDBOX_UNAVAILABLE",
            "docker is not available (CLI missing from PATH or daemon unreachable)",
          ),
        ),
      list: () => h.provider.list(),
    };
    const executor = createExecutor({
      db: h.db,
      worktrees: h.worktrees,
      drivers: (() => {
        const registry = createDriverRegistry();
        registry.registerDriver(h.driver);
        return registry;
      })(),
      logger: createLogger("silent"),
      sandbox: { provider: failing, isDockerAvailable: async () => true },
    });
    h.db.projects.setSandboxPolicy(h.projectId, {
      executionMode: "sandbox",
      image: BUSYBOX,
    });
    const runId = h.enqueue();

    executor.startRun(runId);
    await waitForStatus(h, runId, "failed");

    const run = h.db.runs.get(runId);
    expect(run?.error).toContain("docker is not available");
    expect(run?.error).toMatch(/sandbox|docker/i);
    expect(h.driver.calls).toHaveLength(0); // the sandbox is a precondition
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }, 60_000);

  it("declared port is published + detected: host mapping live, HTTP reachable, row recorded (#107)", async () => {
    harness = setup({
      events: [
        { type: "message-delta", seq: 1, delta: "booting" },
        { type: "message-delta", seq: 2, delta: "ready" },
      ],
      delayMs: 1_500,
      output: "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/)",
      onStart: async (opts) => {
        // busybox httpd in the background inside the container; awaited so
        // the server is up before any event streams (and thus before the
        // run can finish).
        await opts.exec?.run([
          "sh",
          "-c",
          "httpd -f -p 8000 >/dev/null 2>&1 & sleep 0.5; echo started",
        ]);
      },
    });
    const h = harness;
    h.db.projects.setSandboxPolicy(h.projectId, {
      executionMode: "sandbox",
      image: BUSYBOX,
    });
    const runId = h.enqueue([8000]);

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "running");

    // While the run executes: the declared port is published and the live
    // sandbox info maps it to an ephemeral host port.
    const deadline = Date.now() + 30_000;
    let hostPort: number | undefined;
    let liveDeclared: boolean | undefined;
    while (Date.now() < deadline) {
      const info = await h.executor.sandboxInfo(runId);
      const view = info?.ports?.find((port) => port.container === 8000);
      hostPort = view?.host;
      liveDeclared = view?.declared;
      if (hostPort !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(hostPort).toBeDefined();
    expect(liveDeclared).toBe(true);

    // The published binding is reachable from the host (loopback publish).
    // The mapping exists as soon as the sandbox is created — before the
    // driver's onStart has booted httpd — so retry until it answers.
    // busybox httpd returns 404 for / without an index; any HTTP response
    // is the proof.
    let response: Response | undefined;
    const fetchDeadline = Date.now() + 30_000;
    while (Date.now() < fetchDeadline) {
      try {
        response = await fetch(`http://127.0.0.1:${hostPort}/`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    expect(response).toBeDefined();
    expect(response?.status).toBeGreaterThan(0);
    await response?.arrayBuffer();

    await waitForStatus(h, runId, "success");
    await waitForIdle(h);

    // Detection scanned the node output (python http.server wording):
    // declared port recorded as detected on the run row.
    expect(h.db.runs.get(runId)).toMatchObject({ ports: [8000], detectedPorts: [8000] });
    expect(await containersFor(runId)).toEqual([]);
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
    harness = null;
  }, 180_000);

  it("an UNdeclared listening port is detected but not published (hint only, #107 cut)", async () => {
    harness = setup({
      events: [
        { type: "message-delta", seq: 1, delta: "booting" },
        { type: "message-delta", seq: 2, delta: "ready" },
      ],
      delayMs: 1_500,
      output: "dev server listening on :8001",
      onStart: async (opts) => {
        await opts.exec?.run([
          "sh",
          "-c",
          "httpd -f -p 8001 >/dev/null 2>&1 & sleep 0.5; echo started",
        ]);
      },
    });
    const h = harness;
    h.db.projects.setSandboxPolicy(h.projectId, {
      executionMode: "sandbox",
      image: BUSYBOX,
    });
    const runId = h.enqueue(); // nothing declared

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "running");

    // The sandbox publishes nothing (the run declared no ports): docker
    // reports no port mappings for the container…
    const during = await h.executor.sandboxInfo(runId);
    expect(during?.ports).toBeUndefined();
    const mappings = await docker(["port", during?.id ?? ""], { timeoutMs: 30_000 });
    expect(mappings.stdout.trim()).toBe("");

    await waitForStatus(h, runId, "success");
    await waitForIdle(h);

    const run = h.db.runs.get(runId);
    expect(run?.ports).toBeUndefined();
    expect(run?.detectedPorts).toEqual([8001]);
    expect(await containersFor(runId)).toEqual([]);
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
    harness = null;
  }, 180_000);

  it("keepForDebug keeps the container after the run (then cleanup)", async () => {
    harness = setup({ events: [{ type: "done", seq: 1, output: "done" }], output: "done" });
    const h = harness;
    h.db.projects.setSandboxPolicy(h.projectId, {
      executionMode: "sandbox",
      image: BUSYBOX,
      keepForDebug: true,
    });
    const runId = h.enqueue();

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await waitForIdle(h);

    const kept = await containersFor(runId);
    expect(kept).toHaveLength(1);
    expect(
      h.db.activity
        .list({ limit: 50 })
        .some((row) => row.type === "ops.sandbox-kept" && row.runId === runId),
    ).toBe(true);

    for (const id of kept) await docker(["rm", "-f", id], { timeoutMs: 30_000 });
    expect(await containersFor(runId)).toEqual([]);
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
    harness = null;
  }, 120_000);

  afterAll(async () => {
    // Belt and braces: this suite must leave ZERO provider-labeled containers
    // and no test cache volumes behind, even when a test fails midway.
    if (harness !== null) {
      for (const runId of harness.runIds) {
        for (const id of await containersFor(runId)) {
          await docker(["rm", "-f", id], { timeoutMs: 30_000 });
        }
      }
      const volume = cacheVolumeName(harness.projectId, "/workspace/.cache-demo");
      await docker(["volume", "rm", "-f", volume], { timeoutMs: 30_000 });
      harness.db.close();
      rmSync(harness.dir, { recursive: true, force: true });
      harness = null;
    }
  });
});
