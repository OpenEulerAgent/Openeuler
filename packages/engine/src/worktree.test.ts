import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@openeuler/core";
import { WorktreeError, WorktreeManager } from "./worktree.js";

const hermeticEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `openeuler-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/** Fresh hermetic repo with one commit on `main`; returns its path. */
function makeRepo(): string {
  const repo = tempDir("repo");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "agent@openeuler.test"]);
  git(repo, ["config", "user.name", "OpenEuler Agent"]);
  writeFileSync(join(repo, "README.md"), "# test\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, env: hermeticEnv, encoding: "utf8" }).trim();
}

function makeProject(path: string): Project {
  return {
    id: "prj_test",
    path,
    name: "test",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  };
}

function makeManager(): { manager: WorktreeManager; store: string } {
  const store = tempDir("store");
  return { manager: new WorktreeManager({ storeRoot: store }), store };
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("WorktreeManager.create", () => {
  it("creates a worktree at <store>/<runId> on branch agentloop/<runId> from current HEAD", async () => {
    const repo = makeRepo();
    const { manager, store } = makeManager();
    const head = git(repo, ["rev-parse", "HEAD"]);

    const info = await manager.create("run-1", makeProject(repo));

    expect(info.branch).toBe("agentloop/run-1");
    expect(info.path).toBe(join(store, "run-1"));
    expect(existsSync(info.path)).toBe(true);
    expect(
      git(repo, ["for-each-ref", "refs/heads/agentloop/run-1", "--format=%(refname:short)"]),
    ).toBe("agentloop/run-1");
    expect(git(repo, ["branch", "--show-current"])).toBe("main");
    expect(git(info.path, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(info.path, ["branch", "--show-current"])).toBe("agentloop/run-1");
    expect(existsSync(join(store, "meta", "run-1.json"))).toBe(true);
  });

  it("rejects invalid run ids before touching the filesystem", async () => {
    const repo = makeRepo();
    const { manager } = makeManager();
    await expect(manager.create("../escape", makeProject(repo))).rejects.toMatchObject({
      name: "WorktreeError",
      code: "INVALID_RUN_ID",
    });
  });

  it("throws a typed EMPTY_REPO error for a repo without commits", async () => {
    const repo = tempDir("empty");
    git(repo, ["init", "-b", "main"]);
    const { manager } = makeManager();

    const err = await manager.create("run-1", makeProject(repo)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorktreeError);
    expect((err as WorktreeError).code).toBe("EMPTY_REPO");
    expect((err as WorktreeError).message).toContain("no commits");
  });

  it("deletes a stale colliding branch before creating the worktree", async () => {
    const repo = makeRepo();
    const { manager } = makeManager();
    git(repo, ["branch", "agentloop/run-1"]);

    const info = await manager.create("run-1", makeProject(repo));

    expect(git(repo, ["rev-parse", "--verify", `refs/heads/${info.branch}`])).toBe(
      git(repo, ["rev-parse", "HEAD"]),
    );
    expect(
      git(repo, ["for-each-ref", "refs/heads/agentloop/run-1", "--format=%(refname:short)"]),
    ).toBe("agentloop/run-1");
  });

  it("recovers from a stale directory left in the store", async () => {
    const repo = makeRepo();
    const { manager, store } = makeManager();
    mkdirSync(join(store, "run-1", "junk"), { recursive: true });

    const info = await manager.create("run-1", makeProject(repo));

    expect(existsSync(info.path)).toBe(true);
    expect(existsSync(join(info.path, "junk"))).toBe(false);
  });
});

describe("WorktreeManager.diff", () => {
  it("reports modified and untracked files (stat + patch) via status and git diff", async () => {
    const repo = makeRepo();
    const { manager } = makeManager();
    const info = await manager.create("run-1", makeProject(repo));

    writeFileSync(join(info.path, "README.md"), "# changed by agent\n", "utf8");
    writeFileSync(join(info.path, "new-file.txt"), "brand new\n", "utf8");

    const status = git(info.path, ["status", "--porcelain"]);
    expect(status).toContain("M README.md");
    expect(status).toContain("?? new-file.txt");

    const diff = await manager.diff(info.path);
    expect(diff.stat).toContain("README.md");
    expect(diff.stat).toContain("new-file.txt");
    expect(diff.patch).toContain("-# test");
    expect(diff.patch).toContain("+# changed by agent");
    expect(diff.patch).toContain("+brand new");
  });

  it("returns empty strings for a clean worktree", async () => {
    const repo = makeRepo();
    const { manager } = makeManager();
    const info = await manager.create("run-1", makeProject(repo));

    const diff = await manager.diff(info.path);
    expect(diff.stat).toBe("");
    expect(diff.patch).toBe("");
  });
});

describe("WorktreeManager.remove", () => {
  it("removes the worktree dir, the branch ref, and the metadata", async () => {
    const repo = makeRepo();
    const { manager, store } = makeManager();
    const info = await manager.create("run-1", makeProject(repo));

    await manager.remove("run-1");

    expect(existsSync(info.path)).toBe(false);
    expect(
      git(repo, ["for-each-ref", "refs/heads/agentloop/run-1", "--format=%(refname:short)"]),
    ).toBe("");
    expect(existsSync(join(store, "meta", "run-1.json"))).toBe(false);
    expect(git(repo, ["worktree", "list"])).not.toContain(info.path);
  });

  it("is a no-op when nothing exists for the run", async () => {
    const { manager } = makeManager();
    await expect(manager.remove("never-created")).resolves.toBeUndefined();
  });

  it("still deletes the branch when the worktree dir was already rm -rf'ed", async () => {
    const repo = makeRepo();
    const { manager } = makeManager();
    const info = await manager.create("run-1", makeProject(repo));
    rmSync(info.path, { recursive: true, force: true });

    await manager.remove("run-1");

    expect(
      git(repo, ["for-each-ref", "refs/heads/agentloop/run-1", "--format=%(refname:short)"]),
    ).toBe("");
    expect(git(repo, ["worktree", "list"])).not.toContain("run-1");
  });
});

describe("WorktreeManager.pruneAll", () => {
  it("returns no orphans while all run worktrees are live", async () => {
    const repo = makeRepo();
    const { manager } = makeManager();
    await manager.create("run-1", makeProject(repo));

    await expect(manager.pruneAll()).resolves.toEqual([]);
  });

  it("reports (but does not delete) rm -rf'ed worktrees and stale store dirs without metadata", async () => {
    const repo = makeRepo();
    const { manager, store } = makeManager();
    const info = await manager.create("run-1", makeProject(repo));
    const stale = join(store, "stray-dir");
    mkdirSync(stale);
    writeFileSync(join(stale, "keep.txt"), "do not delete\n", "utf8");

    rmSync(info.path, { recursive: true, force: true });

    const orphans = await manager.pruneAll(repo);

    expect(orphans).toContain(info.path);
    expect(orphans).toContain(stale);
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(join(stale, "keep.txt"))).toBe(true);
    // Metadata is kept so remove() can still clean the branch ref.
    expect(existsSync(join(store, "meta", "run-1.json"))).toBe(true);
    expect(git(repo, ["worktree", "list"])).not.toContain("run-1");

    await manager.remove("run-1");
    expect(
      git(repo, ["for-each-ref", "refs/heads/agentloop/run-1", "--format=%(refname:short)"]),
    ).toBe("");
  });

  it("returns [] when the store does not exist", async () => {
    const manager = new WorktreeManager({ storeRoot: join(tempDir("nostore"), "missing") });
    await expect(manager.pruneAll()).resolves.toEqual([]);
  });
});

describe("store root resolution", () => {
  it("honors the storeRoot option over the environment", () => {
    vi.stubEnv("OPENEULER_WORKTREES", "/from-env");
    const store = tempDir("optstore");
    expect(new WorktreeManager({ storeRoot: store }).storeRoot).toBe(store);
  });

  it("falls back to $OPENEULER_WORKTREES", () => {
    const envStore = tempDir("envstore");
    vi.stubEnv("OPENEULER_WORKTREES", envStore);
    expect(new WorktreeManager().storeRoot).toBe(envStore);
  });

  it("creates the env-configured store on demand", async () => {
    const envStore = join(tempDir("envstore"), "nested");
    vi.stubEnv("OPENEULER_WORKTREES", envStore);
    const repo = makeRepo();
    const manager = new WorktreeManager();

    const info = await manager.create("run-1", makeProject(repo));

    expect(info.path).toBe(join(envStore, "run-1"));
  });
});
