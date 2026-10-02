import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";

/**
 * Settings hub API tests (#95): `GET /api/system/settings` payload shape
 * (with a stubbed `du`), `POST /api/system/maintenance` action semantics
 * (prune-worktrees / purge-events / vacuum), and auth coverage.
 */

interface Harness {
  dir: string;
  db: Db;
  storeRoot: string;
  worktrees: WorktreeManager;
  duLog: string;
  projectId: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

const created: { db: Db; dir: string }[] = [];

const seedRun = (h: Harness, id: string, status: RunStatus, ageDays: number): string => {
  const iso = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  h.db.runs.create({
    id,
    projectId: h.projectId,
    status,
    branch: `agentloop/${id}`,
    iteration: 0,
    createdAt: iso,
    updatedAt: iso,
  });
  return iso;
};

const seedEvents = (h: Harness, runId: string, count: number): void => {
  const insert = h.db.sqlite.prepare(
    "insert into events (run_id, seq, type, payload, created_at) values (?, ?, 'log', '{}', ?)",
  );
  for (let seq = 1; seq <= count; seq += 1) insert.run(runId, seq, new Date().toISOString());
};

let harness: Harness;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-settings-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  execFileSync("git", ["-C", repoPath, "add", "-A"], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-C",
      repoPath,
      "-c",
      "user.email=t@openeuler.dev",
      "-c",
      "user.name=T",
      "commit",
      "-m",
      "init",
    ],
    { stdio: "pipe" },
  );

  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: repoPath,
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });

  const storeRoot = join(dir, "store");
  const worktrees = new WorktreeManager({ storeRoot });

  // Stub `du`: logs one line per invocation, reports a fixed byte count.
  const duLog = join(dir, "du.log");
  const duStub = join(dir, "du-stub");
  writeFileSync(
    duStub,
    `#!/usr/bin/env bash\necho "du-stub:$*" >> "${duLog}"\necho "4096\tpath"\n`,
  );
  chmodSync(duStub, 0o755);

  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver());

  const { app } = createApp({
    db,
    logger: createLogger("silent"),
    worktrees,
    drivers,
    system: { storeRoot, duBinary: duStub },
  });

  harness = {
    dir,
    db,
    storeRoot,
    worktrees,
    duLog,
    projectId: project.id,
    request: (path, init) => Promise.resolve(app.request(path, init)),
  };
  created.push({ db, dir });
});

afterEach(() => {
  while (created.length > 0) {
    const item = created.pop() as { db: Db; dir: string };
    item.db.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

const duCalls = (): string[] =>
  existsSync(harness.duLog)
    ? readFileSync(harness.duLog, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];

const postMaintenance = (body: unknown): Promise<Response> =>
  harness.request("/api/system/maintenance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /api/system/settings (#95)", () => {
  it("returns the full settings payload", async () => {
    const res = await harness.request("/api/system/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["version"]).toMatch(/^\d+\.\d+\.\d+/);
    expect(body["dbPath"]).toBe(harness.db.path);
    expect(body["dbBytes"]).toBeGreaterThan(0);
    expect(body["worktreeRoot"]).toBe(harness.storeRoot);
    expect(body["worktreeBytes"]).toBe(4096);
    expect(body["drivers"]).toEqual([{ id: "fake" }]);
    expect(body["defaultDriver"]).toBe("fake");
    expect(body["maxConcurrentRuns"]).toBe(2);
    expect(body["authEnabled"]).toBe(false);
    expect(typeof body["uptimeSeconds"]).toBe("number");
    expect(body["uptimeSeconds"]).toBeGreaterThanOrEqual(0);
  });

  it("reports the resolved concurrency cap and null db facts without a db", async () => {
    const { app } = createApp({
      logger: createLogger("silent"),
      maxConcurrentRuns: 7,
      system: { storeRoot: harness.storeRoot, duBinary: join(harness.dir, "du-stub") },
    });
    const res = await app.request("/api/system/settings");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["maxConcurrentRuns"]).toBe(7);
    expect(body["dbPath"]).toBeNull();
    expect(body["dbBytes"]).toBeNull();
    expect(body["drivers"]).toEqual([]);
    expect(body["defaultDriver"]).toBeNull();
  });

  it("caches the du result for the TTL; ?refresh=1 bypasses it", async () => {
    const { app } = createApp({
      logger: createLogger("silent"),
      system: { storeRoot: harness.storeRoot, duBinary: join(harness.dir, "du-stub") },
    });
    await app.request("/api/system/settings");
    await app.request("/api/system/settings");
    expect(duCalls().length).toBe(1);
    await app.request("/api/system/settings?refresh=1");
    expect(duCalls().length).toBe(2);
  });

  it("reports null worktreeBytes when du is unavailable", async () => {
    const { app } = createApp({
      logger: createLogger("silent"),
      system: { storeRoot: harness.storeRoot, duBinary: "du-definitely-not-on-path" },
    });
    const res = await app.request("/api/system/settings");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["worktreeBytes"]).toBeNull();
  });

  it("requires auth when the daemon runs with a token", async () => {
    const { app } = createApp({
      db: harness.db,
      logger: createLogger("silent"),
      authToken: "sekret",
      system: { storeRoot: harness.storeRoot, duBinary: join(harness.dir, "du-stub") },
    });
    const rejected = await app.request("/api/system/settings");
    expect(rejected.status).toBe(401);
    const ok = await app.request("/api/system/settings", {
      headers: { authorization: "Bearer sekret" },
    });
    expect(ok.status).toBe(200);
  });
});

describe("POST /api/system/maintenance: prune-worktrees (#95)", () => {
  it("removes orphaned directories, keeps live worktrees, and is idempotent", async () => {
    await harness.worktrees.create("run-live", {
      id: harness.projectId,
      path: join(harness.dir, "repo"),
      name: "repo",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    mkdirSync(join(harness.storeRoot, "run-stale"));

    const res = await postMaintenance({ action: "prune-worktrees" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: "prune-worktrees", removed: 1, remaining: 0 });

    expect(existsSync(join(harness.storeRoot, "run-stale"))).toBe(false);
    expect(existsSync(join(harness.storeRoot, "run-live"))).toBe(true);

    // Second run: nothing left to remove.
    const again = await postMaintenance({ action: "prune-worktrees" });
    expect(await again.json()).toEqual({ action: "prune-worktrees", removed: 0, remaining: 0 });
  });

  it("answers 503 WORKTREES_UNAVAILABLE without a worktree manager", async () => {
    const { app } = createApp({ logger: createLogger("silent") });
    const res = await app.request("/api/system/maintenance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "prune-worktrees" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("WORKTREES_UNAVAILABLE");
  });
});

describe("POST /api/system/maintenance: purge-events (#95)", () => {
  it("deletes events of terminal runs older than the cutoff, leaving fresh and non-terminal runs untouched", async () => {
    seedRun(harness, "run-old-success", "success", 40);
    seedEvents(harness, "run-old-success", 2);
    seedRun(harness, "run-old-failed", "failed", 40);
    seedEvents(harness, "run-old-failed", 1);
    seedRun(harness, "run-old-running", "running", 40);
    seedEvents(harness, "run-old-running", 1);
    seedRun(harness, "run-recent", "success", 0);
    seedEvents(harness, "run-recent", 3);

    const res = await postMaintenance({ action: "purge-events" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string; deleted: number; dbBytes: number };
    expect(body.action).toBe("purge-events");
    expect(body.deleted).toBe(3);
    expect(body.dbBytes).toBeGreaterThan(0);

    expect(harness.db.events.count("run-old-success")).toBe(0);
    expect(harness.db.events.count("run-old-failed")).toBe(0);
    // Old but not terminal → kept.
    expect(harness.db.events.count("run-old-running")).toBe(1);
    // Terminal but fresh → kept.
    expect(harness.db.events.count("run-recent")).toBe(3);
  });

  it("honours the days param (default 30)", async () => {
    seedRun(harness, "run-10d", "success", 10);
    seedEvents(harness, "run-10d", 2);

    const keep = await postMaintenance({ action: "purge-events", days: 30 });
    expect(((await keep.json()) as { deleted: number }).deleted).toBe(0);
    expect(harness.db.events.count("run-10d")).toBe(2);

    const purge = await postMaintenance({ action: "purge-events", days: 5 });
    expect(((await purge.json()) as { deleted: number }).deleted).toBe(2);
    expect(harness.db.events.count("run-10d")).toBe(0);
  });

  it("answers 503 DB_UNAVAILABLE without a db", async () => {
    const { app } = createApp({ logger: createLogger("silent") });
    const res = await app.request("/api/system/maintenance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "purge-events" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DB_UNAVAILABLE");
  });
});

describe("POST /api/system/maintenance: vacuum (#95)", () => {
  it("vacuums the database and reports the new size", async () => {
    seedRun(harness, "run-old", "success", 40);
    seedEvents(harness, "run-old", 5);

    const res = await postMaintenance({ action: "vacuum" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string; dbBytes: number };
    expect(body.action).toBe("vacuum");
    expect(body.dbBytes).toBeGreaterThan(0);
    // The db stays fully usable afterwards.
    expect(harness.db.projects.list().length).toBe(1);
  });
});

describe("POST /api/system/maintenance: validation + auth (#95)", () => {
  it("rejects unknown actions, bad days, and non-JSON bodies with 422", async () => {
    const unknown = await postMaintenance({ action: "drop-tables" });
    expect(unknown.status).toBe(422);

    const badDays = await postMaintenance({ action: "purge-events", days: -1 });
    expect(badDays.status).toBe(422);

    const notJson = await harness.request("/api/system/maintenance", {
      method: "POST",
      body: "not json",
    });
    expect(notJson.status).toBe(422);
  });

  it("requires auth when the daemon runs with a token", async () => {
    const { app } = createApp({
      db: harness.db,
      logger: createLogger("silent"),
      authToken: "sekret",
    });
    const rejected = await app.request("/api/system/maintenance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "vacuum" }),
    });
    expect(rejected.status).toBe(401);
    const ok = await app.request("/api/system/maintenance", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sekret" },
      body: JSON.stringify({ action: "vacuum" }),
    });
    expect(ok.status).toBe(200);
  });
});
