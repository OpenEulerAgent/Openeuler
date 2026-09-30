import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Run } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import type { FakeDriverOptions } from "@openeuler/drivers";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import type { EventStreamOptions } from "./runs.js";
import { createExecutor } from "../executor.js";
import { createLogger } from "../logger.js";

interface ApiHarness {
  dir: string;
  db: Db;
  storeRoot: string;
  request: (input: string | Request, init?: RequestInit) => Promise<Response>;
  projectId: string;
  /** Every AbortController handed to an SSE request; torn down in afterEach. */
  controllers: Set<AbortController>;
}

interface ErrorResponseBody {
  error: { code: string; message: string };
}

/** One parsed SSE frame; `data` is the raw JSON string. */
interface SseMessage {
  id: string;
  event: string;
  data: string;
}

/** Fake script; the driver prepends `started`, so persisted seqs are 1..6. */
const script: AgentEvent[] = [
  { type: "session", seq: 1, sessionId: "s_tail" },
  { type: "message-delta", seq: 2, delta: "working " },
  { type: "tool-call", seq: 3, tool: "edit", input: { path: "feature.txt" } },
  { type: "tool-output", seq: 4, output: "edited feature.txt" },
  { type: "done", seq: 5, output: "all done" },
];

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "failed",
  "aborted",
  "interrupted",
]);

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const created: { db: Db; dir: string; controllers: Set<AbortController> }[] = [];

const setup = (
  fakeOpts: FakeDriverOptions = {},
  eventStream: EventStreamOptions = {},
): ApiHarness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-run-events-"));
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
  const { app } = createApp({
    db,
    logger: createLogger("silent"),
    executor,
    eventStream: { pollIntervalMs: 20, ...eventStream },
  });

  const controllers = new Set<AbortController>();
  created.push({ db, dir, controllers });
  return {
    dir,
    db,
    storeRoot: join(dir, "store"),
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

const postRun = (h: ApiHarness, prompt: string): Promise<Response> =>
  h.request("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: h.projectId, prompt }),
  });

/** Race-guarded wait: throws (never hangs) when the timeout elapses. */
const waitFor = (what: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 5);
    };
    tick();
  });
};

const runStatus = async (h: ApiHarness, runId: string): Promise<Run> => {
  const res = await h.request(`/api/runs/${runId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { run: Run }).run;
};

const awaitTerminal = async (h: ApiHarness, runId: string): Promise<Run> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = await runStatus(h, runId);
    if (TERMINAL_STATUSES.has(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} never reached a terminal status`);
    await sleep(10);
  }
};

interface OpenStreamOptions {
  lastEventId?: string;
  afterSeq?: string;
  controller?: AbortController;
}

/** Opens an SSE request; the harness tracks the controller for teardown. */
const openStream = async (
  h: ApiHarness,
  runId: string,
  opts: OpenStreamOptions = {},
): Promise<Response> => {
  const controller = opts.controller ?? new AbortController();
  h.controllers.add(controller);
  const query = opts.afterSeq === undefined ? "" : `?afterSeq=${opts.afterSeq}`;
  const path = `/api/runs/${runId}/events${query}`;
  const headers: Record<string, string> =
    opts.lastEventId === undefined ? {} : { "Last-Event-ID": opts.lastEventId };
  return h.request(new Request(`http://localhost${path}`, { headers, signal: controller.signal }));
};

/**
 * Incremental SSE reader with per-read race guards. `: ping` comment
 * heartbeats are counted separately from data frames.
 */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private returned = 0;
  readonly messages: SseMessage[] = [];
  readonly pings: string[] = [];
  done = false;

  constructor(res: Response) {
    if (res.body === null) throw new Error("SSE response has no body");
    this.reader = res.body.getReader();
  }

  private consumeBuffer(flush: boolean): void {
    const parts = this.buffer.split("\n\n");
    this.buffer = flush ? "" : (parts.pop() ?? "");
    for (const part of parts) {
      if (part === "") continue;
      if (part.startsWith(":")) {
        this.pings.push(part);
        continue;
      }
      const frame: Partial<SseMessage> = {};
      for (const line of part.split("\n")) {
        if (line.startsWith("id: ")) frame.id = line.slice(4);
        else if (line.startsWith("event: ")) frame.event = line.slice(7);
        else if (line.startsWith("data: ")) frame.data = line.slice(6);
      }
      if (frame.id === undefined || frame.event === undefined || frame.data === undefined) {
        throw new Error(`malformed SSE frame: ${JSON.stringify(part)}`);
      }
      this.messages.push(frame as SseMessage);
    }
  }

  /** Next data frame, or null once the stream closed. Throws on timeout. */
  async next(timeoutMs = 5_000): Promise<SseMessage | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.messages.length > this.returned) return this.messages[this.returned++] ?? null;
      if (this.done) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for the next SSE frame");
      const chunk = await Promise.race([
        this.reader.read(),
        sleep(remaining).then((): never => {
          throw new Error("timed out waiting for the next SSE frame");
        }),
      ]);
      if (chunk.done) {
        this.done = true;
        this.consumeBuffer(true);
        continue;
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      this.consumeBuffer(false);
    }
  }

  /** Reads until the stream closes (terminal event); throws on timeout. */
  async untilClose(timeoutMs = 5_000): Promise<SseMessage[]> {
    for (;;) {
      const message = await this.next(timeoutMs);
      if (message === null) return this.messages;
    }
  }
}

const openReader = async (
  h: ApiHarness,
  runId: string,
  opts: OpenStreamOptions = {},
): Promise<SseReader> => {
  const res = await openStream(h, runId, opts);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  return new SseReader(res);
};

const manyDeltas = (count: number): AgentEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    type: "message-delta" as const,
    seq: i + 1,
    delta: `chunk ${i + 1} `,
  }));

describe("GET /api/runs/:id/events (SSE)", () => {
  it("replays persisted events in order, tails live, then closes on the persisted run.status", async () => {
    const h = setup({ events: script, delayMs: 40, output: "all done" });
    const res = await postRun(h, "stream me");
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as { run: Run };

    // Subscribe mid-run, after 2 events are persisted.
    await waitFor("2 persisted events", () => h.db.events.count(run.id) >= 2);

    const reader = await openReader(h, run.id);
    const messages = await reader.untilClose();

    expect(messages.map((m) => Number(m.id))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(messages.map((m) => m.event)).toEqual([
      "run.status",
      "step.started",
      "started",
      "session",
      "message-delta",
      "tool-call",
      "tool-output",
      "done",
      "step.completed",
      "run.status",
    ]);
    expect(messages[0]?.data).toBe(
      JSON.stringify({ type: "run.status", seq: 1, status: "running" }),
    );
    expect(messages[7]?.data).toBe(JSON.stringify({ type: "done", seq: 8, output: "all done" }));
    expect(messages[8]?.data).toBe(
      JSON.stringify({
        type: "step.completed",
        seq: 9,
        stepId: "adhoc",
        stepName: "ad-hoc",
        iteration: 1,
        status: "success",
      }),
    );
    // Terminal close comes from the PERSISTED engine event (seq 10), not a
    // synthetic one: exactly one terminal run.status, and nothing after it.
    expect(messages[9]?.data).toBe(
      JSON.stringify({ type: "run.status", seq: 10, status: "success" }),
    );
    expect(
      messages.filter((m) => m.event === "run.status" && JSON.parse(m.data).status !== "running"),
    ).toHaveLength(1);
    expect(h.db.events.count(run.id)).toBe(10);
    expect(h.db.events.lastRunStatus(run.id)?.seq).toBe(10);
  }, 10_000);

  it("resumes from Last-Event-ID without replaying the prefix", async () => {
    const h = setup({ events: script, delayMs: 40 });
    const res = await postRun(h, "reconnect me");
    const { run } = (await res.json()) as { run: Run };

    await waitFor("3 persisted events", () => h.db.events.count(run.id) >= 3);
    const reader = await openReader(h, run.id, { lastEventId: "2" });

    const first = await reader.next();
    expect(first?.id).toBe("3");
    expect(first?.event).toBe("started");

    const rest = await reader.untilClose();
    expect(rest.map((m) => Number(m.id))).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rest[7]?.event).toBe("run.status");
    expect(JSON.parse(rest[7]?.data ?? "{}")).toMatchObject({ status: "success", seq: 10 });
  }, 10_000);

  it("accepts ?afterSeq= as a cursor alias", async () => {
    const h = setup({ events: script, delayMs: 40 });
    const res = await postRun(h, "query cursor");
    const { run } = (await res.json()) as { run: Run };

    await waitFor("3 persisted events", () => h.db.events.count(run.id) >= 3);
    const reader = await openReader(h, run.id, { afterSeq: "2" });

    const first = await reader.next();
    expect(first?.id).toBe("3");
    const rest = await reader.untilClose();
    expect(rest.every((m) => Number(m.id) > 2)).toBe(true);
  }, 10_000);

  it("replays everything and closes immediately for an already-terminal run", async () => {
    const h = setup({ events: [{ type: "done", seq: 1, output: "quick" }], output: "quick" });
    const res = await postRun(h, "fast one");
    const { run } = (await res.json()) as { run: Run };
    expect((await awaitTerminal(h, run.id)).status).toBe("success");

    const reader = await openReader(h, run.id);
    const messages = await reader.untilClose(2_000);
    expect(messages.map((m) => m.event)).toEqual([
      "run.status",
      "step.started",
      "started",
      "done",
      "step.completed",
      "run.status",
    ]);
    expect(messages[5]?.data).toBe(
      JSON.stringify({ type: "run.status", seq: 6, status: "success" }),
    );
  });

  it("falls back to a synthetic close only for runs without a persisted terminal run.status", async () => {
    const h = setup({ events: script });
    const res = await postRun(h, "legacy style");
    const { run } = (await res.json()) as { run: Run };

    // Simulate a legacy row: driver events only, terminal run row, no engine
    // events (as written before the engine persisted its lifecycle events).
    await awaitTerminal(h, run.id);
    h.db.sqlite
      .prepare(
        "delete from events where run_id = ? and type in ('run.status','step.started','step.completed')",
      )
      .run(run.id);

    const reader = await openReader(h, run.id);
    const messages = await reader.untilClose(2_000);
    const last = messages[messages.length - 1];
    expect(last?.event).toBe("run.status");
    expect(JSON.parse(last?.data ?? "{}")).toMatchObject({
      type: "run.status",
      status: "success",
      seq: Number(last?.id), // lastSeq + 1
    });
  });

  it("rejects an invalid cursor with 422", async () => {
    const h = setup({ events: script, delayMs: 60 });
    const res = await postRun(h, "bad cursor");
    const { run } = (await res.json()) as { run: Run };
    await waitFor("running", () => h.db.runs.get(run.id)?.status === "running");

    const cases: Array<{ path: string; headers: Record<string, string> }> = [
      { path: `/api/runs/${run.id}/events?afterSeq=abc`, headers: {} },
      { path: `/api/runs/${run.id}/events`, headers: { "Last-Event-ID": "-1" } },
    ];
    for (const { path, headers } of cases) {
      const controller = new AbortController();
      h.controllers.add(controller);
      const bad = await h.request(
        new Request(`http://localhost${path}`, { headers, signal: controller.signal }),
      );
      expect(bad.status).toBe(422);
      expect(((await bad.json()) as ErrorResponseBody).error.code).toBe("INVALID_CURSOR");
      controller.abort();
    }
    await awaitTerminal(h, run.id);
  });

  it("404s for an unknown run before streaming", async () => {
    const h = setup({ events: script });
    const res = await openStream(h, crypto.randomUUID());
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("RUN_NOT_FOUND");
  });

  it("stops polling after client disconnect and leaves the run unaffected", async () => {
    const h = setup({ events: manyDeltas(12), delayMs: 60 });
    const getSinceSpy = vi.spyOn(h.db.events, "getSince");

    const res = await postRun(h, "long run");
    const { run } = (await res.json()) as { run: Run };

    await waitFor("2 persisted events", () => h.db.events.count(run.id) >= 2);
    const controller = new AbortController();
    const reader = await openReader(h, run.id, { controller });
    expect((await reader.next())?.id).toBe("1");

    // Disconnect the client mid-stream.
    controller.abort();

    // The poll loop notices within one poll interval (20ms); no further polls.
    await sleep(150);
    const callsAfterAbort = getSinceSpy.mock.calls.length;
    await sleep(200);
    expect(getSinceSpy.mock.calls.length).toBe(callsAfterAbort);

    // Run unaffected: still completes on its own.
    const final = await awaitTerminal(h, run.id);
    expect(final.status).toBe("success");
    // 12 deltas + started driver events, plus 4 engine events.
    expect(h.db.events.getSince(run.id)).toHaveLength(17);
  }, 10_000);

  it("caps concurrent streams per run: 6th gets 429, freed slot allows a new one", async () => {
    const h = setup({ events: manyDeltas(12), delayMs: 60 });
    const res = await postRun(h, "many watchers");
    const { run } = (await res.json()) as { run: Run };
    await waitFor("1 persisted event", () => h.db.events.count(run.id) >= 1);

    const controllers: AbortController[] = [];
    for (let i = 0; i < 5; i += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      const reader = await openReader(h, run.id, { controller });
      expect(await reader.next()).not.toBeNull();
    }

    const sixth = await openStream(h, run.id);
    expect(sixth.status).toBe(429);
    expect(((await sixth.json()) as ErrorResponseBody).error.code).toBe("TOO_MANY_STREAMS");

    // Free one slot by disconnecting one watcher.
    controllers[0]?.abort();
    await sleep(150);
    const seventh = await openStream(h, run.id);
    expect(seventh.status).toBe(200);
    expect(seventh.headers.get("content-type")).toContain("text/event-stream");

    // Teardown: drop every stream, let the run finish.
    for (const controller of controllers) controller.abort();
    h.controllers.forEach((c) => c.abort());
    expect((await awaitTerminal(h, run.id)).status).toBe("success");
  }, 10_000);

  it("sends : ping heartbeats while the stream is quiet", async () => {
    const h = setup(
      { events: script, delayMs: 10, onStart: () => sleep(250) },
      { pollIntervalMs: 10, heartbeatMs: 50 },
    );
    const res = await postRun(h, "quiet start");
    const { run } = (await res.json()) as { run: Run };

    await waitFor(
      "engine events persisted, driver still silent",
      () => h.db.runs.get(run.id)?.status === "running" && h.db.events.count(run.id) === 2,
    );
    const reader = await openReader(h, run.id);

    // The driver stalls 250ms before its first event; engine frames arrive
    // immediately, then heartbeats fill the gap before the driver frames.
    const first = await reader.next(3_000);
    expect(first?.id).toBe("1");
    for (;;) {
      const next = await reader.next(3_000);
      if (next === null) throw new Error("stream closed before driver events arrived");
      if (Number(next.id) >= 3) break;
    }
    expect(reader.pings.length).toBeGreaterThanOrEqual(1);
    expect(reader.pings.every((ping) => ping.startsWith(": ping"))).toBe(true);

    h.controllers.forEach((c) => c.abort());
    expect((await awaitTerminal(h, run.id)).status).toBe("success");
  }, 10_000);

  it("429s only per run: another run's stream is unaffected", async () => {
    const h = setup({ events: manyDeltas(6), delayMs: 80 });
    const first = ((await (await postRun(h, "run one")).json()) as { run: Run }).run;
    const second = ((await (await postRun(h, "run two")).json()) as { run: Run }).run;

    await waitFor("run one streaming", () => h.db.events.count(first.id) >= 1);

    // Saturate run one's cap.
    const controllers: AbortController[] = [];
    for (let i = 0; i < 5; i += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      const reader = await openReader(h, first.id, { controller });
      expect(await reader.next()).not.toBeNull();
    }
    expect((await openStream(h, first.id)).status).toBe(429);

    // A different run still accepts a stream.
    const reader = await openReader(h, second.id);
    expect(await reader.next()).not.toBeNull();

    for (const controller of controllers) controller.abort();
    h.controllers.forEach((c) => c.abort());
    expect((await awaitTerminal(h, first.id)).status).toBe("success");
    expect((await awaitTerminal(h, second.id)).status).toBe("success");
  }, 10_000);
});
