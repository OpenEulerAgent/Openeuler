import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@openeuler/core";
import { createFakeDriver, type FakeDriver } from "./fake.js";
import { DriverError } from "./error.js";
import type { AgentExecSeam, AgentStartOpts } from "./types.js";

const startOpts: AgentStartOpts = {
  cwd: "/tmp/openeuler",
  prompt: "do the thing",
  mode: "auto",
};

const script: AgentEvent[] = [
  { type: "session", seq: 1, sessionId: "s_1" },
  { type: "message-delta", seq: 2, delta: "Hello" },
  { type: "tool-call", seq: 3, tool: "bash", input: { cmd: "ls" } },
  { type: "tool-output", seq: 4, output: "files..." },
  { type: "done", seq: 5, output: "Hello" },
];

async function collect(handle: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const received: AgentEvent[] = [];
  for await (const event of handle.events) {
    received.push(event);
  }
  return received;
}

describe("createFakeDriver", () => {
  it('defaults its id to "fake"', () => {
    expect(createFakeDriver().id).toBe("fake");
    expect(createFakeDriver({ id: "fake-2" }).id).toBe("fake-2");
  });

  it("records every start call for assertions", async () => {
    const driver = createFakeDriver();
    const secondOpts: AgentStartOpts = { ...startOpts, mode: "ask", model: "glm-4.6" };
    driver.start(startOpts);
    driver.start(secondOpts);
    expect(driver.calls.length).toBe(2);
    expect(driver.calls[0]).toBe(startOpts);
    expect(driver.calls[1]).toBe(secondOpts);
  });

  it("emits scripted events in order, prepending started when missing", async () => {
    const driver = createFakeDriver({ events: script });
    const handle = driver.start(startOpts);
    const received = await collect(handle);
    expect(received).toEqual([{ type: "started", seq: 0 }, ...script]);
  });

  it("does not prepend started when the script already begins with one", async () => {
    const withStarted: AgentEvent[] = [
      { type: "started", seq: 0 },
      { type: "message-delta", seq: 1, delta: "hi" },
    ];
    const driver = createFakeDriver({ events: withStarted });
    const received = await collect(driver.start(startOpts));
    expect(received).toEqual(withStarted);
  });

  it("emits immediately by default and waits delayMs between events", async () => {
    const immediate = await collect(createFakeDriver({ events: script }).start(startOpts));
    expect(immediate.length).toBe(script.length + 1);

    const beganAt = Date.now();
    const received = await collect(
      createFakeDriver({ events: script, delayMs: 10 }).start(startOpts),
    );
    const elapsed = Date.now() - beganAt;
    expect(received.length).toBe(script.length + 1);
    // (script + prepended started) => 5 gaps of delayMs.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("resolves exited with the scripted result after the stream ends", async () => {
    const driver = createFakeDriver({ events: script, output: "final output", exitCode: 0 });
    const handle = driver.start(startOpts);
    await collect(handle);
    await expect(handle.exited).resolves.toEqual({
      code: 0,
      reason: "exit",
      output: "final output",
    });
  });

  it("cycles per-start outputs by call count (for loop iterations)", async () => {
    const driver = createFakeDriver({
      events: [],
      output: "static",
      outputs: ["WIP-1", "WIP-2"],
    });
    const outputs: string[] = [];
    for (let call = 0; call < 5; call += 1) {
      const handle = driver.start(startOpts);
      await collect(handle);
      const exit = await handle.exited;
      outputs.push(exit.output);
    }
    // outputs[n % outputs.length]; wins over the fixed `output`.
    expect(outputs).toEqual(["WIP-1", "WIP-2", "WIP-1", "WIP-2", "WIP-1"]);
  });

  it("honors a non-zero exitCode", async () => {
    const handle = createFakeDriver({ events: script, exitCode: 3 }).start(startOpts);
    await collect(handle);
    await expect(handle.exited).resolves.toMatchObject({ code: 3, reason: "exit" });
  });

  it("cycles per-start exit codes by call count (#119: fail N times then succeed)", async () => {
    const driver = createFakeDriver({ events: [], exitCodes: [1, 1, 0] });
    const codes: number[] = [];
    for (let call = 0; call < 4; call += 1) {
      const handle = driver.start(startOpts);
      await collect(handle);
      const exit = await handle.exited;
      codes.push(exit.code ?? -1);
    }
    // exitCodes[n % exitCodes.length]; wins over the default exit code 0.
    expect(codes).toEqual([1, 1, 0, 1]);
  });

  it("falls back to accumulated message-delta/tool-output text as final output", async () => {
    const handle = createFakeDriver({ events: script }).start(startOpts);
    await collect(handle);
    await expect(handle.exited).resolves.toMatchObject({
      reason: "exit",
      output: "Hellofiles...",
    });
  });
});

describe("fake driver abort", () => {
  it("stops remaining events and resolves exited as aborted", async () => {
    const driver = createFakeDriver({
      events: [
        { type: "message-delta", seq: 1, delta: "a" },
        { type: "message-delta", seq: 2, delta: "b" },
        { type: "message-delta", seq: 3, delta: "c" },
      ],
      delayMs: 5,
    });
    const handle = driver.start(startOpts);
    const received: AgentEvent[] = [];
    for await (const event of handle.events) {
      received.push(event);
      if (received.length === 2) {
        await handle.abort();
      }
    }
    expect(received).toEqual([
      { type: "started", seq: 0 },
      { type: "message-delta", seq: 1, delta: "a" },
    ]);
    await expect(handle.exited).resolves.toEqual({
      code: null,
      reason: "aborted",
      output: "a",
    });
  });

  it("works before the stream is consumed", async () => {
    const handle = createFakeDriver({ events: script }).start(startOpts);
    await handle.abort();
    expect(await collect(handle)).toEqual([]);
    await expect(handle.exited).resolves.toEqual({
      code: null,
      reason: "aborted",
      output: "",
    });
  });

  it("is a no-op after completion", async () => {
    const handle = createFakeDriver({ events: script, output: "done output" }).start(startOpts);
    await collect(handle);
    const exit = await handle.exited;
    await expect(handle.abort()).resolves.toBeUndefined();
    await expect(handle.exited).resolves.toBe(exit);
  });

  it("can be configured to fail with a typed DriverError", async () => {
    const driver: FakeDriver = createFakeDriver({
      events: [
        { type: "message-delta", seq: 1, delta: "a" },
        { type: "message-delta", seq: 2, delta: "b" },
      ],
      failOnAbort: true,
    });
    const handle = driver.start(startOpts);
    const received: AgentEvent[] = [];
    for await (const event of handle.events) {
      received.push(event);
      if (received.length === 1) {
        await expect(handle.abort()).rejects.toThrow(DriverError);
        await expect(handle.abort()).rejects.toMatchObject({ code: "DRIVER_ABORT_FAILED" });
      }
    }
    expect(received.length).toBe(3);
    await expect(handle.exited).resolves.toMatchObject({ code: 0, reason: "exit" });
  });
});

describe("fake driver event stream", () => {
  it("rejects a second iteration with a clear typed error", async () => {
    const handle = createFakeDriver({ events: script }).start(startOpts);
    expect((await collect(handle)).length).toBe(script.length + 1);
    const failure = await collect(handle).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DriverError);
    expect(failure).toMatchObject({ code: "DRIVER_EVENTS_ALREADY_CONSUMED" });
  });

  it("resolves exited when the consumer breaks out of the stream early", async () => {
    const handle = createFakeDriver({ events: script, output: "never reached" }).start(startOpts);
    for await (const event of handle.events) {
      if (event.type === "message-delta") {
        break;
      }
    }
    await expect(handle.exited).resolves.toEqual({
      code: null,
      reason: "aborted",
      output: "Hello",
    });
  });
});

describe("fake driver onStart hook", () => {
  it("is called once per start with the received opts", async () => {
    const seen: AgentStartOpts[] = [];
    const driver = createFakeDriver({ events: script, onStart: (opts) => void seen.push(opts) });
    await collect(driver.start(startOpts));
    await collect(driver.start(startOpts));
    expect(seen).toEqual([startOpts, startOpts]);
    expect(driver.calls).toEqual([startOpts, startOpts]);
  });

  it("replays events only after an async onStart settles", async () => {
    const order: string[] = [];
    const driver = createFakeDriver({
      events: [{ type: "message-delta", seq: 1, delta: "hi" }],
      onStart: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("onStart");
      },
    });
    const handle = driver.start(startOpts);
    for await (const event of handle.events) {
      order.push(event.type);
    }
    expect(order).toEqual(["onStart", "started", "message-delta"]);
  });

  it("waits for onStart before exited resolves so cwd writes are visible", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openeuler-fake-"));
    try {
      const driver = createFakeDriver({
        events: [{ type: "done", seq: 1, output: "written" }],
        onStart: async (opts) => {
          await writeFile(join(opts.cwd, "touched.txt"), "by agent\n", "utf8");
        },
      });
      const handle = driver.start({ ...startOpts, cwd: dir });
      await collect(handle);
      await expect(handle.exited).resolves.toMatchObject({ reason: "exit" });
      expect(await readFile(join(dir, "touched.txt"), "utf8")).toBe("by agent\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("fake driver sandbox exec seam (#102)", () => {
  it("records the exec seam on calls and abort() stops in-flight commands", async () => {
    let stopCalls = 0;
    let cancel: ((error: Error) => void) | null = null;
    const seam: AgentExecSeam = {
      kind: "sandbox",
      run: (cmd) =>
        new Promise((_resolve, reject) => {
          expect(cmd[0]).toBe("opencode");
          cancel = reject;
        }),
      stop: () => {
        stopCalls += 1;
        cancel?.(new Error("sandbox exec cancelled"));
      },
    };
    const driver = createFakeDriver({
      delayMs: 60_000,
      events: [{ type: "message-delta", seq: 1, delta: "x" }],
    });
    const handle = driver.start({ ...startOpts, cwd: "/workspace", exec: seam });
    expect(driver.calls[0]?.exec).toBe(seam);
    await handle.abort();
    await expect(handle.exited).resolves.toMatchObject({ reason: "aborted" });
    expect(stopCalls).toBe(1);
  });

  it("onStart can drive the seam (scripted results still replay afterwards)", async () => {
    const ran: string[][] = [];
    const seam: AgentExecSeam = {
      kind: "sandbox",
      run: async (cmd) => {
        ran.push([...cmd]);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const driver = createFakeDriver({
      events: [{ type: "done", seq: 1, output: "ok" }],
      output: "ok",
      onStart: (opts) => {
        void opts.exec?.run(["touch", "/workspace/hello.txt"]);
      },
    });
    const handle = driver.start({ ...startOpts, cwd: "/workspace", exec: seam });
    const events = await collect(handle);
    await expect(handle.exited).resolves.toMatchObject({ reason: "exit", output: "ok" });
    expect(events.map((event) => event.type)).toContain("done");
    expect(ran).toContainEqual(["touch", "/workspace/hello.txt"]);
  });
});
