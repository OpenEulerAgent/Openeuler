import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { cacheVolumeName } from "@openeuler/engine";
import {
  createDockerAvailabilityProbe,
  createDockerSandboxProvider,
  docker,
} from "@openeuler/sandbox";
import type {
  DockerCliRunner,
  SandboxProvider,
  SandboxSpec,
  SandboxHandle,
} from "@openeuler/sandbox";
import { CACHE_VOLUME_PREFIX, cacheVolumePrefixFor, runSandboxGc } from "./sandbox-gc.js";
import { createLogger } from "./logger.js";

/**
 * Real-docker e2e of the sandbox GC (#105), following the #102 integration
 * patterns: a manually created ghost container (provider labels, unknown
 * run) is swept as an orphan; a keepForDebug sandbox survives its grace and
 * is destroyed past it; an orphan cache volume is pruned while a live
 * project's survives. Auto-skips without a docker daemon (`DOCKER_E2E=0`
 * or a failed probe).
 *
 * Vitest runs files in parallel and other suites share this daemon with
 * their OWN dbs — so the GC's inputs are scoped to resources this suite
 * owns (its db's runs + containers/volumes it created). All docker
 * operations themselves are real; scoping only emulates "the one db" of a
 * production deployment (anything it does not know IS an orphan there).
 */

const BUSYBOX = "busybox:1.36";

const dockerLive =
  process.env.DOCKER_E2E === "0"
    ? false
    : await createDockerAvailabilityProbe().check({ force: true });

interface Harness {
  dir: string;
  db: Db;
  provider: SandboxProvider;
  /** GC-scoped provider: only this suite's runs + owned containers. */
  scoped: SandboxProvider;
  /** GC-scoped runner: only this suite's cache volumes are visible. */
  scopedRunner: DockerCliRunner;
  /** Container names/volume names this suite created (afterAll cleanup). */
  ownedContainers: Set<string>;
  ownedVolumes: Set<string>;
  projectId: string;
  /** Creates a run row in terminal status; returns its id. */
  addTerminalRun(): string;
}

let harness: Harness | null = null;

const setup = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-gc-e2e-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: "/tmp/gc-e2e-repo",
    name: "gc-e2e",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  const provider = createDockerSandboxProvider();
  const ownedContainers = new Set<string>();
  const ownedVolumes = new Set<string>();
  const cachePrefixes = [cacheVolumePrefixFor(project.id)];
  const isMine = (runId: string | undefined): boolean =>
    runId !== undefined && db.runs.get(runId) !== undefined;

  const scoped: SandboxProvider = {
    id: provider.id,
    async create(spec: SandboxSpec): Promise<SandboxHandle> {
      const handle = await provider.create(spec);
      ownedContainers.add(handle.id);
      return handle;
    },
    async list(selector) {
      const all = await provider.list(selector);
      return all.filter(
        (summary) => isMine(summary.labels["run"]) || ownedContainers.has(summary.id),
      );
    },
    async destroy(id) {
      await provider.destroy?.(id);
    },
  };

  const scopedRunner: DockerCliRunner = async (args) => {
    if (args[0] === "volume" && args[1] === "ls") {
      const real = await docker(args, { timeoutMs: 30_000 });
      if (real.code !== 0) return real;
      const names = real.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (name) =>
            name.startsWith(CACHE_VOLUME_PREFIX) &&
            (ownedVolumes.has(name) || cachePrefixes.some((prefix) => name.startsWith(prefix))),
        );
      return { code: 0, stdout: names.join("\n"), stderr: "" };
    }
    return docker(args, { timeoutMs: 30_000 });
  };

  const h: Harness = {
    dir,
    db,
    provider,
    scoped,
    scopedRunner,
    ownedContainers,
    ownedVolumes,
    projectId: project.id,
    addTerminalRun() {
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.runs.create({
        id: runId,
        projectId: project.id,
        status: "queued",
        branch: `agentloop/${runId}`,
        iteration: 0,
        task: "gc e2e",
        createdAt: now,
        updatedAt: now,
      });
      db.runs.update(runId, { status: "success" });
      return runId;
    },
  };
  return h;
};

const gc = (h: Harness, extra: Record<string, unknown> = {}) =>
  runSandboxGc({
    db: h.db,
    provider: h.scoped,
    logger: createLogger("silent"),
    runner: h.scopedRunner,
    ...extra,
  });

/** Container names still alive for one run id (raw docker). */
const containersFor = async (runId: string): Promise<string[]> => {
  const result = await docker(["ps", "-aq", "--filter", `label=run=${runId}`], {
    timeoutMs: 30_000,
  });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

describe.skipIf(!dockerLive)("sandbox GC e2e (real daemon, #105)", () => {
  beforeAll(async () => {
    const present = await docker(["image", "inspect", BUSYBOX], { timeoutMs: 30_000 });
    if (present.code !== 0) {
      const pull = await docker(["pull", BUSYBOX], { timeoutMs: 300_000 });
      if (pull.code !== 0) throw new Error(`failed to pull ${BUSYBOX}: ${pull.stderr}`);
    }
  });

  it("sweeps a manually created ghost container as an orphan (ops.gc counts)", async () => {
    harness = setup();
    const h = harness;
    // "Unlabeled-as-ours": only the PROVIDER labels — no spec `run` label.
    const ghost = `openeuler-gc-ghost-${randomBytes(3).toString("hex")}`;
    h.ownedContainers.add(ghost);
    const started = await docker(
      [
        "run",
        "-d",
        "--name",
        ghost,
        "--label",
        "openeuler.sandbox=1",
        "--label",
        "openeuler.run=ghost",
        BUSYBOX,
        "tail",
        "-f",
        "/dev/null",
      ],
      { timeoutMs: 60_000 },
    );
    expect(started.code).toBe(0);
    expect((await h.scoped.list()).map((s) => s.id)).toContain(ghost);

    const counts = await gc(h);

    expect(counts.orphans).toBeGreaterThanOrEqual(1);
    expect((await h.scoped.list()).map((s) => s.id)).not.toContain(ghost);
    const swept = h.db.activity
      .list({ limit: 20 })
      .some((row) => row.type === "ops.gc" && (row.payload?.["orphans"] as number) >= 1);
    expect(swept).toBe(true);
  }, 120_000);

  it("a keepForDebug sandbox survives its grace, then is destroyed past it", async () => {
    const h = harness ?? setup();
    harness = h;
    h.db.projects.setSandboxPolicy(h.projectId, {
      executionMode: "sandbox",
      image: BUSYBOX,
      keepForDebug: true,
    });
    const runId = h.addTerminalRun();
    await h.scoped.create({
      runId,
      image: BUSYBOX,
      mounts: [],
      env: {},
      labels: { run: runId },
    });
    expect((await containersFor(runId)).length).toBeGreaterThan(0);

    // Fresh terminal age: within the 4h debug grace → kept.
    const within = await gc(h);
    expect(within.kept).toBeGreaterThanOrEqual(1);
    expect((await containersFor(runId)).length).toBeGreaterThan(0);

    // 5h later: past the debug grace → destroyed.
    const beyond = await gc(h, { now: () => Date.now() + 5 * 60 * 60 * 1000 });
    expect(beyond.destroyed).toBeGreaterThanOrEqual(1);
    expect(await containersFor(runId)).toEqual([]);
  }, 120_000);

  it("prunes an orphan cache volume; a live project's cache volume survives", async () => {
    const h = harness ?? setup();
    harness = h;
    const orphan = cacheVolumeName(crypto.randomUUID(), "/workspace/node_modules");
    const live = cacheVolumeName(h.projectId, "/workspace/.pnpm-store");
    h.ownedVolumes.add(orphan);

    await docker(["volume", "create", orphan], { timeoutMs: 30_000 });
    await docker(["volume", "create", live], { timeoutMs: 30_000 });

    const counts = await gc(h);

    expect(counts.cacheVolumesPruned).toBeGreaterThanOrEqual(1);
    const orphanGone = await docker(["volume", "inspect", orphan], { timeoutMs: 30_000 });
    expect(orphanGone.code).not.toBe(0);
    const liveStill = await docker(["volume", "inspect", live], { timeoutMs: 30_000 });
    expect(liveStill.code).toBe(0);
  }, 120_000);

  afterAll(async () => {
    // Belt and braces: ZERO leftovers from this suite, even on failure.
    if (harness !== null) {
      for (const name of harness.ownedContainers) {
        await docker(["rm", "-f", name], { timeoutMs: 30_000 });
      }
      for (const name of harness.ownedVolumes) {
        await docker(["volume", "rm", "-f", name], { timeoutMs: 30_000 });
      }
      // The live project's volume from the last test (not in ownedVolumes).
      await docker(
        ["volume", "rm", "-f", cacheVolumeName(harness.projectId, "/workspace/.pnpm-store")],
        { timeoutMs: 30_000 },
      );
      harness.db.close();
      rmSync(harness.dir, { recursive: true, force: true });
      harness = null;
    }
  });
});
