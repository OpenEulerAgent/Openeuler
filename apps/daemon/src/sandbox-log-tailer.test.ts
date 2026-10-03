import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import type { SandboxLogEvent } from "@openeuler/core";
import type {
  SandboxExecResult,
  SandboxExecStream,
  SandboxHandle,
  SandboxLogEntry,
  SandboxStatus,
} from "@openeuler/sandbox";
import {
  SANDBOX_LOG_EVENT_CAP,
  StreamLogJoiner,
  startSandboxLogTailer,
} from "./sandbox-log-tailer.js";

/**
 * Unit tests for the sandbox log tailer (#104): coalesced ordered
 * `sandbox.log` events, the drop-oldest ring + single truncation marker,
 * boundary dedupe across overlapping polls, redaction, and error tolerance.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Realistic epoch-ms base for scripted `at` stamps (tailers cursor on Date.now()). */
const now = (): number => Date.now();

/** Scriptable handle stub: only `logs` matters; `script` is live (mutable). */
function stubHandle(options: {
  /** Live scripted log entries; polled with `since` filtering (or not). */
  script: SandboxLogEntry[];
  /** When true, `logs` ignores `since` (simulates ms-truncation overlap). */
  ignoreSince?: boolean;
  /** When set, every logs() call rejects once with this error. */
  failNext?: () => boolean;
  /** When provided, records the `since` value of every logs() call. */
  sinceLog?: number[];
}): SandboxHandle {
  return {
    id: "sb-stub",
    meta: { createdAt: Date.now(), image: "img:1", ports: [] },
    status: async () => "running" as SandboxStatus,
    exec: async (cmd: string[]): Promise<SandboxExecResult> => ({
      code: 0,
      stdout: `${cmd.join(" ")}\n`,
      stderr: "",
      durationMs: 0,
    }),
    execStream: (cmd: string[]): SandboxExecStream => {
      void cmd;
      throw new Error("not implemented in stub");
    },
    logs: (opts) => {
      if (options.failNext?.()) {
        options.failNext = () => false;
        return {
          [Symbol.asyncIterator]: (): AsyncIterator<SandboxLogEntry> => ({
            next: () => Promise.reject(new Error("daemon hiccup")),
          }),
        };
      }
      const since = opts?.since;
      if (options.sinceLog !== undefined && since !== undefined) options.sinceLog.push(since);
      const source = options.ignoreSince
        ? options.script
        : options.script.filter(
            (entry) => entry.at === undefined || since === undefined || entry.at >= since,
          );
      return (async function* (): AsyncGenerator<SandboxLogEntry> {
        for (const entry of source) yield entry;
      })();
    },
    hostPorts: async () => ({}),
    stop: async () => undefined,
    destroy: async () => undefined,
  };
}

interface Harness {
  db: Db;
  dir: string;
}

const created: Harness[] = [];

const setup = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-log-tailer-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  // events rows FK to runs, runs FK to projects; create the minimal chain.
  db.projects.create({
    id: "proj-1",
    path: "/tmp/repo",
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  db.runs.create({
    id: "run-1",
    projectId: "proj-1",
    status: "running",
    branch: "agentloop/run-1",
    iteration: 0,
    task: "t",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const h: Harness = { db, dir };
  created.push(h);
  return h;
};

afterEach(() => {
  for (const h of created.splice(0)) {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

const logEvents = (db: Db): SandboxLogEvent[] =>
  db.events
    .getSince("run-1", 0)
    .filter((event): event is SandboxLogEvent => event.type === "sandbox.log");

describe("StreamLogJoiner (boundary dedupe)", () => {
  it("drops an already-seen prefix overlap, including identical repeated lines", () => {
    const joiner = new StreamLogJoiner();
    const tick = (i: number): SandboxLogEntry => ({ stream: "stdout", line: "tick", at: 1000 + i });

    // First poll delivered ticks 0..4.
    expect(joiner.join([tick(0), tick(1), tick(2), tick(3), tick(4)])).toHaveLength(5);

    // Second poll re-delivers ticks 2..4 (overlap) plus new 5..6 → only the
    // new ones survive; identical content means matching is positional.
    const second = [tick(2), tick(3), tick(4), tick(5), tick(6)];
    expect(joiner.join(second)).toEqual([tick(5), tick(6)]);

    // No overlap at all → everything fresh.
    expect(joiner.join([tick(20), tick(21)])).toEqual([tick(20), tick(21)]);
  });

  it("matches on (at, line) keys so same-content different-time lines stay fresh", () => {
    const joiner = new StreamLogJoiner();
    joiner.join([{ stream: "stdout", line: "same", at: 1 }]);
    // A later, identical-content line at a different timestamp is NEW.
    expect(joiner.join([{ stream: "stdout", line: "same", at: 2 }])).toEqual([
      { stream: "stdout", line: "same", at: 2 },
    ]);
  });

  it("falls back to line-only keys when `at` is absent", () => {
    const joiner = new StreamLogJoiner();
    joiner.join([{ stream: "stderr", line: "boom" }]);
    expect(joiner.join([{ stream: "stderr", line: "boom" }])).toEqual([]);
    expect(joiner.join([{ stream: "stderr", line: "new" }])).toEqual([
      { stream: "stderr", line: "new" },
    ]);
  });

  it("bounds its history (an overlap longer than the window is not detected)", () => {
    const joiner = new StreamLogJoiner(3);
    const lines = [1, 2, 3, 4, 5].map((i) => ({ stream: "stdout" as const, line: `l${i}`, at: i }));
    joiner.join(lines);
    // Full re-delivery exceeds the 3-key window: the joiner cannot prove
    // the overlap and (conservatively) re-emits — acceptable, documented.
    expect(joiner.join(lines)).toHaveLength(lines.length);
  });
});

describe("startSandboxLogTailer", () => {
  it("appends ordered coalesced sandbox.log events and stops cleanly", async () => {
    const h = setup();
    const script: SandboxLogEntry[] = [
      { stream: "stdout", line: "one", at: now() + 100 },
      { stream: "stderr", line: "two", at: now() + 101 },
      { stream: "stdout", line: "three", at: now() + 102 },
    ];
    const tailer = startSandboxLogTailer({
      db: h.db,
      handle: stubHandle({ script }),
      runId: "run-1",
      sandboxId: "sb-stub",
      redact: (text) => text,
      pollIntervalMs: 10,
    });
    await sleep(80);
    await tailer.stop();

    const events = logEvents(h.db);
    expect(events.map((event) => [event.stream, event.line])).toEqual([
      ["stdout", "one"],
      ["stderr", "two"],
      ["stdout", "three"],
    ]);
    expect(events.every((event) => event.sandboxId === "sb-stub")).toBe(true);
    // No evictions → no marker.
    expect(
      h.db.events.getSince("run-1", 0).some((event) => event.type === "sandbox.log-truncated"),
    ).toBe(false);
    // stop() is idempotent.
    await tailer.stop();
    expect(logEvents(h.db)).toHaveLength(3);
  });

  it("enforces the ring cap (drop-oldest) and emits ONE truncation marker at stop", async () => {
    const h = setup();
    const script: SandboxLogEntry[] = Array.from({ length: 15 }, (_, index) => ({
      stream: "stdout" as const,
      line: `line-${index + 1}`,
      at: now() + 2000 + index,
    }));
    const tailer = startSandboxLogTailer({
      db: h.db,
      handle: stubHandle({ script }),
      runId: "run-1",
      sandboxId: "sb-stub",
      redact: (text) => text,
      pollIntervalMs: 10,
      cap: 10,
    });
    await sleep(80);
    await tailer.stop();

    const events = logEvents(h.db);
    expect(events).toHaveLength(10);
    // The LAST 10 survive, in order.
    expect(events.map((event) => event.line)).toEqual(
      Array.from({ length: 10 }, (_, index) => `line-${index + 6}`),
    );
    const marker = h.db.events
      .getSince("run-1", 0)
      .find((event) => event.type === "sandbox.log-truncated");
    expect(marker).toMatchObject({ type: "sandbox.log-truncated", dropped: 5, kept: 10 });
    expect(
      events.every((event, index, all) => index === 0 || all[index - 1]!.seq < event.seq),
    ).toBe(true);
  });

  it("enforces the cap across separate polls (streamed bursts)", async () => {
    const h = setup();
    const script: SandboxLogEntry[] = [];
    const tailer = startSandboxLogTailer({
      db: h.db,
      handle: stubHandle({ script }),
      runId: "run-1",
      sandboxId: "sb-stub",
      redact: (text) => text,
      pollIntervalMs: 10,
      cap: 10,
    });
    for (let batch = 0; batch < 3; batch += 1) {
      script.push(
        ...Array.from({ length: 6 }, (_, index) => ({
          stream: "stdout" as const,
          line: `b${batch}-${index}`,
          at: now() + 3000 + batch * 10 + index,
        })),
      );
      await sleep(40);
    }
    await tailer.stop();

    const events = logEvents(h.db);
    expect(events).toHaveLength(10);
    expect(events[0]?.line).toBe("b1-2"); // 18 appended, ring keeps the last 10
    expect(events[9]?.line).toBe("b2-5");
    const marker = h.db.events
      .getSince("run-1", 0)
      .find((event) => event.type === "sandbox.log-truncated");
    expect(marker).toMatchObject({ dropped: 8, kept: 10 });
  });

  it("dedupes re-delivered overlap when the provider re-sends around the cursor", async () => {
    const h = setup();
    const script: SandboxLogEntry[] = [
      { stream: "stdout", line: "a", at: now() + 4000 },
      { stream: "stdout", line: "b", at: now() + 4001 },
      { stream: "stdout", line: "c", at: now() + 4002 },
    ];
    const tailer = startSandboxLogTailer({
      db: h.db,
      handle: stubHandle({ script, ignoreSince: true }), // every poll re-sends all
      runId: "run-1",
      sandboxId: "sb-stub",
      redact: (text) => text,
      pollIntervalMs: 10,
    });
    await sleep(100);
    await tailer.stop();
    // Each line appears exactly once despite full re-delivery per poll.
    expect(logEvents(h.db).map((event) => event.line)).toEqual(["a", "b", "c"]);
  });

  it("redacts lines through the supplied transform before persisting", async () => {
    const h = setup();
    const script: SandboxLogEntry[] = [
      { stream: "stdout", line: "token=hunter2 leaked", at: now() + 5000 },
    ];
    const tailer = startSandboxLogTailer({
      db: h.db,
      handle: stubHandle({ script }),
      runId: "run-1",
      sandboxId: "sb-stub",
      redact: (text) => text.replaceAll("hunter2", "***"),
      pollIntervalMs: 10,
    });
    await sleep(60);
    await tailer.stop();
    expect(logEvents(h.db)[0]?.line).toBe("token=*** leaked");
  });

  it("survives poll failures and keeps tailing", async () => {
    const h = setup();
    const script: SandboxLogEntry[] = [
      { stream: "stdout", line: "after-hiccup", at: now() + 6000 },
    ];
    let fail = true;
    const tailer = startSandboxLogTailer({
      db: h.db,
      handle: stubHandle({ script, failNext: () => fail }),
      runId: "run-1",
      sandboxId: "sb-stub",
      redact: (text) => text,
      pollIntervalMs: 10,
      onWarn: () => undefined,
    });
    await sleep(80);
    fail = false;
    await sleep(60);
    await tailer.stop();
    expect(logEvents(h.db).map((event) => event.line)).toEqual(["after-hiccup"]);
  });

  it("default cap is 2000 (a scripted 2100-line burst keeps the last 2000 + marker)", async () => {
    const h = setup();
    expect(SANDBOX_LOG_EVENT_CAP).toBe(2000);
    const script: SandboxLogEntry[] = Array.from({ length: 2100 }, (_, index) => ({
      stream: "stdout" as const,
      line: `line-${index + 1}`,
      at: now() + 7000 + index,
    }));
    const tailer = startSandboxLogTailer({
      db: h.db,
      handle: stubHandle({ script }),
      runId: "run-1",
      sandboxId: "sb-stub",
      redact: (text) => text,
      pollIntervalMs: 10,
    });
    // Generous window + explicit timeout: the 2100-line burst drains
    // across polls (2100 sqlite inserts) and under parallel-worker load the
    // poll cadence slips well past vitest's 5s default per-test timeout.
    await sleep(300);
    await tailer.stop();

    const events = logEvents(h.db);
    expect(events).toHaveLength(2000);
    expect(events[0]?.line).toBe("line-101");
    expect(events[1999]?.line).toBe("line-2100");
    const marker = h.db.events
      .getSince("run-1", 0)
      .find((event) => event.type === "sandbox.log-truncated");
    expect(marker).toMatchObject({ dropped: 100, kept: 2000 });
  }, 30_000);

  it("advances the cursor to the newest line: a quiet stream cannot pin it (#149)", async () => {
    const h = setup();
    const base = now() + 8000;
    // stdout-heavy stream plus a single EARLY stderr line: with a
    // min-across-streams cursor the early stderr line would pin `since`
    // and every later poll would re-fetch the whole stdout tail.
    const script: SandboxLogEntry[] = [
      ...Array.from({ length: 50 }, (_, index) => ({
        stream: "stdout" as const,
        line: `out-${index}`,
        at: base + index,
      })),
      { stream: "stderr" as const, line: "early-err", at: base + 1 },
    ];
    const sinceLog: number[] = [];
    const tailer = startSandboxLogTailer({
      db: h.db,
      handle: stubHandle({ script, sinceLog: sinceLog }),
      runId: "run-1",
      sandboxId: "sb-stub",
      redact: (text) => text,
      pollIntervalMs: 10,
    });
    await sleep(150);
    await tailer.stop();

    // Every line persisted exactly once — no duplicate appends.
    const lines = logEvents(h.db).map((event) => event.line);
    expect(lines).toHaveLength(51);
    expect(lines.filter((line) => line === "out-42")).toHaveLength(1);

    // After the first poll consumed the batch, subsequent polls fetched
    // with an ADVANCING cursor: since reached the batch max (base + 49),
    // not the early stderr line's timestamp (base + 1).
    expect(sinceLog.length).toBeGreaterThan(1);
    expect(Math.max(...sinceLog)).toBeGreaterThanOrEqual(base + 49);
    // And no poll after the first re-fetched the early window: once the
    // cursor advanced past base + 1, every later `since` is beyond it.
    const later = sinceLog.slice(1);
    expect(later.every((since) => since >= base + 49)).toBe(true);
  });

  it("drops provider truncation markers — they never reach run history (#149)", async () => {
    const h = setup();
    const script: SandboxLogEntry[] = [
      { stream: "stdout", line: "real output", at: now() + 9000 },
      // Byte-cap notices emitted by the docker provider mid-snapshot.
      { stream: "stdout", line: "[openeuler] stdout log snapshot truncated at 8388608 bytes" },
      { stream: "stderr", line: "[openeuler] stderr log snapshot truncated at 8388608 bytes" },
      { stream: "stderr", line: "real error", at: now() + 9001 },
    ];
    const tailer = startSandboxLogTailer({
      db: h.db,
      handle: stubHandle({ script }),
      runId: "run-1",
      sandboxId: "sb-stub",
      redact: (text) => text,
      pollIntervalMs: 10,
    });
    await sleep(80);
    await tailer.stop();

    const lines = logEvents(h.db).map((event) => event.line);
    expect(lines).toEqual(["real output", "real error"]);
    // Markers carry no `at`, so every poll re-delivers them — they must
    // stay filtered (never appended) across polls too.
    expect(lines.some((line) => line.includes("truncated"))).toBe(false);
  });
});
