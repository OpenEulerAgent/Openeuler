import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import { createLogger } from "../logger.js";
import type { ActivityApiItem, ActivityListBody } from "./activity.js";

interface ApiHarness {
  dir: string;
  db: Db;
  request: (input: string | Request, init?: RequestInit) => Promise<Response>;
  projectId: string;
  /** Every AbortController handed to an SSE request; torn down in afterEach. */
  controllers: Set<AbortController>;
}

interface ErrorResponseBody {
  error: { code: string; message: string };
}

const created: { db: Db; dir: string; controllers: Set<AbortController> }[] = [];

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const setup = (fakeOpts: Parameters<typeof createFakeDriver>[0] = {}): ApiHarness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-activity-"));
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
  drivers.registerDriver(createFakeDriver(fakeOpts));
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot: join(dir, "store") }),
    drivers,
    logger: createLogger("silent"),
  });
  const { app } = createApp({ db, logger: createLogger("silent"), executor });

  const controllers = new Set<AbortController>();
  created.push({ db, dir, controllers });
  return {
    dir,
    db,
    request: (input, init) => Promise.resolve(app.request(input, init)),
    projectId: project.id,
    controllers,
  };
};

afterEach(() => {
  while (created.length > 0) {
    const item = created.pop() as (typeof created)[number];
    for (const controller of item.controllers) controller.abort();
    item.db.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

const postJson = (h: ApiHarness, path: string, body: unknown): Promise<Response> =>
  h.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const postRun = (h: ApiHarness, prompt: string): Promise<Run> =>
  postJson(h, "/api/runs", { projectId: h.projectId, prompt }).then(async (res) => {
    expect(res.status).toBe(202);
    return ((await res.json()) as { run: Run }).run;
  });

const listActivity = (h: ApiHarness, query = ""): Promise<ActivityListBody> =>
  h.request(`/api/activity${query}`).then(async (res) => {
    expect(res.status).toBe(200);
    return (await res.json()) as ActivityListBody;
  });

const TERMINAL: ReadonlySet<string> = new Set(["success", "failed", "aborted", "interrupted"]);

const awaitTerminal = async (h: ApiHarness, runId: string): Promise<Run> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = h.db.runs.get(runId);
    if (run !== undefined && TERMINAL.has(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} never reached a terminal status`);
    await sleep(10);
  }
};

describe("GET /api/activity (feed emit points)", () => {
  it("is empty (no nextCursor) on a fresh install", async () => {
    const h = setup();
    const body = await listActivity(h);
    expect(body).toEqual({ items: [] });
  });

  it("records project.created, workflow.created, run.started and run.completed", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "ok" }] });

    const workflowRes = await postJson(h, "/api/workflows", {
      projectId: h.projectId,
      name: "review",
      steps: [
        {
          id: "s1",
          name: "do",
          driver: "fake",
          promptTemplate: "{{task}}",
          mode: "auto",
          continueSession: false,
        },
      ],
    });
    expect(workflowRes.status).toBe(201);
    const { workflow } = (await workflowRes.json()) as {
      workflow: { id: string; name: string };
    };

    const runRes = await postJson(h, `/api/workflows/${workflow.id}/runs`, {
      task: "please review",
    });
    expect(runRes.status).toBe(202);
    const run = ((await runRes.json()) as { run: Run }).run;
    await awaitTerminal(h, run.id);

    const body = await listActivity(h);
    const types = body.items.map((item) => item.type);
    expect(types).toEqual(["run.completed", "run.started", "workflow.created"]);
    expect(body.nextCursor).toBeUndefined();

    const started = body.items[1] as ActivityApiItem;
    expect(started.run).toMatchObject({ id: run.id, status: "running" });
    expect(started.workflow).toMatchObject({ id: workflow.id, name: "review" });
    expect(started.project).toMatchObject({ id: h.projectId, name: "repo" });
    expect(started.message).toBe("Run review started");

    const completed = body.items[0] as ActivityApiItem;
    expect(completed.run).toMatchObject({ id: run.id, status: "success" });
    expect(completed.message).toBe("Run review completed");

    // The queued admission is a stream-only transition: never a feed row.
    expect(body.items.some((item) => item.type.startsWith("run."))).toBe(true);
    expect(body.items.some((item) => item.type === "workflow.created")).toBe(true);
    expect(body.items).toHaveLength(3);
  });

  it("records aborted runs (abort before the engine starts)", async () => {
    const h = setup({ onStart: () => sleep(10_000) });
    const run = await postRun(h, "slow one");

    const abort = await h.request(`/api/runs/${run.id}/abort`, { method: "POST" });
    expect(abort.status).toBe(200);
    await awaitTerminal(h, run.id);

    const body = await listActivity(h);
    expect(body.items.map((item) => item.type)).toEqual(["run.aborted", "run.started"]);
  });

  it("rejects an invalid cursor or limit with 422", async () => {
    const h = setup();
    for (const query of ["?cursor=abc", "?cursor=-1", "?limit=0", "?limit=1000"]) {
      const res = await h.request(`/api/activity${query}`);
      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorResponseBody).error.code).toBe("INVALID_QUERY");
    }
  });
});

describe("GET /api/activity (cursor pagination)", () => {
  it("paginates newest-first with no duplicates or gaps across pages", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "ok" }] });

    const expected: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await postRun(h, `run ${i}`);
      await awaitTerminal(h, run.id);
      expected.push(i);
    }
    // 3 runs × (started + completed) = 6 feed rows, newest run first.
    const total = 6;

    const collected: ActivityApiItem[] = [];
    let query = "?limit=2";
    for (;;) {
      const page = await listActivity(h, query);
      expect(page.items.length).toBeLessThanOrEqual(2);
      collected.push(...page.items);
      if (page.nextCursor === undefined) break;
      query = `?cursor=${page.nextCursor}&limit=2`;
    }

    expect(collected).toHaveLength(total);
    const ids = collected.map((item) => item.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(total);
    // Strictly descending, consecutive: no gaps.
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]).toBe((ids[i - 1] as number) - 1);
    }
    // Newest first: the last run's completion leads the feed.
    expect(collected[0]?.type).toBe("run.completed");
    expect(collected[0]?.message).toBe("Run run 2 completed");

    // Cursor stability: the same cursor returns the same page.
    const firstPage = await listActivity(h, "?limit=2");
    const reRead = await listActivity(h, `?cursor=${firstPage.nextCursor}&limit=2`);
    const again = await listActivity(h, `?cursor=${firstPage.nextCursor}&limit=2`);
    expect(reRead.items.map((item) => item.id)).toEqual(again.items.map((item) => item.id));

    // A full-length page offers a cursor; the tail page does not.
    expect(firstPage.nextCursor).toBeDefined();
    const tail = await listActivity(h, `?cursor=${collected[collected.length - 1]?.id}&limit=2`);
    expect(tail.items).toEqual([]);
    expect(tail.nextCursor).toBeUndefined();
  });

  it("returns an empty page past the oldest row without a nextCursor", async () => {
    const h = setup();
    const run = await postRun(h, "single");
    await awaitTerminal(h, run.id);
    const page = await listActivity(h);
    const oldest = page.items[page.items.length - 1] as ActivityApiItem;
    const past = await listActivity(h, `?cursor=${oldest.id}`);
    expect(past).toEqual({ items: [] });
  });
});
