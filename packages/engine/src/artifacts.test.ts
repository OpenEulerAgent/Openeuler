import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunStatus, Step } from "@openeuler/core";
import { linearToGraph } from "@openeuler/core";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { ArtifactStore } from "./artifacts.js";
import { createFlowEngine } from "./flow-engine.js";
import { WorktreeManager } from "./worktree.js";

/**
 * Run artifacts (#122): the store's capture/manifest/cap semantics, and the
 * flow engine's terminal-only hook (patterns from the pinned revision,
 * best-effort, survives worktree removal).
 */

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const created: { db: Db; dir: string }[] = [];

const setup = (): {
  dir: string;
  db: Db;
  repoPath: string;
  worktrees: WorktreeManager;
  artifacts: ArtifactStore;
  projectId: string;
} => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-artifacts-"));
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

  const worktrees = new WorktreeManager({ storeRoot: join(dir, "store") });
  const artifacts = new ArtifactStore({ storeRoot: join(dir, "artifacts") });
  created.push({ db, dir });
  return { dir, db, repoPath, worktrees, artifacts, projectId: project.id };
};

afterEach(() => {
  while (created.length > 0) {
    const item = created.pop() as { db: Db; dir: string };
    item.db.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

/** A plain directory tree standing in for a worktree (capture only walks it). */
const makeTreeWithFiles = (h: ReturnType<typeof setup>, name: string): string => {
  const root = join(h.dir, name);
  mkdirSync(join(root, "dist", "nested"), { recursive: true });
  writeFileSync(join(root, "dist", "app.js"), "console.log(1)\n");
  writeFileSync(join(root, "dist", "nested", "deep.css"), "body{}\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export {}\n");
  writeFileSync(join(root, "README.md"), "# demo\n");
  return root;
};

describe("ArtifactStore.capture", () => {
  it("copies matching files with a manifest, skipping non-matches and .git", async () => {
    const h = setup();
    const worktree = makeTreeWithFiles(h, "tree-1");

    const { manifest } = await h.artifacts.capture({
      runId: "run-1",
      worktreePath: worktree,
      patterns: ["dist/**"],
      runStatus: "success",
    });

    expect(manifest.files.map((file) => file.path)).toEqual([
      "dist/app.js",
      "dist/nested/deep.css",
    ]);
    expect(manifest.totalBytes).toBe(
      readFileSync(join(worktree, "dist", "app.js")).length +
        readFileSync(join(worktree, "dist", "nested", "deep.css")).length,
    );
    expect(manifest.runStatus).toBe("success");
    expect(manifest.patterns).toEqual(["dist/**"]);
    expect(manifest.truncated).toBe(false);
    const stored = JSON.parse(
      readFileSync(h.artifacts.manifestPath("run-1"), "utf8"),
    ) as typeof manifest;
    expect(stored.files).toEqual(manifest.files);
    expect(existsSync(join(h.artifacts.dirFor("run-1"), "dist", "app.js"))).toBe(true);
    expect(existsSync(join(h.artifacts.dirFor("run-1"), "src"))).toBe(false);
  });

  it("writes an empty manifest when patterns match nothing", async () => {
    const h = setup();
    const worktree = makeTreeWithFiles(h, "tree-2");

    const { manifest } = await h.artifacts.capture({
      runId: "run-2",
      worktreePath: worktree,
      patterns: ["nothing-here/**"],
      runStatus: "failed",
    });

    expect(manifest.files).toEqual([]);
    expect(manifest.totalBytes).toBe(0);
    expect(existsSync(h.artifacts.manifestPath("run-2"))).toBe(true);
  });

  it("enforces the file-count cap and records the partial-capture warning", async () => {
    const h = setup();
    const worktree = makeTreeWithFiles(h, "tree-3");
    const store = new ArtifactStore({ storeRoot: join(h.dir, "capped"), maxFiles: 1 });

    const { manifest } = await store.capture({
      runId: "run-3",
      worktreePath: worktree,
      patterns: ["**"],
      runStatus: "success",
    });

    expect(manifest.files.length).toBe(1);
    expect(manifest.truncated).toBe(true);
    expect(manifest.warning).toContain("partial capture");
    expect(manifest.warning).toContain("left behind");
  });

  it("enforces the byte cap, skipping the file that would cross it", async () => {
    const h = setup();
    const worktree = makeTreeWithFiles(h, "tree-4");
    const appBytes = readFileSync(join(worktree, "dist", "app.js")).length;
    const store = new ArtifactStore({
      storeRoot: join(h.dir, "capped-bytes"),
      maxTotalBytes: appBytes,
    });

    const { manifest } = await store.capture({
      runId: "run-4",
      worktreePath: worktree,
      patterns: ["dist/**"],
      runStatus: "success",
    });

    // Path order: dist/app.js fits exactly; dist/nested/deep.css is left out.
    expect(manifest.files.map((file) => file.path)).toEqual(["dist/app.js"]);
    expect(manifest.totalBytes).toBe(appBytes);
    expect(manifest.truncated).toBe(true);
  });

  it("skips symlinks instead of following them out of the worktree", async () => {
    const h = setup();
    const secret = join(h.dir, "secret.txt");
    writeFileSync(secret, "top secret\n");
    const info = makeTreeWithFiles(h, "tree-5");
    writeFileSync(join(info, "dist-real.txt"), "safe\n");
    symlinkSync(secret, join(info, "leak.txt"));

    const { manifest } = await h.artifacts.capture({
      runId: "run-5",
      worktreePath: info,
      patterns: ["**"],
      runStatus: "success",
    });

    // Everything regular is captured; the symlink is NOT followed.
    expect(manifest.files.map((file) => file.path)).toEqual([
      "README.md",
      "dist-real.txt",
      "dist/app.js",
      "dist/nested/deep.css",
      "src/index.ts",
    ]);
    expect(existsSync(join(h.artifacts.dirFor("run-5"), "leak.txt"))).toBe(false);
  });

  it("re-capture replaces the previous set wholesale", async () => {
    const h = setup();
    const worktree = makeTreeWithFiles(h, "tree-6");

    await h.artifacts.capture({
      runId: "run-6",
      worktreePath: worktree,
      patterns: ["**"],
      runStatus: "success",
    });
    writeFileSync(join(worktree, "dist", "extra.js"), "more\n");
    rmSync(join(worktree, "dist", "app.js"));
    const { manifest } = await h.artifacts.capture({
      runId: "run-6",
      worktreePath: worktree,
      patterns: ["dist/**"],
      runStatus: "aborted",
    });

    expect(manifest.runStatus).toBe("aborted");
    expect(manifest.files.map((file) => file.path)).toEqual([
      "dist/extra.js",
      "dist/nested/deep.css",
    ]);
    expect(existsSync(join(h.artifacts.dirFor("run-6"), "src"))).toBe(false);
  });

  it("rejects run ids that are unsafe directory names", () => {
    const h = setup();
    expect(() => h.artifacts.dirFor("../escape")).toThrow();
    expect(() => h.artifacts.dirFor("meta")).not.toThrow();
  });
});

describe("ArtifactStore manifest/remove/removeOrphans", () => {
  it("manifest returns null when nothing was captured", async () => {
    const h = setup();
    expect(h.artifacts.manifest("never")).toBeNull();
  });

  it("remove deletes the set and reports whether it existed", async () => {
    const h = setup();
    const worktree = makeTreeWithFiles(h, "tree-7");
    await h.artifacts.capture({
      runId: "run-7",
      worktreePath: worktree,
      patterns: ["dist/**"],
      runStatus: "success",
    });
    expect(h.artifacts.remove("run-7")).toBe(true);
    expect(h.artifacts.manifest("run-7")).toBeNull();
    expect(h.artifacts.remove("run-7")).toBe(false);
  });

  it("removeOrphans keeps known runs and drops the rest", async () => {
    const h = setup();
    const worktree = makeTreeWithFiles(h, "tree-8");
    await h.artifacts.capture({
      runId: "run-8",
      worktreePath: worktree,
      patterns: ["dist/**"],
      runStatus: "success",
    });
    mkdirSync(join(h.artifacts.storeRoot, "ghost-run"), { recursive: true });
    writeFileSync(join(h.artifacts.storeRoot, "ghost-run", "x.txt"), "x");
    // Non-run-shaped junk is left alone (only cleaned by full store wipes).
    writeFileSync(join(h.artifacts.storeRoot, "stray.txt"), "junk");

    const removed = h.artifacts.removeOrphans(["run-8"]);

    expect(removed).toEqual(["ghost-run"]);
    expect(existsSync(h.artifacts.dirFor("run-8"))).toBe(true);
    expect(existsSync(join(h.artifacts.storeRoot, "stray.txt"))).toBe(true);
  });
});

describe("flow engine terminal capture (#122)", () => {
  const step = (id: string): Step => ({
    id,
    name: id,
    driver: "writer",
    mode: "auto",
    promptTemplate: "{{task}}",
    continueSession: false,
  });

  const setupRun = (patterns: string[] | undefined) => {
    const h = setup();
    const drivers = createDriverRegistry();
    drivers.registerDriver(
      createFakeDriver({
        id: "writer",
        events: [{ type: "session", seq: 1, sessionId: "s-w" }],
        output: "WROTE",
        onStart: (opts) => {
          mkdirSync(join(opts.cwd, "dist"), { recursive: true });
          writeFileSync(join(opts.cwd, "dist", "bundle.js"), "built\n");
          writeFileSync(join(opts.cwd, "notes.tmp"), "scratch\n");
        },
      }),
    );
    const engine = createFlowEngine({
      db: h.db,
      worktrees: h.worktrees,
      drivers,
      artifactStore: h.artifacts,
    });
    const workflow = h.db.workflows.create({
      id: crypto.randomUUID(),
      projectId: h.projectId,
      name: "flow",
      steps: [step("build")],
    });
    const graph = linearToGraph({ steps: [step("build")] });
    const revision = h.db.workflowRevisions.create(
      workflow.id,
      patterns === undefined ? graph : { ...graph, artifacts: patterns },
    );
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    h.db.runs.create({
      id: runId,
      projectId: h.projectId,
      workflowId: workflow.id,
      workflowRevisionId: revision.id,
      status: "queued",
      branch: `agentloop/${runId}`,
      iteration: 0,
      task: "build it",
      createdAt: now,
      updatedAt: now,
    });
    return { ...h, engine, runId };
  };

  const awaitStatus = async (db: Db, runId: string, status: RunStatus): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (db.runs.get(runId)?.status !== status) {
      if (Date.now() > deadline) {
        throw new Error(`run never reached ${status}; currently ${db.runs.get(runId)?.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("captures pattern-matched files when the run turns terminal", async () => {
    const h = setupRun(["dist/**"]);
    await h.engine.executeRun(h.runId, { isAbortRequested: () => false });
    await awaitStatus(h.db, h.runId, "success");

    const manifest = h.artifacts.manifest(h.runId);
    expect(manifest).not.toBeNull();
    expect(manifest?.runStatus).toBe("success");
    expect(manifest?.files.map((file) => file.path)).toEqual(["dist/bundle.js"]);
    // Captured BEFORE the worktree disappears: prune it, artifacts survive.
    await h.worktrees.remove(h.runId);
    expect(h.artifacts.manifest(h.runId)?.files.length).toBe(1);
    expect(existsSync(join(h.artifacts.dirFor(h.runId), "dist", "bundle.js"))).toBe(true);
  });

  it("captures nothing when the pinned graph has no artifact patterns", async () => {
    const h = setupRun(undefined);
    await h.engine.executeRun(h.runId, { isAbortRequested: () => false });
    await awaitStatus(h.db, h.runId, "success");

    expect(h.artifacts.manifest(h.runId)).toBeNull();
  });

  it("captures on failed runs too (best-effort evidence)", async () => {
    const h = setupRun(["dist/**"]);
    const failing = createDriverRegistry();
    failing.registerDriver(
      createFakeDriver({
        id: "writer",
        events: [{ type: "session", seq: 1, sessionId: "s-f" }],
        exitCode: 3,
        onStart: (opts) => {
          mkdirSync(join(opts.cwd, "dist"), { recursive: true });
          writeFileSync(join(opts.cwd, "dist", "partial.js"), "half-built\n");
        },
      }),
    );
    const engine = createFlowEngine({
      db: h.db,
      worktrees: h.worktrees,
      drivers: failing,
      artifactStore: h.artifacts,
    });
    await engine.executeRun(h.runId, { isAbortRequested: () => false });
    await awaitStatus(h.db, h.runId, "failed");

    expect(h.artifacts.manifest(h.runId)?.files.map((file) => file.path)).toEqual([
      "dist/partial.js",
    ]);
  });

  it("never captures for a run that is not terminal", async () => {
    const h = setupRun(["dist/**"]);
    expect(h.artifacts.manifest(h.runId)).toBeNull();
    // A real worktree + a live run row: the hook must no-op on both guards
    // (non-terminal status never reaches the patterns/worktree checks).
    const info = await h.worktrees.create(h.runId, {
      id: h.projectId,
      path: h.repoPath,
      name: "repo",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    mkdirSync(join(info.path, "dist"), { recursive: true });
    writeFileSync(join(info.path, "dist", "app.js"), "would leak\n");
    h.db.runs.updateStatus(h.runId, "running");
    const { captureTerminalArtifacts } = await import("./artifacts.js");
    await captureTerminalArtifacts({
      store: h.artifacts,
      db: h.db,
      worktrees: h.worktrees,
      runId: h.runId,
      log: { info: () => {}, warn: () => {} },
    });
    expect(h.artifacts.manifest(h.runId)).toBeNull();
    expect(existsSync(join(h.artifacts.dirFor(h.runId), "manifest.json"))).toBe(false);
  });
});
