import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "@openeuler/core";
import { DriverError } from "./error.js";
import {
  buildOpencodeArgs,
  checkOpenCodeInstalled,
  createOpencodeParserState,
  createOpenCodeDriver,
  OpenCodeDriverError,
  parseOpencodeLine,
} from "./opencode.js";
import type { AgentStartOpts } from "./types.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(srcDir, "fixtures");

function readFixture(name: string): string[] {
  return readFileSync(join(fixturesDir, name), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function parseFixture(name: string): { events: AgentEvent[]; skipped: string[] } {
  const state = createOpencodeParserState();
  const events: AgentEvent[] = [];
  const skipped: string[] = [];
  for (const line of readFixture(name)) {
    const result = parseOpencodeLine(line, state);
    events.push(...result.events);
    if (result.skipped) skipped.push(result.skipped);
  }
  return { events, skipped };
}

describe("buildOpencodeArgs", () => {
  const opts: AgentStartOpts = { cwd: "/tmp/project", prompt: "fix the bug", mode: "auto" };

  it("maps base opts to a non-interactive json run", () => {
    expect(buildOpencodeArgs(opts)).toEqual([
      "run",
      "fix the bug",
      "--format",
      "json",
      "--dir",
      "/tmp/project",
      "--auto",
    ]);
  });

  it("omits --auto for ask mode (non-interactive v1)", () => {
    expect(buildOpencodeArgs({ ...opts, mode: "ask" })).not.toContain("--auto");
  });

  it("appends model, agent and session only when set", () => {
    expect(
      buildOpencodeArgs({
        ...opts,
        model: "anthropic/claude-sonnet-4",
        agent: "build",
        sessionId: "ses_123",
      }),
    ).toEqual([
      "run",
      "fix the bug",
      "--format",
      "json",
      "--dir",
      "/tmp/project",
      "--auto",
      "-m",
      "anthropic/claude-sonnet-4",
      "--agent",
      "build",
      "--session",
      "ses_123",
    ]);
    expect(buildOpencodeArgs(opts)).not.toContain("-m");
    expect(buildOpencodeArgs(opts)).not.toContain("--agent");
    expect(buildOpencodeArgs(opts)).not.toContain("--session");
  });

  it("resolves a relative cwd to an absolute --dir", () => {
    const args = buildOpencodeArgs({ cwd: "relative/dir", prompt: "p", mode: "ask" });
    expect(args[args.length - 1]).toBe(resolve("relative/dir"));
  });
});

describe("parseOpencodeLine (fixtures)", () => {
  it("normal run: session, message-delta, monotonic seq", () => {
    const { events, skipped } = parseFixture("opencode-normal.jsonl");
    expect(skipped).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["session", "message-delta"]);
    const session = events[0];
    expect(session?.type === "session" && session.sessionId).toMatch(/^ses_/);
    const delta = events[1];
    expect(delta?.type === "message-delta" && delta.delta).toContain(
      "From source we pluck the tokens",
    );
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("tool run: tool-call + tool-output with input/output", () => {
    const { events, skipped } = parseFixture("opencode-tool-calls.jsonl");
    expect(skipped).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([
      "session",
      "tool-call",
      "tool-output",
      "message-delta",
    ]);
    const toolCall = events[1];
    if (toolCall?.type !== "tool-call") throw new Error("expected tool-call");
    expect(toolCall.tool).toBe("read");
    expect(toolCall.input).toMatchObject({ filePath: expect.stringContaining("note.txt") });
    const toolOutput = events[2];
    if (toolOutput?.type !== "tool-output") throw new Error("expected tool-output");
    expect(toolOutput.output).toContain("1: hello");
    const delta = events[3];
    expect(delta?.type === "message-delta" && delta.delta).toBe("hello");
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });

  it("error run: maps the error envelope", () => {
    const { events } = parseFixture("opencode-error.jsonl");
    expect(events.map((event) => event.type)).toEqual(["session", "error"]);
    const error = events[1];
    if (error?.type !== "error") throw new Error("expected error");
    expect(error.message).toContain("Unexpected server error");
    expect(error.code).toBe("UnknownError");
  });

  it("tolerates malformed, unknown and unmapped lines without throwing", () => {
    const { events, skipped } = parseFixture("opencode-tolerance.jsonl");
    expect(skipped).toEqual(["malformed", "unmapped-type", "unknown-type"]);
    expect(events.map((event) => event.type)).toEqual([
      "session",
      "tool-call",
      "tool-output",
      "tool-call",
      "tool-output",
      "message-delta",
    ]);
    const firstToolCall = events[1];
    if (firstToolCall?.type !== "tool-call") throw new Error("expected tool-call");
    expect(firstToolCall.tool).toBe("bash");
    expect(firstToolCall.input).toEqual({ command: "sleep 1" });
    const completedOutput = events[2];
    expect(completedOutput?.type === "tool-output" && completedOutput.output).toBe("done in 1s");
    const erroredOutput = events[4];
    expect(erroredOutput?.type === "tool-output" && erroredOutput.output).toContain("ENOENT");
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("accumulates cost and duration in state", () => {
    const state = createOpencodeParserState();
    for (const line of readFixture("opencode-tolerance.jsonl")) parseOpencodeLine(line, state);
    expect(state.cost).toBe(0.00125);
    expect(state.lastTimestamp! - state.firstTimestamp!).toBe(344);
    expect(state.sessionId).toBe("ses_synth_tolerance");
    expect(state.outputSoFar).toContain("all done");
  });

  it("emits the session event only once", () => {
    const state = createOpencodeParserState();
    const line = JSON.stringify({
      type: "step_start",
      timestamp: 1,
      sessionID: "ses_once",
      part: { type: "step-start" },
    });
    parseOpencodeLine(line, state);
    const second = parseOpencodeLine(line, state);
    expect(second.events).toEqual([]);
  });

  it("never throws on junk input", () => {
    const state = createOpencodeParserState();
    for (const junk of ["", "   ", "{", "[1,2]", '"string"', "42", "{}", '{"type":123}']) {
      expect(() => parseOpencodeLine(junk, state)).not.toThrow();
    }
  });
});

const STUB_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (process.env.STUB_ARGS_FILE) fs.writeFileSync(process.env.STUB_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.STUB_PIDS_FILE) {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  fs.writeFileSync(process.env.STUB_PIDS_FILE, JSON.stringify({ pid: process.pid, childPid: child.pid }));
}
if (process.env.STUB_FIXTURE) {
  const text = fs.readFileSync(process.env.STUB_FIXTURE, "utf8");
  process.stdout.write(text.endsWith("\\n") ? text : text + "\\n");
}
if (process.env.STUB_STDERR) process.stderr.write(process.env.STUB_STDERR);
if (process.env.STUB_HANG === "1") setInterval(() => {}, 1000);
process.exitCode = Number(process.env.STUB_EXIT ?? 0);
`;

const workRoot = mkdtempSync(join(tmpdir(), "opencode-driver-test-"));
const stubBin = join(workRoot, "stubbin");
const emptyBin = join(workRoot, "emptybin");
const runDirs: string[] = [];
const strayPids: number[] = [];

mkdirSync(stubBin, { recursive: true });
mkdirSync(emptyBin, { recursive: true });
const stubPath = join(stubBin, "opencode");
writeFileSync(stubPath, STUB_SCRIPT);
chmodSync(stubPath, 0o755);

function stubEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    ...extra,
  };
}

function newRunDir(): string {
  const dir = mkdtempSync(join(workRoot, "run-"));
  runDirs.push(dir);
  return dir;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

async function collectEvents(handle: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

afterAll(() => {
  for (const pid of strayPids) {
    if (pidAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }
  rmSync(workRoot, { recursive: true, force: true });
});

describe("OpenCodeDriver with stub binary", () => {
  it("streams a normal run end to end", async () => {
    const driver = createOpenCodeDriver();
    const cwd = newRunDir();
    const handle = driver.start({
      cwd,
      prompt: "read note.txt",
      mode: "auto",
      env: stubEnv({ STUB_FIXTURE: join(fixturesDir, "opencode-normal.jsonl") }),
    });
    expect(handle.pid).toBeTypeOf("number");
    const events = await collectEvents(handle);
    const exit = await handle.exited;

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "session",
      "message-delta",
      "done",
    ]);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
    const done = events[3];
    if (done?.type !== "done") throw new Error("expected done");
    expect(done.output).toContain("From source we pluck the tokens");
    expect(exit).toEqual({ code: 0, reason: "exit", output: done.output });
    const usage = await handle.usage;
    expect(usage?.cost).toBe(0);
    expect(usage?.durationMs).toBeGreaterThan(0);
  }, 20_000);

  it("maps all start opts onto the spawned argv", async () => {
    const cwd = newRunDir();
    const argsFile = join(cwd, "args.json");
    const driver = createOpenCodeDriver();
    const handle = driver.start({
      cwd,
      prompt: "do the thing",
      mode: "auto",
      model: "zai/glm-4.6",
      agent: "build",
      sessionId: "ses_continue",
      env: stubEnv({ STUB_ARGS_FILE: argsFile }),
    });
    const exit = await handle.exited;
    expect(exit.reason).toBe("exit");
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual([
      "run",
      "do the thing",
      "--format",
      "json",
      "--dir",
      cwd,
      "--auto",
      "-m",
      "zai/glm-4.6",
      "--agent",
      "build",
      "--session",
      "ses_continue",
    ]);
  }, 20_000);

  it("reports a nonzero exit with stderr tail as an error", async () => {
    const driver = createOpenCodeDriver();
    const cwd = newRunDir();
    const handle = driver.start({
      cwd,
      prompt: "boom",
      mode: "auto",
      env: stubEnv({
        STUB_FIXTURE: join(fixturesDir, "opencode-normal.jsonl"),
        STUB_EXIT: "3",
        STUB_STDERR: "Error: connection refused while talking to the model gateway",
      }),
    });
    const events = await collectEvents(handle);
    const exit = await handle.exited;

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "session",
      "message-delta",
      "error",
    ]);
    const error = events[3];
    if (error?.type !== "error") throw new Error("expected error event");
    expect(error.message).toContain("exited with code 3");
    expect(error.message).toContain("connection refused");
    expect(handle.lastStderr).toContain("connection refused");
    expect(exit).toMatchObject({ code: 3, reason: "error" });
    expect(exit.output).toContain("[stderr]");
    expect(exit.output).toContain("connection refused");
  }, 20_000);

  it("surfaces an opencode error envelope without a done event", async () => {
    const driver = createOpenCodeDriver();
    const handle = driver.start({
      cwd: newRunDir(),
      prompt: "bad model",
      mode: "auto",
      env: stubEnv({
        STUB_FIXTURE: join(fixturesDir, "opencode-error.jsonl"),
        STUB_EXIT: "1",
      }),
    });
    const events = await collectEvents(handle);
    const exit = await handle.exited;
    expect(events.map((event) => event.type)).toEqual(["started", "session", "error"]);
    const error = events[2];
    if (error?.type !== "error") throw new Error("expected error event");
    expect(error.code).toBe("UnknownError");
    expect(exit).toMatchObject({ code: 1, reason: "error" });
  }, 20_000);

  it("kills the whole process group on abort", async () => {
    const cwd = newRunDir();
    const pidsFile = join(cwd, "pids.json");
    const driver = createOpenCodeDriver();
    const handle = driver.start({
      cwd,
      prompt: "long task",
      mode: "auto",
      env: stubEnv({ STUB_HANG: "1", STUB_PIDS_FILE: pidsFile }),
    });
    if (handle.pid !== null) strayPids.push(handle.pid);
    expect(await waitUntil(() => existsSync(pidsFile), 10_000)).toBe(true);
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { pid: number; childPid: number };
    expect(pidAlive(pids.pid)).toBe(true);
    expect(pidAlive(pids.childPid)).toBe(true);

    const consuming = collectEvents(handle);
    await handle.abort();
    const exit = await handle.exited;
    const events = await consuming;

    expect(exit).toMatchObject({ code: null, reason: "aborted" });
    expect(events.map((event) => event.type)).toEqual(["started"]);
    expect(exit.output).toBe("");
    expect(await waitUntil(() => !pidAlive(pids.pid), 10_000)).toBe(true);
    expect(await waitUntil(() => !pidAlive(pids.childPid), 10_000)).toBe(true);
  }, 30_000);

  it("still terminates the child after the consumer abandons the events iterator", async () => {
    const cwd = newRunDir();
    const pidsFile = join(cwd, "pids.json");
    const driver = createOpenCodeDriver();
    const handle = driver.start({
      cwd,
      prompt: "abandoned",
      mode: "auto",
      env: stubEnv({
        STUB_HANG: "1",
        STUB_PIDS_FILE: pidsFile,
        STUB_FIXTURE: join(fixturesDir, "opencode-normal.jsonl"),
      }),
    });
    if (handle.pid !== null) strayPids.push(handle.pid);
    expect(await waitUntil(() => existsSync(pidsFile), 10_000)).toBe(true);
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { pid: number; childPid: number };

    const seen: AgentEvent[] = [];
    for await (const event of handle.events) {
      seen.push(event);
      if (seen.length === 2) break;
    }
    expect(seen.map((event) => event.type)).toEqual(["started", "session"]);
    const pending = await Promise.race([
      handle.exited.then(() => "resolved" as const),
      new Promise((resolve) => setTimeout(() => resolve("pending" as const), 300)),
    ]);
    expect(pending).toBe("pending");

    await handle.abort();
    const exit = await handle.exited;
    expect(exit).toMatchObject({ code: null, reason: "aborted" });
    expect(await waitUntil(() => !pidAlive(pids.pid) && !pidAlive(pids.childPid), 10_000)).toBe(
      true,
    );
  }, 30_000);

  it("bounds the events buffer with drop-oldest when unconsumed", async () => {
    const cwd = newRunDir();
    const manyLines = join(cwd, "many.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(
        JSON.stringify({
          type: "text",
          timestamp: 1000 + i,
          sessionID: "ses_flood",
          part: { type: "text", text: `chunk ${i}\n` },
        }),
      );
    }
    writeFileSync(manyLines, `${lines.join("\n")}\n`);
    const driver = createOpenCodeDriver({ eventBufferCap: 5, killGraceMs: 1000 });
    const handle = driver.start({
      cwd,
      prompt: "flood",
      mode: "auto",
      env: stubEnv({ STUB_FIXTURE: manyLines, STUB_HANG: "1" }),
    });
    if (handle.pid !== null) strayPids.push(handle.pid);

    await waitUntil(() => handle.droppedEvents > 0, 10_000);
    const dropped = handle.droppedEvents;
    await handle.abort();
    const exit = await handle.exited;
    expect(exit).toMatchObject({ code: null, reason: "aborted" });
    expect(dropped).toBe(27);
    const buffered = await collectEvents(handle);
    expect(buffered.length).toBe(5);
  }, 30_000);

  it("reports a missing binary as a typed error via exited, without throwing from start()", async () => {
    const driver = createOpenCodeDriver();
    const cwd = newRunDir();
    let handle: ReturnType<typeof driver.start>;
    expect(() => {
      handle = driver.start({ cwd, prompt: "hi", mode: "auto", env: { PATH: emptyBin } });
    }).not.toThrow();
    const events = await collectEvents(handle!);
    const exit = await handle!.exited;

    expect(events.map((event) => event.type)).toEqual(["started", "error"]);
    const error = events[1];
    if (error?.type !== "error") throw new Error("expected error event");
    expect(error.code).toBe("OPENCODE_NOT_FOUND");
    expect(error.message).toContain("opencode auth login");
    expect(exit).toEqual({ code: null, reason: "error", output: error.message });
    expect(handle!.pid).toBeNull();
    expect(await handle!.usage).toBeNull();
  }, 20_000);

  it("supports a single events consumer", async () => {
    const driver = createOpenCodeDriver();
    const handle = driver.start({
      cwd: newRunDir(),
      prompt: "once",
      mode: "auto",
      env: stubEnv({ STUB_FIXTURE: join(fixturesDir, "opencode-normal.jsonl") }),
    });
    const consuming = collectEvents(handle);
    expect(() => handle.events[Symbol.asyncIterator]()).toThrow(DriverError);
    const exit = await handle.exited;
    await consuming;
    expect(exit.reason).toBe("exit");
  }, 20_000);

  it("is a no-op to abort after the run finished", async () => {
    const driver = createOpenCodeDriver();
    const handle = driver.start({
      cwd: newRunDir(),
      prompt: "done already",
      mode: "auto",
      env: stubEnv({ STUB_FIXTURE: join(fixturesDir, "opencode-normal.jsonl") }),
    });
    const events = await collectEvents(handle);
    void events;
    await handle.exited;
    await expect(handle.abort()).resolves.toBeUndefined();
  }, 20_000);

  it("surfaces a missing cwd as a spawn error without throwing", async () => {
    const driver = createOpenCodeDriver();
    const handle = driver.start({
      cwd: join(workRoot, "does-not-exist"),
      prompt: "hi",
      mode: "auto",
    });
    const events = await collectEvents(handle);
    const exit = await handle.exited;
    expect(events.map((event) => event.type)).toEqual(["started", "error"]);
    const error = events[1];
    if (error?.type !== "error") throw new Error("expected error event");
    expect(error.code).toBe("OPENCODE_SPAWN_FAILED");
    expect(error.message).toContain("does not exist");
    expect(exit).toMatchObject({ code: null, reason: "error" });
  }, 20_000);
});

describe("checkOpenCodeInstalled", () => {
  it("rejects with a typed, actionable error when the binary is missing", async () => {
    const error = await checkOpenCodeInstalled({
      binary: "opencode-definitely-not-on-path",
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpenCodeDriverError);
    expect(error).toMatchObject({ code: "OPENCODE_NOT_FOUND" });
    expect((error as OpenCodeDriverError).message).toContain("opencode auth login");
  });

  it("resolves when the preflight command succeeds", async () => {
    await expect(checkOpenCodeInstalled({ binary: stubPath, env: {} })).resolves.toBeUndefined();
  });
});
