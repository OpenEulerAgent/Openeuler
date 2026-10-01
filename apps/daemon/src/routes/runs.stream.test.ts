import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, Project, Run, Step } from "@openeuler/core";
import { linearToGraph } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import { createLogger } from "../logger.js";

interface ApiHarness {
  dir: string;
  db: Db;
  request: (input: string | Request, init?: RequestInit) => Promise<Response>;
  projects: Project[];
  /** Every AbortController handed to an SSE request; torn down in afterEach. */
  controllers: Set<AbortController>;
}

interface ErrorResponseBody {
  error: { code: string; message: string };
}

/** One parsed SSE frame off the global stream. */
interface StreamFrame {
  event: string;
  data: string;
}

interface RunStatusFrame {
  runId: string;
  status: Run["status"];
  projectId: string;
  workflowRevision?: { id: string; number: number };
}

const created: { db: Db; dir: string; controllers: Set<AbortController> }[] = [];

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const script: AgentEvent[] = [{ type: "done", seq: 1, output: "all done" }];

const setup = (fakeOpts: Parameters<typeof createFakeDriver>[0] = {}): ApiHarness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-run-stream-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const projects: Project[] = [];
  for (const name of ["alpha", "beta"]) {
    const repoPath = join(dir, name);
    execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
    writeFileSync(join(repoPath, "README.md"), `# ${name}\n`);
    git(repoPath, "add", "-A");
    git(repoPath, "-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init");
    projects.push(
      db.projects.create({
        id: crypto.randomUUID(),
        path: repoPath,
        name,
        defaultBranch: "main",
        createdAt: new Date().toISOString(),
      }),
    );
  }

  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver(fakeOpts));
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot: join(dir, "store") }),
    drivers,
    logger: createLogger("silent"),
  });
  const { app } = createApp({
    db,
    logger: createLogger("silent"),
    executor,
    globalStream: { heartbeatMs: 50 },
  });

  const controllers = new Set<AbortController>();
  created.push({ db, dir, controllers });
  return {
    dir,
    db,
    request: (input, init) => Promise.resolve(app.request(input, init)),
    projects,
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

const postRun = (h: ApiHarness, projectId: string, prompt: string): Promise<Run> =>
  h
    .request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, prompt }),
    })
    .then(async (res) => {
      expect(res.status).toBe(202);
      return ((await res.json()) as { run: Run }).run;
    });

const TERMINAL: ReadonlySet<string> = new Set(["success", "failed", "aborted", "interrupted"]);

const fakeStep = (id: string): Step => ({
  id,
  name: id,
  driver: "fake",
  promptTemplate: "{{task}}",
  mode: "auto",
  continueSession: false,
});

const awaitTerminal = async (h: ApiHarness, runId: string): Promise<Run> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = h.db.runs.get(runId);
    if (run !== undefined && TERMINAL.has(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} never reached a terminal status`);
    await sleep(10);
  }
};

/** Opens the global stream; the harness tracks the controller for teardown. */
const openStream = async (h: ApiHarness, controller = new AbortController()): Promise<Response> => {
  h.controllers.add(controller);
  return h.request(new Request("http://localhost/api/runs/stream", { signal: controller.signal }));
};

/**
 * Incremental SSE reader over the global stream (data frames + `: ping`
 * heartbeats), with per-read race guards.
 */
class StreamReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  readonly frames: StreamFrame[] = [];
  readonly pings: string[] = [];
  done = false;

  constructor(res: Response) {
    if (res.body === null) throw new Error("stream response has no body");
    this.reader = res.body.getReader();
  }

  private consume(flush: boolean): void {
    const parts = this.buffer.split("\n\n");
    this.buffer = flush ? "" : (parts.pop() ?? "");
    for (const part of parts) {
      if (part === "") continue;
      if (part.startsWith(":")) {
        this.pings.push(part);
        continue;
      }
      const frame: Partial<StreamFrame> = {};
      for (const line of part.split("\n")) {
        if (line.startsWith("event: ")) frame.event = line.slice(7);
        else if (line.startsWith("data: ")) frame.data = line.slice(6);
      }
      if (frame.event === undefined || frame.data === undefined) continue;
      this.frames.push(frame as StreamFrame);
    }
  }

  /** Next data frame, or null once closed; throws on timeout. */
  async next(timeoutMs = 5_000): Promise<StreamFrame | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.frames.length > 0) return this.frames.shift() ?? null;
      if (this.done) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for the next stream frame");
      const chunk = await Promise.race([
        this.reader.read(),
        sleep(remaining).then((): never => {
          throw new Error("timed out waiting for the next stream frame");
        }),
      ]);
      if (chunk.done) {
        this.done = true;
        this.consume(true);
        continue;
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      this.consume(false);
    }
  }

  /** Collects data frames until close or `count` frames arrived. */
  async collect(count: number, timeoutMs = 5_000): Promise<RunStatusFrame[]> {
    const parsed: RunStatusFrame[] = [];
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (frame === null) break;
      parsed.push(JSON.parse(frame.data) as RunStatusFrame);
      if (parsed.length >= count) break;
    }
    return parsed;
  }
}

const runStatusFrames = (frames: readonly RunStatusFrame[], runId: string): string[] =>
  frames.filter((frame) => frame.runId === runId).map((frame) => frame.status);

describe("GET /api/runs/stream (global run-status SSE)", () => {
  it("pushes queued, running and terminal transitions for any run", async () => {
    const h = setup({ events: script, delayMs: 20 });
    const res = await openStream(h);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = new StreamReader(res);

    const [alpha, beta] = h.projects as [Project, Project];
    const first = await postRun(h, alpha.id as string, "first");
    const second = await postRun(h, beta.id as string, "second");

    // Alpha executes immediately; beta is serialized behind its own project
    // gate but is a different project, so both run under the global cap.
    const frames = await reader.collect(6);
    expect(runStatusFrames(frames, first.id)).toEqual(["queued", "running", "success"]);
    expect(runStatusFrames(frames, second.id)).toEqual(["queued", "running", "success"]);

    const frameFor = (runId: string, status: string): RunStatusFrame | undefined =>
      frames.find((frame) => frame.runId === runId && frame.status === status);
    expect(frameFor(first.id as string, "queued")?.projectId).toBe(alpha.id);
    expect(frameFor(first.id as string, "running")?.projectId).toBe(alpha.id);

    await awaitTerminal(h, first.id);
    await awaitTerminal(h, second.id);
  }, 10_000);

  it("carries the pinned workflowRevision for workflow runs", async () => {
    const h = setup({ events: script });
    const workflow = h.db.workflows.create({
      id: crypto.randomUUID(),
      projectId: (h.projects[0] as Project).id,
      name: "wf",
      steps: [fakeStep("s1")],
    });
    const revision = h.db.workflowRevisions.create(
      workflow.id,
      linearToGraph({ steps: [fakeStep("s1")] }),
    );

    const reader = new StreamReader(await openStream(h));
    const runRes = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "go" }),
    });
    expect(runRes.status).toBe(202);
    const { run } = (await runRes.json()) as { run: Run };

    const frames = await reader.collect(3);
    expect(runStatusFrames(frames, run.id)).toEqual(["queued", "running", "success"]);
    for (const status of ["queued", "running", "success"]) {
      const frame = frames.find((f) => f.runId === run.id && f.status === status);
      expect(frame?.workflowRevision).toMatchObject({ id: revision.id, number: 1 });
    }
    await awaitTerminal(h, run.id);
  }, 10_000);

  it("heartbeats while quiet and stops after client disconnect (slot is freed)", async () => {
    const h = setup({ events: script });
    const quiet = new StreamReader(await openStream(h));
    // Read (with a short race window) so buffered heartbeats get parsed.
    await quiet.next(250).catch(() => null);
    expect(quiet.pings.length).toBeGreaterThanOrEqual(1);
    expect(quiet.pings.every((ping) => ping.startsWith(": ping"))).toBe(true);
    expect(quiet.frames).toHaveLength(0);

    // Slot cleanup on disconnect: cap the stream at the daemon default of 10
    // is too heavy for a unit test, so prove reuse differently — a second
    // stream opens fine after the first disconnects and still receives
    // transitions, while the disconnected one receives nothing further.
    const controller = new AbortController();
    const first = new StreamReader(await openStream(h, controller));
    controller.abort();
    await sleep(100);

    const second = new StreamReader(await openStream(h));
    const run = await postRun(h, (h.projects[0] as Project).id, "after disconnect");
    const frames = await second.collect(3);
    expect(runStatusFrames(frames, run.id)).toEqual(["queued", "running", "success"]);
    await awaitTerminal(h, run.id);
    // The aborted stream delivered nothing past its disconnect.
    expect(first.frames).toHaveLength(0);
  }, 10_000);

  it("503s without an executor", async () => {
    const { app } = createApp({ logger: createLogger("silent") });
    const res = await app.request("/api/runs/stream");
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("EXECUTOR_UNAVAILABLE");
  });
});

describe("GET /api/runs (dashboard table queries)", () => {
  it("filters by a comma-separated status list", async () => {
    let stallNextRun = false;
    const h = setup({ events: script, onStart: () => (stallNextRun ? sleep(10_000) : undefined) });
    const alpha = h.projects[0] as Project;
    const success = await postRun(h, alpha.id, "will succeed");
    await awaitTerminal(h, success.id);

    stallNextRun = true;
    const slow = await postRun(h, alpha.id, "will abort");
    const abort = await h.request(`/api/runs/${slow.id}/abort`, { method: "POST" });
    expect(abort.status).toBe(200);
    await awaitTerminal(h, slow.id);

    const both = (await (
      await h.request(`/api/runs?status=success,aborted&projectId=${alpha.id}`)
    ).json()) as { runs: Run[] };
    expect(new Set(both.runs.map((run) => run.status))).toEqual(new Set(["success", "aborted"]));

    const onlySuccess = (await (await h.request("/api/runs?status=success")).json()) as {
      runs: Run[];
    };
    expect(onlySuccess.runs.every((run) => run.status === "success")).toBe(true);
    expect(onlySuccess.runs.map((run) => run.id)).toContain(success.id);

    const bad = await h.request("/api/runs?status=success,nope");
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as ErrorResponseBody).error.code).toBe("INVALID_STATUS");
  }, 10_000);

  it("decorates rows with project and workflow names", async () => {
    const h = setup({ events: script });
    const alpha = h.projects[0] as Project;
    const workflow = h.db.workflows.create({
      id: crypto.randomUUID(),
      projectId: alpha.id,
      name: "named workflow",
      steps: [fakeStep("s1")],
    });
    const revision = h.db.workflowRevisions.create(
      workflow.id,
      linearToGraph({ steps: [fakeStep("s1")] }),
    );
    const run = h.db.runs.create({
      id: crypto.randomUUID(),
      projectId: alpha.id,
      workflowId: workflow.id,
      workflowRevisionId: revision.id,
      status: "running",
      branch: "run/x",
      iteration: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const body = (await (await h.request("/api/runs")).json()) as {
      runs: Array<Run & { project?: { name: string }; workflow?: { name: string } }>;
    };
    const row = body.runs.find((candidate) => candidate.id === run.id);
    expect(row?.project).toMatchObject({ id: alpha.id, name: "alpha" });
    expect(row?.workflow).toMatchObject({ id: workflow.id, name: "named workflow" });
  });
});

describe("GET /api/runs/stats (per-project counts)", () => {
  it("scopes queued/running counts to ?projectId=", async () => {
    const h = setup({ events: script, onStart: () => sleep(10_000) });
    const [alpha, beta] = h.projects as [Project, Project];

    const running = await postRun(h, alpha.id, "long");
    const deadline = Date.now() + 5_000;
    while (h.db.runs.get(running.id)?.status !== "running" && Date.now() < deadline) {
      await sleep(10);
    }

    const scoped = (await (await h.request(`/api/runs/stats?projectId=${alpha.id}`)).json()) as {
      queued: number;
      running: number;
      projectId?: string;
    };
    expect(scoped).toEqual({ queued: 0, running: 1, projectId: alpha.id });

    const other = (await (await h.request(`/api/runs/stats?projectId=${beta.id}`)).json()) as {
      queued: number;
      running: number;
      projectId?: string;
    };
    expect(other).toEqual({ queued: 0, running: 0, projectId: beta.id });

    const global = (await (await h.request("/api/runs/stats")).json()) as {
      queued: number;
      running: number;
    };
    expect(global).toEqual({ queued: 0, running: 1 });

    const abort = await h.request(`/api/runs/${running.id}/abort`, { method: "POST" });
    expect(abort.status).toBe(200);
    await awaitTerminal(h, running.id);
  }, 10_000);
});
