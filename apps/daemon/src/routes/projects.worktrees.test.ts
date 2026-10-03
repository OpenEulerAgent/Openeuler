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
import type { Project, RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import { createLogger } from "../logger.js";

/**
 * Worktree manager API (#111): `GET /api/projects/:id/worktrees` (statuses
 * active/inspectable/orphan, `du`-based disk usage cached 60s, totals) and
 * `POST …/worktrees/prune` (`{runId}` with active→409, `{orphans: true}`
 * keeping live entries). Sizes come from a scripted `du` stub so byte
 * assertions are deterministic.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

interface WorktreeRow {
  runId: string;
  branch: string;
  path: string;
  diskUsageBytes: number | null;
  lastActivity: string | null;
  status: "active" | "inspectable" | "orphan";
  runStatus?: RunStatus;
}

interface ListBody {
  worktrees: WorktreeRow[];
  totalBytes: number | null;
}

interface PruneBody {
  removed: Array<{ runId: string; path: string; warnings?: string[] }>;
  kept: number;
}

interface ErrorBody {
  error: { code: string; message: string };
}

let workDir: string;
let db: Db;
let repo: string;
let storeRoot: string;
let worktrees: WorktreeManager;
let projectId: string;
let otherProjectId: string;
let duLog: string;
let duStub: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openeuler-worktrees-api-"));
  db = createDatabase({ path: join(workDir, "test.db") });
  repo = makeRepo("repo-a");
  storeRoot = join(workDir, "store");
  worktrees = new WorktreeManager({ storeRoot });
  projectId = "prj_a";
  otherProjectId = "prj_b";
  db.projects.create({
    id: projectId,
    path: repo,
    name: "repo-a",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  db.projects.create({
    id: otherProjectId,
    path: makeRepo("repo-b"),
    name: "repo-b",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  writeDuStub();
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

function makeRepo(name: string): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init");
  return dir;
}

function project(): Project {
  return {
    id: projectId,
    path: repo,
    name: "repo-a",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  };
}

/** Sizes baked into the `du` stub per store directory name. */
const DU_SIZES: Record<string, number> = {
  "run-active": 111_111,
  "run-done": 222_222,
  "run-orphan": 333_333,
  "run-other": 9_999,
};

/** Executable `du -sB1` stand-in: logs invocations, echoes fixed sizes. */
function writeDuStub(): void {
  duLog = join(workDir, "du.log");
  const cases = Object.entries(DU_SIZES)
    .map(([name, bytes]) => `  *${name}) echo "${bytes}\t$2" ;;`)
    .join("\n");
  duStub = join(workDir, "du-stub.sh");
  writeFileSync(
    duStub,
    [
      "#!/bin/sh",
      `echo "$2" >> "${duLog}"`,
      'case "$2" in',
      cases,
      '  *) echo "4096\t$2" ;;',
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(duStub, 0o755);
}

const build = (options: { worktrees?: WorktreeManager; duBinary?: string } = {}) =>
  createApp({
    db,
    logger: createLogger("silent"),
    worktrees: options.worktrees === undefined ? worktrees : options.worktrees,
    worktreeRoutes: { duBinary: options.duBinary ?? duStub },
  }).app;

const list = async (
  app: ReturnType<typeof build>,
  id = projectId,
  query = "",
): Promise<ListBody> => {
  const res = await app.request(`/api/projects/${id}/worktrees${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
};

const prune = async (
  app: ReturnType<typeof build>,
  body: unknown,
  id = projectId,
): Promise<Response> =>
  app.request(`/api/projects/${id}/worktrees/prune`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Creates a worktree for `runId` from this project's repo. */
async function createWorktree(runId: string): Promise<string> {
  const info = await worktrees.create(runId, project());
  expect(existsSync(info.path)).toBe(true);
  return info.path;
}

function seedRun(
  runId: string,
  status: RunStatus,
  ownedBy = projectId,
  updatedAt = new Date().toISOString(),
): void {
  db.runs.create({
    id: runId,
    projectId: ownedBy,
    status,
    branch: `agentloop/${runId}`,
    iteration: 0,
    createdAt: updatedAt,
    updatedAt,
  });
}

/** Pins a run's metadata createdAt to a fixed timestamp (sort determinism). */
function pinMetaCreatedAt(runId: string, createdAt: string): void {
  const file = join(storeRoot, "meta", `${runId}.json`);
  const meta = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...meta, createdAt }, null, 2), "utf8");
}

function branchExists(branch: string): boolean {
  return git(repo, "for-each-ref", `refs/heads/${branch}`, "--format=%(refname:short)") === branch;
}

/** Standard fixture: active + terminal + orphan entries under one store. */
async function seedMixedStore(): Promise<void> {
  await createWorktree("run-active");
  seedRun("run-active", "running", projectId, "2026-10-03T12:00:00.000Z");
  await createWorktree("run-done");
  seedRun("run-done", "success", projectId, "2026-10-03T11:00:00.000Z");
  await createWorktree("run-orphan"); // no run row
  pinMetaCreatedAt("run-orphan", "2026-10-03T10:30:00.000Z");
  const gone = await createWorktree("run-gone"); // run terminal, dir deleted
  seedRun("run-gone", "success", projectId, "2026-10-03T10:00:00.000Z");
  rmSync(gone, { recursive: true, force: true });
}

describe("GET /api/projects/:id/worktrees", () => {
  it("lists active, inspectable and orphan entries with usage, last activity and totals", async () => {
    await seedMixedStore();
    const body = await list(build());

    const byId = new Map(body.worktrees.map((row) => [row.runId, row]));
    expect(byId.get("run-active")).toMatchObject({
      branch: "agentloop/run-active",
      path: join(storeRoot, "run-active"),
      diskUsageBytes: 111_111,
      lastActivity: "2026-10-03T12:00:00.000Z",
      status: "active",
      runStatus: "running",
    });
    expect(byId.get("run-done")).toMatchObject({
      status: "inspectable",
      runStatus: "success",
      diskUsageBytes: 222_222,
    });
    expect(byId.get("run-orphan")).toMatchObject({
      status: "orphan",
      diskUsageBytes: 333_333,
      lastActivity: "2026-10-03T10:30:00.000Z",
    });
    expect("runStatus" in (byId.get("run-orphan") as object)).toBe(false);
    // Terminal run whose directory is gone → orphan leftover, no disk usage.
    expect(byId.get("run-gone")).toMatchObject({ status: "orphan", diskUsageBytes: null });

    expect(body.totalBytes).toBe(111_111 + 222_222 + 333_333);
    // Most recent activity first.
    expect(body.worktrees.map((row) => row.runId)).toEqual([
      "run-active",
      "run-done",
      "run-orphan",
      "run-gone",
    ]);
  });

  it("scopes the listing to the project and skips unattributable store dirs", async () => {
    await seedMixedStore();
    // Another project's worktree: metadata projectPath points elsewhere.
    await worktrees.create("run-other", {
      id: otherProjectId,
      path: (db.projects.get(otherProjectId) as { path: string }).path,
      name: "repo-b",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    // Unattributable: stale dir with no metadata and no run row.
    mkdirSync(join(storeRoot, "stray-dir"));

    const body = await list(build());

    expect(body.worktrees.map((row) => row.runId)).not.toContain("run-other");
    expect(body.worktrees.map((row) => row.runId)).not.toContain("stray-dir");
    const other = await list(build(), otherProjectId);
    expect(other.worktrees.map((row) => row.runId)).toEqual(["run-other"]);
  });

  it("caches du results for the TTL and re-sizes on ?refresh=1", async () => {
    await createWorktree("run-done");
    seedRun("run-done", "success");
    const app = build();

    await list(app);
    await list(app);
    expect(readLog()).toEqual([join(storeRoot, "run-done")]);

    await list(app, projectId, "?refresh=1");
    expect(readLog()).toEqual([join(storeRoot, "run-done"), join(storeRoot, "run-done")]);
  });

  it("answers null usage (and a null total) when du fails", async () => {
    await seedMixedStore();
    const app = build({ duBinary: join(workDir, "no-such-du") });
    const body = await list(app);
    for (const row of body.worktrees) {
      expect(row.diskUsageBytes).toBeNull();
    }
    expect(body.totalBytes).toBeNull();
  });

  it("404s for an unknown project and 503s without a worktree manager", async () => {
    const app = build();
    const missing = await app.request("/api/projects/ghost/worktrees");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorBody).error.code).toBe("PROJECT_NOT_FOUND");

    const bare = createApp({ db, logger: createLogger("silent") }).app;
    const unavailable = await bare.request(`/api/projects/${projectId}/worktrees`);
    expect(unavailable.status).toBe(503);
    expect(((await unavailable.json()) as ErrorBody).error.code).toBe("WORKTREES_UNAVAILABLE");
  });

  it("returns an empty listing for a fresh project", async () => {
    const body = await list(build());
    expect(body).toEqual({ worktrees: [], totalBytes: 0 });
  });
});

describe("POST /api/projects/:id/worktrees/prune", () => {
  it("409s (WORKTREE_ACTIVE) for a running run's worktree and removes nothing", async () => {
    const path = await createWorktree("run-active");
    seedRun("run-active", "running");

    const res = await prune(build(), { runId: "run-active" });

    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("WORKTREE_ACTIVE");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(storeRoot, "meta", "run-active.json"))).toBe(true);
  });

  it("prunes one terminal run's worktree: dir + metadata + branch", async () => {
    const path = await createWorktree("run-done");
    seedRun("run-done", "success");

    const res = await prune(build(), { runId: "run-done" });
    expect(res.status).toBe(200);
    expect((await res.json()) as PruneBody).toEqual({
      removed: [{ runId: "run-done", path }],
      kept: 0,
    });

    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(storeRoot, "meta", "run-done.json"))).toBe(false);
    expect(branchExists("agentloop/run-done")).toBe(false);
  });

  it("prunes all orphans but keeps active and inspectable entries", async () => {
    await seedMixedStore();

    const res = await prune(build(), { orphans: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PruneBody;

    expect(body.removed.map((row) => row.runId).sort()).toEqual(["run-gone", "run-orphan"]);
    expect(body.kept).toBe(2);
    expect(existsSync(join(storeRoot, "run-active"))).toBe(true);
    expect(existsSync(join(storeRoot, "run-done"))).toBe(true);
    expect(existsSync(join(storeRoot, "run-orphan"))).toBe(false);
    expect(existsSync(join(storeRoot, "meta", "run-gone.json"))).toBe(false);
    // The no-run-row orphan's branch ref went with it.
    expect(branchExists("agentloop/run-orphan")).toBe(false);

    const after = await list(build());
    expect(after.worktrees.map((row) => row.status).sort()).toEqual(["active", "inspectable"]);
  });

  it("404s for an unknown runId and never touches another project's worktree", async () => {
    const path = await worktrees
      .create("run-other", {
        id: otherProjectId,
        path: (db.projects.get(otherProjectId) as { path: string }).path,
        name: "repo-b",
        defaultBranch: "main",
        createdAt: new Date().toISOString(),
      })
      .then((info) => info.path);
    const app = build();

    const missing = await prune(app, { runId: "nope" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorBody).error.code).toBe("WORKTREE_NOT_FOUND");

    // run-other's metadata points at the other repo: not prj_a's to prune.
    const foreign = await prune(app, { runId: "run-other" });
    expect(foreign.status).toBe(404);
    expect(existsSync(path)).toBe(true);

    // But the owning project can prune it.
    const owned = await prune(app, { runId: "run-other" }, otherProjectId);
    expect(owned.status).toBe(200);
    expect(existsSync(path)).toBe(false);
  });

  it("422s on bodies selecting neither or both targets", async () => {
    const app = build();
    for (const body of [{}, { runId: "a", orphans: true }, { orphans: false }]) {
      const res = await prune(app, body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorBody).error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("422s on invalid JSON", async () => {
    const res = await build().request(`/api/projects/${projectId}/worktrees/prune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error.code).toBe("INVALID_JSON");
  });

  it("surfaces branch-deletion warnings without failing the prune", async () => {
    const path = await createWorktree("run-locked");
    seedRun("run-locked", "aborted");
    // Remove the store dir, forget it in git, then check the branch out in
    // a twin worktree — `git branch -D` now fails with a warning.
    rmSync(path, { recursive: true, force: true });
    git(repo, "worktree", "prune");
    const twin = join(workDir, "twin");
    git(repo, "worktree", "add", twin, "agentloop/run-locked");

    const res = await prune(build(), { runId: "run-locked" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PruneBody;
    expect(body.removed).toHaveLength(1);
    expect(body.removed[0]?.warnings?.length).toBeGreaterThan(0);
    // Metadata is kept on warning so a later remove() can retry the branch.
    expect(existsSync(join(storeRoot, "meta", "run-locked.json"))).toBe(true);

    git(repo, "worktree", "remove", "--force", twin);
  });

  it("requires the bearer token when auth is on (like every /api route)", async () => {
    const app = createApp({
      db,
      logger: createLogger("silent"),
      worktrees,
      authToken: "s3cret",
      worktreeRoutes: { duBinary: duStub },
    }).app;
    const denied = await app.request(`/api/projects/${projectId}/worktrees`);
    expect(denied.status).toBe(401);
    const allowed = await app.request(`/api/projects/${projectId}/worktrees`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(allowed.status).toBe(200);
  });

  it("end-to-end: 3 executed runs → 3 inspectable worktrees; prune after cleanup (#111 checklist)", async () => {
    // The issue's manual verification, scripted: real executor + fake driver
    // drive three runs to success (worktrees stay on disk past terminal —
    // inspectable), then the prune API frees one.
    const drivers = createDriverRegistry();
    drivers.registerDriver(createFakeDriver({ output: "done" }));
    const executor = createExecutor({
      db,
      worktrees,
      drivers,
      logger: createLogger("silent"),
    });
    const app = createApp({
      db,
      logger: createLogger("silent"),
      executor,
      worktrees,
      worktreeRoutes: { duBinary: duStub },
    }).app;

    const runIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const res = await app.request("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, prompt: `task ${index}` }),
      });
      expect(res.status).toBe(202);
      runIds.push(((await res.json()) as { run: { id: string } }).run.id);
    }

    const deadline = Date.now() + 15_000;
    await new Promise<void>((resolve, reject) => {
      const tick = (): void => {
        const statuses = runIds.map((id) => db.runs.get(id)?.status);
        if (statuses.every((status) => status === "success")) return resolve();
        if (Date.now() > deadline) return reject(new Error(`runs never finished: ${statuses}`));
        setTimeout(tick, 25);
      };
      tick();
    });

    const before = await list(app);
    expect(before.worktrees.map((row) => row.runId).sort()).toEqual([...runIds].sort());
    expect(before.worktrees.every((row) => row.status === "inspectable")).toBe(true);
    expect(before.totalBytes).toBe(3 * 4096); // du stub default bucket

    const victim = runIds[0] as string;
    const res = await prune(app, { runId: victim });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PruneBody).removed).toEqual([
      { runId: victim, path: join(storeRoot, victim) },
    ]);

    const after = await list(app);
    expect(after.worktrees).toHaveLength(2);
    expect(after.worktrees.map((row) => row.runId)).not.toContain(victim);
    expect(branchExists(`agentloop/${victim}`)).toBe(false);
    await executor.shutdown();
  });
});

function readLog(): string[] {
  if (!existsSync(duLog)) return [];
  return readFileSync(duLog, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}
