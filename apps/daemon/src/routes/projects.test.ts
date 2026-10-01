import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";
import { NO_COMMITS_WARNING } from "./projects.js";

interface ProjectResponseBody {
  project: {
    id: string;
    path: string;
    name: string;
    defaultBranch: string;
    remoteUrl?: string;
    dirty?: boolean;
    createdAt: string;
  };
  warnings: string[];
}

interface ErrorResponseBody {
  error: { code: string; message: string };
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const commitAll = (cwd: string, message: string): void => {
  writeFileSync(join(cwd, "README.md"), `# ${message}\n`);
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=test@openeuler.dev", "-c", "user.name=Test", "commit", "-m", message);
};

let workDir: string;
let db: Db;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openeuler-projects-"));
  db = createDatabase({ path: join(workDir, "test.db") });
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

const newDir = (name: string): string => {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const makeRepo = (name: string, options: { commit?: boolean; remote?: string } = {}): string => {
  const dir = newDir(name);
  git(dir, "init", "-b", "main");
  if (options.commit !== false) commitAll(dir, "init");
  if (options.remote) git(dir, "remote", "add", "origin", options.remote);
  return dir;
};

const build = () => createApp({ db, logger: createLogger("silent") }).app;

const postProject = (app: ReturnType<typeof build>, path: string) =>
  app.request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

const register = async (path: string) => {
  const res = await postProject(build(), path);
  expect(res.status).toBe(201);
  return (await res.json()) as ProjectResponseBody;
};

describe("POST /api/projects", () => {
  it("registers a valid repo with default branch and name", async () => {
    const repo = makeRepo("demo");
    const body = await register(repo);
    expect(body.project).toMatchObject({
      id: expect.any(String),
      path: repo,
      name: "demo",
      defaultBranch: "main",
      dirty: false,
      createdAt: expect.any(String),
    });
    expect("remoteUrl" in body.project).toBe(false);
    expect(body.warnings).toEqual([]);
  });

  it("records a project.created activity feed entry", async () => {
    const repo = makeRepo("feed");
    const body = await register(repo);
    const feed = db.activity.list();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ type: "project.created", projectId: body.project.id });
  });

  it("resolves the repository root when given a nested directory", async () => {
    const repo = makeRepo("nested-repo");
    const sub = join(repo, "packages", "inner");
    mkdirSync(sub, { recursive: true });
    const body = await register(sub);
    expect(body.project.path).toBe(repo);
    expect(body.project.name).toBe("nested-repo");
  });

  it("captures the remote origin URL when present", async () => {
    const repo = makeRepo("with-remote", { remote: "https://example.com/openeuler.git" });
    const body = await register(repo);
    expect(body.project.remoteUrl).toBe("https://example.com/openeuler.git");
  });

  it("rejects a directory that is not a git repository with 422", async () => {
    const plain = newDir("not-a-repo");
    const res = await postProject(build(), plain);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error.code).toBe("NOT_A_GIT_REPOSITORY");
    expect(body.error.message).toContain("not a git repository");
  });

  it("rejects a path that does not exist with 422", async () => {
    const res = await postProject(build(), join(workDir, "missing"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error.code).toBe("PATH_NOT_FOUND");
  });

  it("registers an empty repo (no commits) with a warning", async () => {
    const repo = makeRepo("empty-repo", { commit: false });
    const body = await register(repo);
    expect(body.project.defaultBranch).toBe("main");
    expect(body.warnings).toEqual([NO_COMMITS_WARNING]);
    expect(body.project).toMatchObject({ name: "empty-repo", path: repo });
  });

  it("flags a dirty working copy", async () => {
    const repo = makeRepo("dirty-repo");
    writeFileSync(join(repo, "uncommitted.txt"), "wip\n");
    const body = await register(repo);
    expect(body.project.dirty).toBe(true);
  });

  it("flags a repo with staged-but-uncommitted changes as dirty", async () => {
    const repo = makeRepo("staged-repo");
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    git(repo, "add", "-A");
    const body = await register(repo);
    expect(body.project.dirty).toBe(true);
  });

  it("handles paths containing spaces and unicode characters", async () => {
    const repo = makeRepo("my 项目 repo");
    const body = await register(repo);
    expect(body.project.name).toBe("my 项目 repo");
    expect(body.project.path).toBe(join(workDir, "my 项目 repo"));
  });

  it("rejects a missing path field with 422", async () => {
    const res = await build().request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects malformed JSON with 422", async () => {
    const res = await build().request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error.code).toBe("INVALID_JSON");
  });

  it("registers two repos with distinct ids", async () => {
    const first = await register(makeRepo("alpha"));
    const second = await register(makeRepo("beta"));
    expect(first.project.id).not.toBe(second.project.id);
  });
});

describe("project round-trip (curl-style e2e)", () => {
  it("create → list → get → delete → get 404", async () => {
    const app = build();
    const repo = makeRepo("round-trip", { remote: "git@example.com:o/r.git" });
    const created = await postProject(app, repo);
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as ProjectResponseBody;
    expect(project.name).toBe("round-trip");

    const listed = await app.request("/api/projects");
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { projects: ProjectResponseBody["project"][] }).projects,
    ).toEqual([project]);

    const got = await app.request(`/api/projects/${project.id}`);
    expect(got.status).toBe(200);
    expect(((await got.json()) as { project: ProjectResponseBody["project"] }).project).toEqual(
      project,
    );

    const deleted = await app.request(`/api/projects/${project.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);

    const afterDelete = await app.request(`/api/projects/${project.id}`);
    expect(afterDelete.status).toBe(404);

    const emptyList = await app.request("/api/projects");
    expect(((await emptyList.json()) as { projects: unknown[] }).projects).toEqual([]);
  });

  it("returns 404 for unknown ids on get and delete", async () => {
    const app = build();
    const unknown = crypto.randomUUID();
    const got = await app.request(`/api/projects/${unknown}`);
    expect(got.status).toBe(404);
    expect(((await got.json()) as ErrorResponseBody).error.code).toBe("PROJECT_NOT_FOUND");
    const deleted = await app.request(`/api/projects/${unknown}`, { method: "DELETE" });
    expect(deleted.status).toBe(404);
  });
});
