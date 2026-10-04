import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "@openeuler/core";
import { linearToGraph } from "@openeuler/core";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { createFakeDriver, type FakeDriverOptions } from "@openeuler/drivers";
import { createDriverRegistry } from "@openeuler/drivers";
import { ArtifactStore, WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import type { Executor } from "../executor.js";
import { createLogger } from "../logger.js";
import type { ArtifactManifest } from "@openeuler/engine";

/**
 * Endpoint tests for the run artifacts API (#122): terminal capture wired
 * end-to-end (workflow graph patterns → engine capture at terminal), list +
 * download, path-escape protection (lexical + symlink), terminal-only
 * semantics, auth, persistence across worktree pruning, and orphan GC with
 * worktree cleanup.
 */

interface ApiHarness {
  dir: string;
  db: Db;
  storeRoot: string;
  artifactsRoot: string;
  worktrees: WorktreeManager;
  artifacts: ArtifactStore;
  executor: Executor;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
}

interface ErrorResponseBody {
  error: { code: string; message: string };
}

const script = (sessionId: string): FakeDriverOptions["events"] => [
  { type: "session", seq: 1, sessionId },
  { type: "done", seq: 2, output: "done" },
];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const created: { db: Db; dir: string }[] = [];

const setup = (fakeOpts: FakeDriverOptions = {}): ApiHarness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-run-artifacts-"));
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

  const storeRoot = join(dir, "store");
  const artifactsRoot = join(dir, "artifacts");
  const worktrees = new WorktreeManager({ storeRoot });
  const artifacts = new ArtifactStore({ storeRoot: artifactsRoot });
  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver(fakeOpts));
  const executor = createExecutor({
    db,
    worktrees,
    drivers,
    logger: createLogger("silent"),
    artifacts,
  });
  const { app } = createApp({ db, logger: createLogger("silent"), executor, worktrees, artifacts });

  created.push({ db, dir });
  return {
    dir,
    db,
    storeRoot,
    artifactsRoot,
    worktrees,
    artifacts,
    executor,
    request: (path, init) => Promise.resolve(app.request(path, init)),
    projectId: project.id,
  };
};

afterEach(() => {
  while (created.length > 0) {
    const item = created.pop() as { db: Db; dir: string };
    item.db.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

/** Creates a workflow whose graph declares `patterns`, returns its id. */
const makeWorkflow = (h: ApiHarness, patterns: string[]): Promise<string> => {
  const graph = linearToGraph({
    steps: [
      {
        id: "build",
        name: "build",
        driver: "fake",
        mode: "auto",
        promptTemplate: "{{task}}",
        continueSession: false,
      },
    ],
  });
  const res = h.request("/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: h.projectId,
      name: "builder",
      graph: { ...graph, artifacts: patterns },
    }),
  });
  return res
    .then((r) => r.json() as Promise<{ workflow: { id: string } }>)
    .then((b) => b.workflow.id);
};

/** Starts a workflow run and waits for it to reach `status`. */
const runToStatus = async (h: ApiHarness, workflowId: string, status: string): Promise<Run> => {
  const res = await h.request(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "build the thing" }),
  });
  expect(res.status).toBe(202);
  const { run } = (await res.json()) as { run: Run };
  const deadline = Date.now() + 10_000;
  let current = run;
  while (current.status !== status) {
    if (Date.now() > deadline) throw new Error(`run stuck at ${current.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const body = (await (await h.request(`/api/runs/${encodeURIComponent(run.id)}`)).json()) as {
      run: Run;
    };
    current = body.run;
  }
  return current;
};

const writerDriver = (): FakeDriverOptions => ({
  events: script("s-artifacts"),
  output: "built",
  onStart: (opts) => {
    mkdirSync(join(opts.cwd, "dist", "assets"), { recursive: true });
    writeFileSync(join(opts.cwd, "dist", "app.js"), "console.log('app')\n");
    writeFileSync(join(opts.cwd, "dist", "assets", "style.css"), "body{margin:0}\n");
    writeFileSync(join(opts.cwd, "scratch.tmp"), "scratch\n");
  },
});

describe("GET /api/runs/:id/artifacts (#122)", () => {
  it("lists the captured set with sizes after the run turns terminal", async () => {
    const h = setup(writerDriver());
    const workflowId = await makeWorkflow(h, ["dist/**"]);
    const run = await runToStatus(h, workflowId, "success");

    const res = await h.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts`);
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as ArtifactManifest;
    expect(manifest.runStatus).toBe("success");
    expect(manifest.patterns).toEqual(["dist/**"]);
    expect(manifest.files.map((file) => file.path)).toEqual([
      "dist/app.js",
      "dist/assets/style.css",
    ]);
    expect(manifest.totalBytes).toBe("console.log('app')\n".length + "body{margin:0}\n".length);
    expect(manifest.truncated).toBe(false);
  });

  it("answers 409 RUN_NOT_TERMINAL while the run is live", async () => {
    const h = setup({
      events: script("s-hang"),
      onStart: () => new Promise(() => {}),
    });
    const workflowId = await makeWorkflow(h, ["dist/**"]);
    const res = await h.request(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "never ends" }),
    });
    const { run } = (await res.json()) as { run: Run };

    const list = await h.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts`);
    expect(list.status).toBe(409);
    expect(((await list.json()) as ErrorResponseBody).error.code).toBe("RUN_NOT_TERMINAL");

    await h.executor.abortRun(run.id);
  });

  it("answers 404 ARTIFACTS_NOT_FOUND for runs without artifact patterns", async () => {
    const h = setup(writerDriver());
    const workflowId = await makeWorkflow(h, []);
    const run = await runToStatus(h, workflowId, "success");

    const res = await h.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("ARTIFACTS_NOT_FOUND");
  });

  it("answers 409 ARTIFACTS_PENDING when a terminal capture directory has no manifest", async () => {
    const h = setup(writerDriver());
    const workflowId = await makeWorkflow(h, []);
    const run = await runToStatus(h, workflowId, "success");
    mkdirSync(h.artifacts.dirFor(run.id), { recursive: true });

    const res = await h.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("ARTIFACTS_PENDING");
  });

  it("answers 404 RUN_NOT_FOUND for unknown runs", async () => {
    const h = setup();
    const res = await h.request("/api/runs/nope/artifacts");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("RUN_NOT_FOUND");
  });

  it("answers 503 ARTIFACTS_UNAVAILABLE without a store", async () => {
    const h = setup(writerDriver());
    const workflowId = await makeWorkflow(h, []);
    const run = await runToStatus(h, workflowId, "success");
    // A second app over the same db, configured WITHOUT the store.
    const bare = createApp({ db: h.db, logger: createLogger("silent") });
    const res = await bare.app.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("ARTIFACTS_UNAVAILABLE");
  });

  it("requires auth when the daemon runs with a token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openeuler-run-artifacts-auth-"));
    const db = createDatabase({ path: join(dir, "test.db") });
    created.push({ db, dir });
    const repoPath = join(dir, "repo");
    execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
    writeFileSync(join(repoPath, "README.md"), "# demo\n");
    git(repoPath, "add", "-A");
    git(repoPath, "-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init");
    db.projects.create({
      id: crypto.randomUUID(),
      path: repoPath,
      name: "repo",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });

    const artifacts = new ArtifactStore({ storeRoot: join(dir, "artifacts") });
    const worktrees = new WorktreeManager({ storeRoot: join(dir, "store") });
    const drivers = createDriverRegistry();
    drivers.registerDriver(createFakeDriver(writerDriver()));
    const executor = createExecutor({
      db,
      worktrees,
      drivers,
      logger: createLogger("silent"),
      artifacts,
    });
    const { app } = createApp({
      db,
      logger: createLogger("silent"),
      executor,
      worktrees,
      artifacts,
      authToken: "sekret",
    });
    const request = (path: string, init?: RequestInit): Promise<Response> =>
      Promise.resolve(app.request(path, init));

    const workflow = linearToGraph({
      steps: [
        {
          id: "build",
          name: "build",
          driver: "fake",
          mode: "auto",
          promptTemplate: "{{task}}",
          continueSession: false,
        },
      ],
    });
    const project = db.projects.list()[0] as { id: string };
    const created_ = (await (
      await request("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sekret" },
        body: JSON.stringify({
          projectId: project.id,
          name: "builder",
          graph: { ...workflow, artifacts: ["dist/**"] },
        }),
      })
    ).json()) as { workflow: { id: string } };
    const started = (await (
      await request(`/api/workflows/${encodeURIComponent(created_.workflow.id)}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sekret" },
        body: JSON.stringify({ task: "build" }),
      })
    ).json()) as { run: Run };
    const deadline = Date.now() + 10_000;
    let run = started.run;
    while (run.status !== "success") {
      if (Date.now() > deadline) throw new Error(`run stuck at ${run.status}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      run = (
        (await (
          await request(`/api/runs/${encodeURIComponent(run.id)}`, {
            headers: { authorization: "Bearer sekret" },
          })
        ).json()) as { run: Run }
      ).run;
    }

    const rejected = await request(`/api/runs/${encodeURIComponent(run.id)}/artifacts`);
    expect(rejected.status).toBe(401);
    const okList = await request(`/api/runs/${encodeURIComponent(run.id)}/artifacts`, {
      headers: { authorization: "Bearer sekret" },
    });
    expect(okList.status).toBe(200);
    const okDownload = await request(
      `/api/runs/${encodeURIComponent(run.id)}/artifacts/dist/app.js`,
      {
        headers: { authorization: "Bearer sekret" },
      },
    );
    expect(okDownload.status).toBe(200);
  });
});

describe("GET /api/runs/:id/artifacts/:file (#122)", () => {
  it("downloads a captured file as an attachment", async () => {
    const h = setup(writerDriver());
    const workflowId = await makeWorkflow(h, ["dist/**"]);
    const run = await runToStatus(h, workflowId, "success");

    const res = await h.request(
      `/api/runs/${encodeURIComponent(run.id)}/artifacts/dist/assets/style.css`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body{margin:0}\n");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain('filename="style.css"');
  });

  it("rejects path traversal with 403 PATH_ESCAPE", async () => {
    const h = setup(writerDriver());
    const workflowId = await makeWorkflow(h, ["dist/**"]);
    const run = await runToStatus(h, workflowId, "success");
    const base = `/api/runs/${encodeURIComponent(run.id)}/artifacts`;

    for (const path of [
      "../../etc/passwd",
      "..%2F..%2Fetc%2Fpasswd",
      "/etc/passwd",
      "dist/../../../../etc/passwd",
    ]) {
      const res = await h.request(`${base}/${path}`);
      expect(res.status, path).toBeOneOf([403, 404]);
      const body = (await res.json()) as ErrorResponseBody;
      // Lexical escapes are 403 PATH_ESCAPE; the rest (absolute-looking
      // names, router-level rejects) 404 — no variant ever leaks bytes.
      if (res.status === 403) expect(body.error.code, path).toBe("PATH_ESCAPE");
      else
        expect(body.error.code, path).toBeOneOf([
          "PATH_NOT_FOUND",
          "ARTIFACT_NOT_FOUND",
          "NOT_FOUND",
        ]);
    }
  });

  it("rejects a manifest-member symlink that points outside with 403 PATH_ESCAPE", async () => {
    const h = setup(writerDriver());
    const workflowId = await makeWorkflow(h, ["dist/**"]);
    const run = await runToStatus(h, workflowId, "success");

    const listed = (await (
      await h.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts`)
    ).json()) as ArtifactManifest;
    const member = listed.files[0]?.path;
    if (member === undefined) throw new Error("expected at least one captured artifact");
    const secret = join(h.dir, "secret.txt");
    writeFileSync(secret, "top secret\n");
    const captured = join(h.artifacts.dirFor(run.id), ...member.split("/"));
    rmSync(captured, { force: true });
    symlinkSync(secret, captured);

    const res = await h.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts/${member}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PATH_ESCAPE");
  });

  it("refuses files outside the manifest with 404 ARTIFACT_NOT_FOUND", async () => {
    const h = setup(writerDriver());
    const workflowId = await makeWorkflow(h, ["dist/**"]);
    const run = await runToStatus(h, workflowId, "success");

    // Real file in the store, but not part of the captured set.
    writeFileSync(join(h.artifacts.dirFor(run.id), "stray.txt"), "stray\n");
    const res = await h.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts/stray.txt`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("ARTIFACT_NOT_FOUND");
  });

  it("answers 409 RUN_NOT_TERMINAL while the run is live", async () => {
    const h = setup({
      events: script("s-hang-dl"),
      onStart: () => new Promise(() => {}),
    });
    const workflowId = await makeWorkflow(h, ["dist/**"]);
    const res = await h.request(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "never ends" }),
    });
    const { run } = (await res.json()) as { run: Run };

    const download = await h.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts/x.txt`);
    expect(download.status).toBe(409);
    expect(((await download.json()) as ErrorResponseBody).error.code).toBe("RUN_NOT_TERMINAL");

    await h.executor.abortRun(run.id);
  });
});

describe("artifacts lifecycle (#122)", () => {
  it("keeps dist/** downloadable after the run's worktree is pruned", async () => {
    const h = setup(writerDriver());
    const workflowId = await makeWorkflow(h, ["dist/**"]);
    const run = await runToStatus(h, workflowId, "success");

    // Prune the terminal run's worktree through the worktree manager API.
    const prune = await h.request(
      `/api/projects/${encodeURIComponent(h.projectId)}/worktrees/prune`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: run.id }),
      },
    );
    expect(prune.status).toBe(200);
    const pruned = (await prune.json()) as { removed: unknown[] };
    expect(pruned.removed.length).toBe(1);
    expect(existsSync(join(h.storeRoot, run.id))).toBe(false);

    const list = await h.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts`);
    expect(list.status).toBe(200);
    const download = await h.request(
      `/api/runs/${encodeURIComponent(run.id)}/artifacts/dist/app.js`,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("console.log('app')\n");
  });

  it("garbage-collects orphaned artifact sets with worktree cleanup", async () => {
    const h = setup(writerDriver());
    const workflowId = await makeWorkflow(h, ["dist/**"]);
    const run = await runToStatus(h, workflowId, "success");

    // An artifact set whose run row does not exist (e.g. wiped db) is an
    // orphan: the maintenance prune removes it alongside orphan worktrees.
    const ghost = join(h.artifactsRoot, "ghost-run");
    mkdirSync(ghost, { recursive: true });
    writeFileSync(join(ghost, "x.txt"), "x");

    const res = await h.request("/api/system/maintenance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "prune-worktrees" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifactsPruned: number };
    expect(body.artifactsPruned).toBe(1);
    expect(existsSync(ghost)).toBe(false);
    // The real run's artifacts survive the sweep.
    expect(existsSync(h.artifacts.dirFor(run.id))).toBe(true);
  });

  it("captures failed runs too (partial build evidence)", async () => {
    const h = setup({
      ...writerDriver(),
      exitCode: 9,
    });
    const workflowId = await makeWorkflow(h, ["dist/**"]);
    const run = await runToStatus(h, workflowId, "failed");

    const res = await h.request(`/api/runs/${encodeURIComponent(run.id)}/artifacts`);
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as ArtifactManifest;
    expect(manifest.runStatus).toBe("failed");
    expect(manifest.files.map((file) => file.path)).toContain("dist/app.js");
  });
});
