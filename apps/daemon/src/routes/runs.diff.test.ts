import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, Run, RunStatus, Step, StepRun } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createFakeDriver, type FakeDriverOptions } from "@openeuler/drivers";
import { createDriverRegistry } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import type { Executor } from "../executor.js";
import { createLogger } from "../logger.js";
import { capPatchLines, MAX_DIFF_PATCH_LINES, splitStepDiff } from "./runs.js";

/**
 * Endpoint tests for GET /api/runs/:id/diff (issue #20): per-step stored
 * diffs (isolation), live cumulative diffs (multi-file counts vs
 * `git diff --stat`), the truncation cap, and every error path
 * (404/422/410/503).
 */

interface ApiHarness {
  dir: string;
  db: Db;
  storeRoot: string;
  worktrees: WorktreeManager;
  executor: Executor;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
}

interface DiffBody {
  scope: "step" | "cumulative";
  stat: string;
  patch: string;
  truncated: boolean;
  totalLines: number;
  maxLines: number;
  stepRunId?: string;
}

interface RunDetailBody {
  run: Run;
  steps: StepRun[];
}

interface ErrorResponseBody {
  error: { code: string; message: string };
}

const script: AgentEvent[] = [
  { type: "session", seq: 1, sessionId: "s_1" },
  { type: "done", seq: 2, output: "done" },
];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const created: { db: Db; dir: string }[] = [];

const setup = (
  fakeOpts: FakeDriverOptions = {},
  appOpts: { withWorktrees?: boolean } = {},
): ApiHarness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-runs-diff-"));
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
  const worktrees = new WorktreeManager({ storeRoot });
  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver(fakeOpts));
  const executor = createExecutor({
    db,
    worktrees,
    drivers,
    logger: createLogger("silent"),
  });
  const { app } = createApp({
    db,
    logger: createLogger("silent"),
    executor,
    ...(appOpts.withWorktrees === false ? {} : { worktrees }),
  });

  created.push({ db, dir });
  return {
    dir,
    db,
    storeRoot,
    worktrees,
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

const getRunDetail = async (h: ApiHarness, runId: string): Promise<RunDetailBody> => {
  const res = await h.request(`/api/runs/${runId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as RunDetailBody;
};

const pollRun = async (
  h: ApiHarness,
  runId: string,
  want: RunStatus,
  timeoutMs = 5_000,
): Promise<RunDetailBody> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await getRunDetail(h, runId);
    if (body.run.status === want) return body;
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${want}; last status ${body.run.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Enqueues a workflow run directly (POST /api/runs is ad-hoc only) and starts it. */
const startWorkflowRun = (h: ApiHarness, steps: Step[], runId: string): void => {
  const workflow = h.db.workflows.create({
    id: crypto.randomUUID(),
    projectId: h.projectId,
    name: "flow",
    steps,
  });
  const now = new Date().toISOString();
  h.db.runs.create({
    id: runId,
    projectId: h.projectId,
    workflowId: workflow.id,
    status: "queued",
    branch: `agentloop/${runId}`,
    iteration: 0,
    task: "do the things",
    createdAt: now,
    updatedAt: now,
  });
  h.executor.startRun(runId);
};

describe("splitStepDiff + capPatchLines (unit)", () => {
  it("splits the stored stat\\npatch combination at the first diff --git line", () => {
    const stored =
      " README.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\ndiff --git a/README.md b/README.md\nindex abc..def 100644\n--- a/README.md\n+++ b/README.md\n";
    const { stat, patch } = splitStepDiff(stored);
    expect(stat).toBe(" README.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)");
    expect(patch.startsWith("diff --git a/README.md b/README.md")).toBe(true);
    expect(patch).toContain("+++ b/README.md");
  });

  it("treats a stored diff with no patch section as stat-only (clean tree)", () => {
    const { stat, patch } = splitStepDiff(" 0 files changed");
    expect(stat).toBe(" 0 files changed");
    expect(patch).toBe("");
    expect(splitStepDiff("")).toEqual({ stat: "", patch: "" });
  });

  it("caps patches at MAX_DIFF_PATCH_LINES and reports the true total", () => {
    const lines = Array.from({ length: MAX_DIFF_PATCH_LINES + 500 }, (_, i) => `line-${i}`);
    const patch = lines.join("\n");
    const capped = capPatchLines(patch);
    expect(capped.truncated).toBe(true);
    expect(capped.totalLines).toBe(MAX_DIFF_PATCH_LINES + 500);
    expect(capped.patch.split("\n").length).toBe(MAX_DIFF_PATCH_LINES);
    expect(capped.patch.endsWith(`line-${MAX_DIFF_PATCH_LINES - 1}`)).toBe(true);
  });

  it("passes short patches through untouched", () => {
    const capped = capPatchLines("diff --git a/x b/x\n+hello\n");
    expect(capped).toEqual({
      patch: "diff --git a/x b/x\n+hello\n",
      truncated: false,
      // split("\n") counts the trailing newline's empty tail as a line.
      totalLines: 3,
    });
  });
});

describe("GET /api/runs/:id/diff?scope=step", () => {
  it("isolates each StepRun's own changes in a 2-step workflow writing different files", async () => {
    const h = setup({
      events: script,
      output: "done",
      onStart: (opts) => {
        // The two steps branch on their rendered prompt.
        if (opts.prompt.includes("alpha")) {
          writeFileSync(join(opts.cwd, "alpha.txt"), "const alpha = 1;\n");
        } else {
          writeFileSync(join(opts.cwd, "beta.txt"), "const beta = 2;\n");
        }
      },
    });
    const runId = crypto.randomUUID();
    startWorkflowRun(
      h,
      [
        {
          id: "s1",
          name: "alpha",
          driver: "fake",
          mode: "auto",
          promptTemplate: "write the alpha file",
          continueSession: false,
        },
        {
          id: "s2",
          name: "beta",
          driver: "fake",
          mode: "auto",
          promptTemplate: "write the beta file",
          continueSession: false,
        },
      ],
      runId,
    );
    const final = await pollRun(h, runId, "success");
    expect(final.steps).toHaveLength(2);
    const [step1, step2] = final.steps;

    const res1 = await h.request(`/api/runs/${runId}/diff?scope=step&stepRunId=${step1?.id}`);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as DiffBody;
    expect(body1).toMatchObject({ scope: "step", stepRunId: step1?.id, truncated: false });
    expect(body1.stat).toContain("alpha.txt");
    expect(body1.patch).toContain("diff --git a/alpha.txt b/alpha.txt");
    expect(body1.patch).not.toContain("beta.txt");

    const res2 = await h.request(`/api/runs/${runId}/diff?scope=step&stepRunId=${step2?.id}`);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as DiffBody;
    expect(body2.patch).toContain("diff --git a/beta.txt b/beta.txt");
    // THE isolation property: step 2 must not replay step 1's changes.
    expect(body2.patch).not.toContain("alpha.txt");
    expect(body2.stat).not.toContain("alpha.txt");

    // totalLines matches the patch, and the response echoes the cap.
    expect(body2.totalLines).toBe(body2.patch.split("\n").length);
    expect(body2.maxLines).toBe(MAX_DIFF_PATCH_LINES);
  });

  it("still serves stored step diffs after the worktree is gone", async () => {
    const h = setup({
      events: script,
      output: "done",
      onStart: (opts) => {
        writeFileSync(join(opts.cwd, "feature.txt"), "feature\n");
      },
    });
    const res = await h.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: h.projectId, prompt: "add the feature" }),
    });
    const { run } = (await res.json()) as { run: Run };
    const final = await pollRun(h, run.id, "success");
    const stepRunId = final.steps[0]?.id as string;

    await h.worktrees.remove(run.id);
    expect(h.worktrees.existing(run.id)).toBeNull();

    const stepRes = await h.request(`/api/runs/${run.id}/diff?scope=step&stepRunId=${stepRunId}`);
    expect(stepRes.status).toBe(200);
    expect(((await stepRes.json()) as DiffBody).patch).toContain("feature.txt");
  });

  it("422 when scope=step has no stepRunId, and 422 on a bad scope", async () => {
    const h = setup({ events: script });
    const res = await h.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: h.projectId, prompt: "x" }),
    });
    const { run } = (await res.json()) as { run: Run };
    await pollRun(h, run.id, "success");

    const missing = await h.request(`/api/runs/${run.id}/diff?scope=step`);
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as ErrorResponseBody).error.code).toBe("STEP_RUN_ID_REQUIRED");

    const badScope = await h.request(`/api/runs/${run.id}/diff?scope=everything`);
    expect(badScope.status).toBe(422);
    expect(((await badScope.json()) as ErrorResponseBody).error.code).toBe("VALIDATION_ERROR");
  });

  it("404s for an unknown run and for a stepRunId from another run", async () => {
    const h = setup({ events: script });
    const res = await h.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: h.projectId, prompt: "x" }),
    });
    const { run } = (await res.json()) as { run: Run };
    const final = await pollRun(h, run.id, "success");
    const stepRunId = final.steps[0]?.id as string;

    // Seed a second run whose id is used with the first run's stepRunId.
    const otherRunId = crypto.randomUUID();
    const now = new Date().toISOString();
    h.db.runs.create({
      id: otherRunId,
      projectId: h.projectId,
      status: "queued",
      branch: `agentloop/${otherRunId}`,
      iteration: 0,
      task: "other",
      createdAt: now,
      updatedAt: now,
    });

    const noRun = await h.request(`/api/runs/${crypto.randomUUID()}/diff?scope=cumulative`);
    expect(noRun.status).toBe(404);
    expect(((await noRun.json()) as ErrorResponseBody).error.code).toBe("RUN_NOT_FOUND");

    // stepRunId exists but belongs to a different run → 404, not a leak.
    const foreign = await h.request(
      `/api/runs/${otherRunId}/diff?scope=step&stepRunId=${stepRunId}`,
    );
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as ErrorResponseBody).error.code).toBe("STEP_RUN_NOT_FOUND");
  });
});

describe("GET /api/runs/:id/diff?scope=cumulative", () => {
  it("returns the full multi-file change with counts matching git diff --stat", async () => {
    const h = setup({
      events: script,
      output: "done",
      onStart: (opts) => {
        writeFileSync(join(opts.cwd, "README.md"), "# changed\nsecond line\n");
        mkdirSync(join(opts.cwd, "src"), { recursive: true });
        mkdirSync(join(opts.cwd, "docs"), { recursive: true });
        writeFileSync(join(opts.cwd, "src/new-module.ts"), "export const x = 1;\n");
        writeFileSync(join(opts.cwd, "docs/notes.md"), "# notes\n");
      },
    });
    const res = await h.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: h.projectId, prompt: "multi-file change" }),
    });
    const { run } = (await res.json()) as { run: Run };
    await pollRun(h, run.id, "success");
    expect(existsSync(join(h.storeRoot, run.id))).toBe(true);

    // Defaults to cumulative when scope is omitted.
    const diffRes = await h.request(`/api/runs/${run.id}/diff`);
    expect(diffRes.status).toBe(200);
    const body = (await diffRes.json()) as DiffBody;
    expect(body.scope).toBe("cumulative");
    expect(body.truncated).toBe(false);

    // Counts match `git diff --stat` computed in the worktree itself.
    const expectedStat = git(join(h.storeRoot, run.id), "diff", "--stat", "HEAD");
    expect(body.stat).toBe(expectedStat);

    // One diff --git section per changed file; hunk headers present.
    const files = body.patch.match(/^diff --git a\/(.+) b\/\1$/gm) ?? [];
    expect(files.sort()).toEqual([
      "diff --git a/README.md b/README.md",
      "diff --git a/docs/notes.md b/docs/notes.md",
      "diff --git a/src/new-module.ts b/src/new-module.ts",
    ]);
    expect(body.patch).toMatch(/@@ -1 \+1,2 @@/);
    expect(body.patch).toContain("diff --git a/src/new-module.ts b/src/new-module.ts");
    expect(body.patch).toContain("+export const x = 1;");
  });

  it("flags truncation for a huge (10k+ line) generated diff", async () => {
    const h = setup({
      events: script,
      output: "done",
      onStart: (opts) => {
        const lines = Array.from({ length: 25_000 }, (_, i) => `generated line ${i}`);
        writeFileSync(join(opts.cwd, "generated.txt"), `${lines.join("\n")}\n`);
      },
    });
    const res = await h.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: h.projectId, prompt: "generate a huge file" }),
    });
    const { run } = (await res.json()) as { run: Run };
    await pollRun(h, run.id, "success");

    const diffRes = await h.request(`/api/runs/${run.id}/diff?scope=cumulative`);
    expect(diffRes.status).toBe(200);
    const body = (await diffRes.json()) as DiffBody;
    expect(body.truncated).toBe(true);
    expect(body.totalLines).toBeGreaterThan(MAX_DIFF_PATCH_LINES);
    expect(body.patch.split("\n")).toHaveLength(MAX_DIFF_PATCH_LINES);
    // The stat block is NOT truncated — it stays a faithful file summary.
    expect(body.stat).toContain("generated.txt");
  });

  it("410s when the worktree no longer exists (run cleaned up)", async () => {
    const h = setup({ events: script });
    const res = await h.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: h.projectId, prompt: "x" }),
    });
    const { run } = (await res.json()) as { run: Run };
    await pollRun(h, run.id, "success");

    await h.worktrees.remove(run.id);

    const diffRes = await h.request(`/api/runs/${run.id}/diff?scope=cumulative`);
    expect(diffRes.status).toBe(410);
    const body = (await diffRes.json()) as ErrorResponseBody;
    expect(body.error.code).toBe("WORKTREE_GONE");
    expect(body.error.message).toContain("per-step");
  });

  it("503s when the app has no worktree manager configured", async () => {
    const h = setup({ events: script }, { withWorktrees: false });
    const res = await h.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: h.projectId, prompt: "x" }),
    });
    const { run } = (await res.json()) as { run: Run };
    await pollRun(h, run.id, "success");

    const diffRes = await h.request(`/api/runs/${run.id}/diff?scope=cumulative`);
    expect(diffRes.status).toBe(503);
    expect(((await diffRes.json()) as ErrorResponseBody).error.code).toBe("WORKTREES_UNAVAILABLE");
  });
});
