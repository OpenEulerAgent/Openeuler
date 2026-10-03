import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver, createOpenCodeDriver } from "@openeuler/drivers";
import type { FakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import {
  createDockerAvailabilityProbe,
  createDockerSandboxProvider,
  docker,
} from "@openeuler/sandbox";
import { createApp } from "./app.js";
import { createExecutor } from "./executor.js";
import type { Executor } from "./executor.js";
import { createLogger } from "./logger.js";

/**
 * Real-docker e2e of live sandbox streaming (#104), following the #102
 * integration patterns:
 *
 * 1. a sandboxed run driven by the REAL opencode driver whose binary is a
 *    busybox `opencode` stub (committed into the repo → bind-mounted at
 *    /workspace) that emits NDJSON progressively with sleeps — an SSE client
 *    must receive agent events DURING the run (session ≈1.2s before done),
 *    not as one batch at completion, and the session id must land on the
 *    StepRun mid-node;
 * 2. container stdout (written via /proc/1/fd/1 so the json-file log driver
 *    captures it — `docker exec` output never reaches `docker logs`) tailed
 *    into ordered `sandbox.log` events with the ring cap enforced (2100
 *    scripted lines → exactly the last 2000 kept + one truncation marker).
 *
 * Auto-skips without a docker daemon (`DOCKER_E2E=0` or a failed probe);
 * sweeps every container it created.
 */

const BUSYBOX = "busybox:1.36";

const dockerLive =
  process.env.DOCKER_E2E === "0"
    ? false
    : await createDockerAvailabilityProbe().check({ force: true });

interface SseMessage {
  id: string;
  event: string;
  data: string;
}

/** Incremental SSE reader over one response body (data frames + pings). */
class SseReader {
  private buffer = "";
  private done = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  /** The single in-flight read — concurrent `read()` calls on the proxied
   * body break the stream, so the pending promise is reused across races. */
  private pending: Promise<{ done: boolean; value?: Uint8Array }> | null = null;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  static async open(
    request: (input: string | Request, init?: RequestInit) => Promise<Response>,
    runId: string,
  ): Promise<SseReader> {
    const res = await request(
      new Request(`http://localhost/api/runs/${runId}/events`, {
        signal: new AbortController().signal,
      }),
    );
    if (!res.ok || res.body === null) throw new Error(`stream open failed: ${res.status}`);
    return new SseReader(res.body);
  }

  /** Next data frame (skips `: ping` comments); null once the stream ends. */
  async next(timeoutMs = 30_000): Promise<SseMessage | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.parse();
      if (frame !== null) return frame;
      if (this.done) return null;
      if (Date.now() > deadline) throw new Error("timed out waiting for the next SSE frame");
      if (this.pending === null) this.pending = this.reader.read();
      const chunk = await Promise.race([
        this.pending,
        new Promise<"timeout">((resolve) => {
          const timer = setTimeout(() => resolve("timeout"), 200);
          timer.unref?.();
        }),
      ]);
      if (chunk === "timeout") continue;
      this.pending = null;
      if (chunk.done) {
        this.done = true;
        continue;
      }
      this.buffer += new TextDecoder().decode(chunk.value, { stream: true });
    }
  }

  private parse(): SseMessage | null {
    const boundary = this.buffer.indexOf("\n\n");
    if (boundary === -1) return null;
    const block = this.buffer.slice(0, boundary);
    this.buffer = this.buffer.slice(boundary + 2);
    const frame: Partial<SseMessage> = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) frame.id = line.slice(4);
      else if (line.startsWith("event: ")) frame.event = line.slice(7);
      else if (line.startsWith("data: ")) frame.data = line.slice(6);
    }
    if (frame.data === undefined) return this.parse(); // comment/keepalive
    return frame as SseMessage;
  }
}

interface Harness {
  dir: string;
  db: Db;
  worktrees: WorktreeManager;
  executor: Executor;
  driver: FakeDriver;
  request: (input: string | Request, init?: RequestInit) => Promise<Response>;
  projectId: string;
  runIds: string[];
  enqueue(): string;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

let harness: Harness | null = null;

/**
 * The busybox opencode stub: emits the NDJSON envelope sequence progressively
 * (sleeps between lines) so live streaming is distinguishable from batching.
 */
const STUB_SCRIPT = `#!/bin/sh
printf '%s\\n' '{"type":"step_start","sessionID":"ses-live-e2e","timestamp":1000}'
sleep 0.4
printf '%s\\n' '{"type":"text","timestamp":1000,"part":{"text":"hello "}}'
sleep 0.4
printf '%s\\n' '{"type":"text","timestamp":1001,"part":{"text":"world"}}'
sleep 0.4
printf '%s\\n' '{"type":"step_finish","timestamp":1002,"part":{"cost":0.25}}'
exit 0
`;

const setup = (
  fakeOpts: Parameters<typeof createFakeDriver>[0],
  options: { driverId?: string } = {},
): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-stream-e2e-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  // The opencode stub rides the worktree bind mount into the sandbox.
  writeFileSync(join(repoPath, "opencode"), STUB_SCRIPT);
  chmodSync(join(repoPath, "opencode"), 0o755);
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
  const driver = createFakeDriver(fakeOpts);
  // Registered as "fake" so ad-hoc runs pick it via the executor default;
  // the REAL opencode driver (id "opencode") runs the stub for test 1.
  drivers.registerDriver(driver);
  drivers.registerDriver(createOpenCodeDriver({ id: "opencode", binary: "/workspace/opencode" }));
  const worktrees = new WorktreeManager({ storeRoot: join(dir, "store") });
  const executor = createExecutor({
    db,
    worktrees,
    drivers,
    logger: createLogger("silent"),
    ...(options.driverId === undefined ? {} : { driverId: options.driverId }),
    sandbox: {
      provider: createDockerSandboxProvider(),
      isDockerAvailable: async () => true,
      logPollIntervalMs: 100,
    },
  });
  const { app } = createApp({
    db,
    logger: createLogger("silent"),
    executor,
    eventStream: { pollIntervalMs: 20 },
  });

  const runIds: string[] = [];
  const h: Harness = {
    dir,
    db,
    worktrees,
    executor,
    driver,
    request: (input, init) => app.request(input, init) as Promise<Response>,
    projectId: project.id,
    runIds,
    enqueue() {
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.runs.create({
        id: runId,
        projectId: project.id,
        status: "queued",
        branch: `agentloop/${runId}`,
        iteration: 0,
        task: "make it green",
        createdAt: now,
        updatedAt: now,
      });
      db.stepRuns.create({
        id: crypto.randomUUID(),
        runId,
        stepId: "adhoc",
        iteration: 1,
        status: "queued",
        output: "",
      });
      runIds.push(runId);
      return runId;
    },
  };
  return h;
};

const waitForStatus = async (h: Harness, runId: string, status: RunStatus): Promise<void> => {
  const deadline = Date.now() + 90_000;
  while (h.db.runs.get(runId)?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${status}: currently ${h.db.runs.get(runId)?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const waitForIdle = async (h: Harness): Promise<void> => {
  const deadline = Date.now() + 90_000;
  while (h.executor.activeRunIds().length > 0) {
    if (Date.now() > deadline) throw new Error("executor never went idle");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Container names still alive for one of this suite's run ids. */
const containersFor = async (runId: string): Promise<string[]> => {
  const result = await docker(["ps", "-aq", "--filter", `label=run=${runId}`], {
    timeoutMs: 30_000,
  });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

const cleanup = async (h: Harness): Promise<void> => {
  for (const runId of h.runIds) {
    for (const id of await containersFor(runId)) {
      await docker(["rm", "-f", id], { timeoutMs: 30_000 });
    }
  }
  h.db.close();
  rmSync(h.dir, { recursive: true, force: true });
};

describe.skipIf(!dockerLive)("sandbox live streaming e2e (real daemon, #104)", () => {
  beforeAll(async () => {
    const present = await docker(["image", "inspect", BUSYBOX], { timeoutMs: 30_000 });
    if (present.code !== 0) {
      const pull = await docker(["pull", BUSYBOX], { timeoutMs: 300_000 });
      if (pull.code !== 0) throw new Error(`failed to pull ${BUSYBOX}: ${pull.stderr}`);
    }
  });

  it("streams agent events LIVE over SSE while the sandboxed run is in flight", async () => {
    // Ad-hoc runs resolve their driver from the executor's default; point it
    // at the real opencode driver, whose binary is the busybox stub.
    harness = setup(
      { events: [{ type: "done", seq: 1, output: "unused" }], output: "unused" },
      { driverId: "opencode" },
    );
    const h = harness;
    h.db.projects.setSandboxPolicy(h.projectId, {
      executionMode: "sandbox",
      image: BUSYBOX,
    });
    const runId = h.enqueue();
    // Subscribe BEFORE the run starts: replay is empty, every frame is live.
    const reader = await SseReader.open(h.request, runId);
    h.executor.startRun(runId, {});

    const frames: Array<{ event: string; data: { type: string }; at: number }> = [];
    for (;;) {
      const frame = await reader.next(60_000);
      if (frame === null) break;
      const parsed = JSON.parse(frame.data) as { type: string; status?: string };
      frames.push({ event: frame.event, data: parsed, at: Date.now() });
      if (parsed.type === "run.status" && parsed.status === "success") break;
    }

    const types = frames.map((frame) => frame.data.type);
    expect(types).toEqual([
      "run.status",
      "step.started",
      "started",
      "session",
      "message-delta",
      "message-delta",
      "done",
      "step.completed",
      "run.status",
    ]);

    // LIVE (not batch-at-exit): the session frame precedes the done frame
    // by roughly the stub's remaining runtime (~0.8s of sleeps).
    const sessionAt = frames.find((f) => f.event === "session")?.at;
    const doneAt = frames.find((f) => f.event === "done")?.at;
    expect(sessionAt).toBeDefined();
    expect(doneAt).toBeDefined();
    expect((doneAt as number) - (sessionAt as number)).toBeGreaterThanOrEqual(500);

    // The session id was captured mid-node on the StepRun row.
    const stepRun = h.db.stepRuns.listByRun(runId)[0];
    expect(stepRun?.sessionId).toBe("ses-live-e2e");
    await waitForStatus(h, runId, "success");
    await waitForIdle(h);
    expect(await containersFor(runId)).toEqual([]);
    await cleanup(h);
    harness = null;
  }, 180_000);

  it("tails container stdout into ordered, capped sandbox.log events (+ marker)", async () => {
    harness = setup({
      events: [{ type: "done", seq: 1, output: "done" }],
      output: "done",
      onStart: async (opts) => {
        if (opts.exec === undefined) throw new Error("expected exec seam");
        // 2100 lines onto the CONTAINER's stdout: `docker exec` output never
        // reaches `docker logs`, so the noisy loop writes via /proc/1/fd/1
        // (the idle keeper's stdout, which the json-file driver captures).
        await opts.exec.run([
          "sh",
          "-c",
          "i=1; while [ $i -le 2100 ]; do echo line-$i; i=$((i+1)); done > /proc/1/fd/1",
        ]);
      },
    });
    const h = harness;
    h.db.projects.setSandboxPolicy(h.projectId, {
      executionMode: "sandbox",
      image: BUSYBOX,
    });
    const runId = h.enqueue();

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await waitForIdle(h);

    const events = h.db.events.getSince(runId, 0).filter((event) => event.type === "sandbox.log");
    expect(events).toHaveLength(2000);
    const lines = events.map((event) => (event.type === "sandbox.log" ? event.line : ""));
    // Ordered, and the ring kept the LAST 2000 lines.
    expect(lines[0]).toBe("line-101");
    expect(lines[1999]).toBe("line-2100");
    expect(lines[1000]).toBe("line-1101");
    // Strictly increasing seqs (in-order appends).
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.seq).toBeGreaterThan(events[index - 1]!.seq);
    }
    // One truncation marker with the exact dropped count.
    const markers = h.db.events
      .getSince(runId, 0)
      .filter((event) => event.type === "sandbox.log-truncated");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ dropped: 100, kept: 2000 });

    expect(await containersFor(runId)).toEqual([]);
    await cleanup(h);
    harness = null;
  }, 180_000);

  afterAll(async () => {
    if (harness !== null) {
      await cleanup(harness);
      harness = null;
    }
  });
});
