import { describe, expect, it } from "vitest";
import { SandboxError } from "./error.js";
import { createFakeSandboxProvider } from "./fake.js";
import type { SandboxLogEntry, SandboxSpec } from "./types.js";

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    runId: "run-1",
    image: "openeuler/test:latest",
    mounts: [{ hostPath: "/host/wt", containerPath: "/wt", readonly: true }],
    env: { FOO: "bar" },
    ...overrides,
  };
}

const logLines: SandboxLogEntry[] = [
  { stream: "stdout", line: "l1" },
  { stream: "stderr", line: "l2" },
  { stream: "stdout", line: "l3" },
];

describe("createFakeSandboxProvider", () => {
  it('defaults its id to "fake" and assigns unique sandbox ids', async () => {
    const provider = createFakeSandboxProvider();
    expect(provider.id).toBe("fake");
    expect(createFakeSandboxProvider({ id: "fake-2" }).id).toBe("fake-2");

    const first = await provider.create(spec());
    const second = await provider.create(spec());
    expect(first.id).not.toBe(second.id);
  });

  it("rejects an empty or blank image with SANDBOX_IMAGE_MISSING", async () => {
    const provider = createFakeSandboxProvider();
    for (const image of ["", "   "]) {
      const failure = await provider.create(spec({ image })).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(SandboxError);
      expect(failure).toMatchObject({ code: "SANDBOX_IMAGE_MISSING" });
    }
    expect(provider.createdSpecs).toEqual([]);
  });

  it("rejects images outside knownImages with SANDBOX_IMAGE_MISSING", async () => {
    const provider = createFakeSandboxProvider({ knownImages: ["openeuler/test:latest"] });
    await provider.create(spec());
    const failure = await provider.create(spec({ image: "other:latest" })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "SANDBOX_IMAGE_MISSING" });
    expect((failure as SandboxError).message).toContain("other:latest");
    expect(provider.createdSpecs.length).toBe(1);
  });

  it("rejects create with SANDBOX_UNAVAILABLE when failOnCreate is set", async () => {
    const provider = createFakeSandboxProvider({ failOnCreate: true });
    const failure = await provider.create(spec()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
    expect(provider.createdSpecs).toEqual([]);
  });

  it("records deep spec snapshots that survive caller mutation", async () => {
    const provider = createFakeSandboxProvider();
    const input = spec({ labels: { app: "x" }, ports: [8080] });
    const handle = await provider.create(input);
    expect(provider.createdSpecs.length).toBe(1);
    expect(provider.createdSpecs[0]).toEqual(input);
    expect(provider.createdSpecs[0]).not.toBe(input);

    input.env.FOO = "mutated";
    const mount = input.mounts[0];
    if (mount) mount.hostPath = "/mutated";
    if (input.labels) input.labels.app = "mutated";
    expect(provider.createdSpecs[0]?.env).toEqual({ FOO: "bar" });
    expect(provider.createdSpecs[0]?.mounts[0]).toMatchObject({ hostPath: "/host/wt" });
    expect(provider.createdSpecs[0]?.labels).toEqual({ app: "x" });

    // The handle's own behavior is unaffected by the mutation.
    expect(handle.meta.image).toBe("openeuler/test:latest");
  });

  it("records exec calls with snapshots of cmd and opts", async () => {
    const provider = createFakeSandboxProvider();
    const handle = await provider.create(spec());
    const cmd = ["echo", "hi"];
    await handle.exec(cmd, { timeoutMs: 1000, env: { A: "1" } });
    cmd.push("mutated");
    expect(provider.execCalls).toEqual([
      {
        sandboxId: handle.id,
        cmd: ["echo", "hi"],
        opts: { timeoutMs: 1000, env: { A: "1" } },
      },
    ]);
  });
});

describe("fake provider exec", () => {
  it("defaults to code 0 and an echo of the command", async () => {
    const provider = createFakeSandboxProvider();
    const handle = await provider.create(spec());
    const result = await handle.exec(["echo", "hello", "world"]);
    expect(result).toMatchObject({
      code: 0,
      stdout: "echo hello world\n",
      stderr: "",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("serves a provider-level scripted queue across handles in call order", async () => {
    const provider = createFakeSandboxProvider({
      execResults: [
        { code: 2, stdout: "first" },
        { code: 0, stdout: "second" },
      ],
    });
    const one = await provider.create(spec());
    const two = await provider.create(spec());

    await expect(one.exec(["a"])).resolves.toMatchObject({ code: 2, stdout: "first" });
    await expect(two.exec(["b"])).resolves.toMatchObject({ code: 0, stdout: "second" });
    // Queue exhausted → default echo.
    await expect(one.exec(["c"])).resolves.toMatchObject({
      code: 0,
      stdout: "c\n",
    });
  });

  it("fills scripted durationMs and honors explicit ones", async () => {
    const provider = createFakeSandboxProvider({
      execResults: [{ durationMs: 123 }, {}],
    });
    const handle = await provider.create(spec());
    await expect(handle.exec(["a"])).resolves.toMatchObject({ durationMs: 123 });
    await expect(handle.exec(["b"])).resolves.toMatchObject({ code: 0, durationMs: 0 });
  });

  it("throws scripted errors", async () => {
    const provider = createFakeSandboxProvider({
      execResults: [new SandboxError("SANDBOX_EXEC_FAILED", "scripted boom")],
    });
    const handle = await provider.create(spec());
    const failure = await handle.exec(["boom"]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_EXEC_FAILED" });
  });

  it("measures durationMs across execDelayMs", async () => {
    const provider = createFakeSandboxProvider({ execDelayMs: 30 });
    const handle = await provider.create(spec());
    const result = await handle.exec(["slow"]);
    expect(result.durationMs).toBeGreaterThanOrEqual(25);
  });

  it("times out fast when timeoutMs < execDelayMs", async () => {
    const provider = createFakeSandboxProvider({ execDelayMs: 5_000 });
    const handle = await provider.create(spec());
    const beganAt = Date.now();
    const failure = await handle.exec(["sleep"], { timeoutMs: 10 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_TIMEOUT" });
    expect(Date.now() - beganAt).toBeLessThan(1_000);
  });

  it("rejects exec on exited, stopped, and destroyed sandboxes", async () => {
    const provider = createFakeSandboxProvider({ exitsAfterMs: 5 });
    const exited = await provider.create(spec());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await exited.status()).toBe("exited");
    await expect(exited.exec(["x"])).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });

    const stopped = await (await createFakeSandboxProvider()).create(spec());
    await stopped.stop();
    await expect(stopped.exec(["x"])).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });

    const destroyed = await (await createFakeSandboxProvider()).create(spec());
    await destroyed.destroy();
    await expect(destroyed.exec(["x"])).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
  });
});

describe("fake provider execStream (#104)", () => {
  it("streams scripted chunks in order and resolves exited with the scripted code", async () => {
    const provider = createFakeSandboxProvider({
      execStreams: [
        {
          chunks: [
            { stream: "stdout", chunk: '{"type":"text"' },
            { stream: "stderr", chunk: "warning\n" },
            { stream: "stdout", chunk: ',"part":{}}\n' },
          ],
          code: 3,
        },
      ],
    });
    const handle = await provider.create(spec());
    const stream = handle.execStream(["opencode", "run", "p"]);

    const chunks: Array<{ stream: string; chunk: string }> = [];
    for await (const chunk of stream.events)
      chunks.push({ stream: chunk.stream, chunk: chunk.chunk });
    const exit = await stream.exited;

    expect(chunks).toEqual([
      { stream: "stdout", chunk: '{"type":"text"' },
      { stream: "stderr", chunk: "warning\n" },
      { stream: "stdout", chunk: ',"part":{}}\n' },
    ]);
    expect(exit).toMatchObject({ code: 3 });
    expect(exit.durationMs).toBeGreaterThanOrEqual(0);
    expect(provider.execStreamCalls).toEqual([
      { sandboxId: handle.id, cmd: ["opencode", "run", "p"], opts: undefined },
    ]);
    // The stream queue is independent of the exec script queue.
    expect(provider.execCalls).toEqual([]);
  });

  it("falls back to a single-stdout-chunk echo when the script queue is empty", async () => {
    const provider = createFakeSandboxProvider();
    const handle = await provider.create(spec());
    const stream = handle.execStream(["echo", "hi"]);
    const chunks: Array<{ stream: string; chunk: string }> = [];
    for await (const chunk of stream.events)
      chunks.push({ stream: chunk.stream, chunk: chunk.chunk });
    await expect(stream.exited).resolves.toMatchObject({ code: 0 });
    expect(chunks).toEqual([{ stream: "stdout", chunk: "echo hi\n" }]);
  });

  it("rejects exited with SANDBOX_TIMEOUT when inter-chunk delays exceed timeoutMs", async () => {
    const provider = createFakeSandboxProvider({
      execStreams: [
        {
          chunks: [
            { stream: "stdout", chunk: "one" },
            { stream: "stdout", chunk: "two" },
          ],
          interChunkDelayMs: 5_000,
        },
      ],
    });
    const handle = await provider.create(spec());
    const stream = handle.execStream(["slow"], { timeoutMs: 20 });
    const failure = await stream.exited.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_TIMEOUT" });
    // The events iteration ends promptly after the rejection.
    for await (const chunk of stream.events) void chunk;
  });

  it("cancel() ends events and rejects exited with SANDBOX_UNAVAILABLE", async () => {
    const provider = createFakeSandboxProvider({
      execStreams: [
        { chunks: [{ stream: "stdout", chunk: "a" }], interChunkDelayMs: 300, code: 0 },
      ],
    });
    const handle = await provider.create(spec());
    const stream = handle.execStream(["stuck"]);
    const consumed = (async () => {
      for await (const chunk of stream.events) void chunk;
    })();
    stream.cancel?.();
    const failure = await stream.exited.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
    await Promise.race([consumed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  });

  it("rejects execStream synchronously on stopped sandboxes and bad cmds", async () => {
    const provider = createFakeSandboxProvider();
    const handle = await provider.create(spec());
    await handle.stop();
    expect(() => handle.execStream(["true"])).toThrow(SandboxError);
    const stoppedHandle = await (await createFakeSandboxProvider()).create(spec());
    expect(() => stoppedHandle.execStream([])).toThrow(/non-empty array of strings/);
  });
});

describe("fake provider stop/destroy", () => {
  it("transitions running → stopped and records stop calls", async () => {
    const provider = createFakeSandboxProvider();
    const handle = await provider.create(spec());
    await handle.stop(250);
    expect(await handle.status()).toBe("stopped");
    expect(provider.stopCalls).toEqual([{ sandboxId: handle.id, timeoutMs: 250 }]);
  });

  it("rejects stop with SANDBOX_STOP_FAILED when failOnStop is set", async () => {
    const provider = createFakeSandboxProvider({ failOnStop: true });
    const handle = await provider.create(spec());
    await expect(handle.stop()).rejects.toMatchObject({ code: "SANDBOX_STOP_FAILED" });
    expect(await handle.status()).toBe("running");
  });

  it("destroy removes the sandbox from list and records the call", async () => {
    const provider = createFakeSandboxProvider();
    const handle = await provider.create(spec());
    await handle.destroy();
    expect(await provider.list()).toEqual([]);
    expect(provider.destroyCalls).toEqual([{ sandboxId: handle.id }]);
    expect(provider.stopCalls).toEqual([]);
  });

  it("status reports stopped after destroy", async () => {
    const provider = createFakeSandboxProvider();
    const handle = await provider.create(spec());
    await handle.destroy();
    expect(await handle.status()).toBe("stopped");
  });

  it("keeps a stopped sandbox in list with status stopped", async () => {
    const provider = createFakeSandboxProvider();
    const handle = await provider.create(spec());
    await handle.stop();
    const summaries = await provider.list();
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toMatchObject({ id: handle.id, status: "stopped" });
  });
});

describe("fake provider ports", () => {
  it("maps spec ports to distinct, stable ephemeral host ports", async () => {
    const provider = createFakeSandboxProvider();
    const first = await provider.create(spec({ ports: [8080, 9090] }));
    const second = await provider.create(spec({ ports: [8080] }));

    const firstPorts = await first.hostPorts();
    expect(Object.keys(firstPorts)).toEqual(["8080", "9090"]);
    expect(firstPorts["8080"]).not.toBe(firstPorts["9090"]);
    expect(await first.hostPorts()).toEqual(firstPorts);

    const secondPorts = await second.hostPorts();
    expect(Object.keys(secondPorts)).toEqual(["8080"]);
    expect(secondPorts["8080"]).not.toBe(firstPorts["8080"]);

    // Ports survive stop, clear on destroy.
    await first.stop();
    expect(await first.hostPorts()).toEqual(firstPorts);
    await first.destroy();
    expect(await first.hostPorts()).toEqual({});
  });
});

describe("fake provider logs", () => {
  /** Expected log entries with the fake's synthetic `at` stamps (createdAt + index). */
  const stamped = (createdAt: number, entries: SandboxLogEntry[]): SandboxLogEntry[] =>
    entries.map((entry, index) => ({ ...entry, at: createdAt + index }));

  it("replays scripted lines in order (with `at` stamps) and supports repeated iteration", async () => {
    const provider = createFakeSandboxProvider({ logLines });
    const handle = await provider.create(spec());
    const seen: SandboxLogEntry[][] = [];
    for (let round = 0; round < 2; round += 1) {
      const entries: SandboxLogEntry[] = [];
      for await (const entry of handle.logs()) entries.push(entry);
      seen.push(entries);
    }
    expect(seen).toEqual([
      stamped(handle.meta.createdAt, logLines),
      stamped(handle.meta.createdAt, logLines),
    ]);
  });

  it("waits logDelayMs between lines", async () => {
    const provider = createFakeSandboxProvider({ logLines, logDelayMs: 10 });
    const handle = await provider.create(spec());
    const beganAt = Date.now();
    let count = 0;
    for await (const entry of handle.logs()) {
      expect(entry.stream).toBeDefined();
      count += 1;
    }
    expect(count).toBe(logLines.length);
    expect(Date.now() - beganAt).toBeGreaterThanOrEqual(25);
  });

  it("filters with since using synthetic timestamps (createdAt + index)", async () => {
    const provider = createFakeSandboxProvider({ logLines });
    const handle = await provider.create(spec());
    const since = handle.meta.createdAt + 1;
    const entries: SandboxLogEntry[] = [];
    for await (const entry of handle.logs({ since })) entries.push(entry);
    expect(entries).toEqual(stamped(handle.meta.createdAt, logLines).slice(1));
  });

  it("composes since with tail (since first, then last N)", async () => {
    const provider = createFakeSandboxProvider({ logLines });
    const handle = await provider.create(spec());
    const stampedAll = stamped(handle.meta.createdAt, logLines);
    const entries: SandboxLogEntry[] = [];
    for await (const entry of handle.logs({ since: handle.meta.createdAt, tail: 2 })) {
      entries.push(entry);
    }
    expect(entries).toEqual(stampedAll.slice(-2));

    const all: SandboxLogEntry[] = [];
    for await (const entry of handle.logs({ tail: 100 })) all.push(entry);
    expect(all).toEqual(stampedAll);

    const none: SandboxLogEntry[] = [];
    for await (const entry of handle.logs({ tail: 0 })) none.push(entry);
    expect(none).toEqual([]);
  });

  it("streams logs from a stopped sandbox but not a destroyed one", async () => {
    const provider = createFakeSandboxProvider({ logLines });
    const stopped = await provider.create(spec());
    await stopped.stop();
    const entries: SandboxLogEntry[] = [];
    for await (const entry of stopped.logs()) entries.push(entry);
    expect(entries).toEqual(stamped(stopped.meta.createdAt, logLines));

    const destroyed = await (await createFakeSandboxProvider({ logLines })).create(spec());
    await destroyed.destroy();
    const afterDestroy: SandboxLogEntry[] = [];
    for await (const entry of destroyed.logs()) afterDestroy.push(entry);
    expect(afterDestroy).toEqual([]);
  });
});

describe("fake provider list/stats", () => {
  it("filters by label selector as a subset match", async () => {
    const provider = createFakeSandboxProvider();
    const worker = await provider.create(spec({ labels: { run: "r1", role: "worker" } }));
    const other = await provider.create(spec({ labels: { run: "r2" } }));

    expect((await provider.list()).length).toBe(2);
    expect((await provider.list({})).length).toBe(2);

    const r1 = await provider.list({ run: "r1" });
    expect(r1.map((s) => s.id)).toEqual([worker.id]);
    expect(r1[0]).toMatchObject({
      image: "openeuler/test:latest",
      labels: { run: "r1", role: "worker" },
      status: "running",
      createdAt: worker.meta.createdAt,
    });

    expect((await provider.list({ run: "r1", role: "worker" })).length).toBe(1);
    expect(await provider.list({ run: "r1", role: "other" })).toEqual([]);
    expect((await provider.list({ run: "r2" })).map((s) => s.id)).toEqual([other.id]);
  });

  it("summarizes unlabeled sandboxes with empty labels", async () => {
    const provider = createFakeSandboxProvider();
    await provider.create(spec());
    const summaries = await provider.list();
    expect(summaries.length).toBe(1);
    expect(summaries[0]?.labels).toEqual({});
  });

  it("reports spec resources via stats()", async () => {
    const provider = createFakeSandboxProvider();
    const handle = await provider.create(spec({ resources: { cpus: 2, memoryMb: 512 } }));
    expect(await provider.stats()).toEqual([{ id: handle.id, cpus: 2, memoryMb: 512 }]);
    await handle.destroy();
    expect(await provider.stats()).toEqual([]);
  });

  it("destroys by id (GC path): known id removed + recorded, unknown id is a no-op (#105)", async () => {
    const provider = createFakeSandboxProvider();
    const handle = await provider.create(spec());
    await provider.destroy?.(handle.id);
    expect(await provider.list()).toEqual([]);
    expect(provider.destroyCalls).toEqual([{ sandboxId: handle.id }]);

    // Already-gone ids resolve (idempotent), like the docker provider.
    await expect(provider.destroy?.("never-existed")).resolves.toBeUndefined();
  });

  it("stops by id (#112): kept + listed as stopped, unknown id is a no-op", async () => {
    const provider = createFakeSandboxProvider();
    const handle = await provider.create(spec());
    await provider.stop?.(handle.id);
    const summaries = await provider.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: handle.id, status: "stopped" });
    expect(provider.stopCalls).toEqual([{ sandboxId: handle.id, timeoutMs: undefined }]);

    // Already-gone ids resolve (idempotent), like destroy-by-id.
    await expect(provider.stop?.("never-existed")).resolves.toBeUndefined();
  });

  it("transitions to exited on its own after exitsAfterMs", async () => {
    const provider = createFakeSandboxProvider({ exitsAfterMs: 10 });
    const handle = await provider.create(spec());
    expect(await handle.status()).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await handle.status()).toBe("exited");
    // stop() on an already-exited sandbox is a no-op.
    await handle.stop();
    expect(await handle.status()).toBe("exited");
  });
});
