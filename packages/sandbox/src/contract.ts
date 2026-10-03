import { describe, expect, it } from "vitest";
import { SandboxError } from "./error.js";
import type {
  SandboxExecChunk,
  SandboxExecResult,
  SandboxLogEntry,
  SandboxProvider,
  SandboxSpec,
} from "./types.js";

/**
 * Scripted `execStream` outcome (#104): `chunks` are streamed in order (with
 * `interChunkDelayMs` between them), then `exited` resolves with `code`.
 * Providers that run real commands compile the chunks into `printf`+
 * `sleep` sequences; the fake replays them in memory.
 */
export interface SandboxExecStreamScript {
  /** Chunks streamed in exact order (per-stream order pinned). */
  chunks: Array<{ stream: "stdout" | "stderr"; chunk: string }>;
  /** Exit code reported by `exited`. Default 0. */
  code?: number;
  /** Delay between chunks in ms; must exceed any test `timeoutMs`. Default 0. */
  interChunkDelayMs?: number;
}

/**
 * Scenario knobs a provider under test must honor when run through
 * {@link runSandboxContractTests}. Each test creates a fresh provider via
 * `makeProvider(script)`; the provider implementation maps the script onto
 * its real backend (the fake replays it in memory; the docker provider
 * compiles it into commands/containers).
 */
export interface SandboxContractScript {
  /**
   * Scripted `exec` outcomes served in call order (FIFO). Exhausting the
   * queue falls back to the provider's default exec, which must resolve
   * with `code: 0`.
   */
  execResults?: Array<Partial<SandboxExecResult> | SandboxError>;
  /**
   * Scripted `execStream` outcomes served FIFO (#104). Exhausting the queue
   * falls back to the provider's default streamed exec (code 0, echoing the
   * joined command on stdout like the default `exec`).
   */
  execStreams?: SandboxExecStreamScript[];
  /** Simulated command duration in ms; must exceed any test `timeoutMs`. */
  execDelayMs?: number;
  /** Log lines `handle.logs()` must stream, exactly and in order. */
  logLines?: SandboxLogEntry[];
  /** Delay between log lines in ms. */
  logDelayMs?: number;
  /**
   * Images this provider can create from; `create` with any other image
   * must reject with SANDBOX_IMAGE_MISSING.
   */
  knownImages?: string[];
  /** When true, `create` must reject with SANDBOX_UNAVAILABLE. */
  failOnCreate?: boolean;
  /** When true, `stop` must reject with SANDBOX_STOP_FAILED. */
  failOnStop?: boolean;
}

/** Builds a freshly-configured provider for one contract scenario. */
export type SandboxContractProviderMaker = (
  script: SandboxContractScript,
) => SandboxProvider | Promise<SandboxProvider>;

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    runId: "run-contract",
    image: "openeuler/contract:latest",
    mounts: [],
    env: {},
    ...overrides,
  };
}

/**
 * Provider-agnostic contract tests for {@link SandboxProvider}. Import into a
 * vitest file and pass a maker:
 *
 * ```ts
 * import { runSandboxContractTests } from "@openeuler/sandbox/contract";
 * import { createFakeSandboxProvider } from "@openeuler/sandbox";
 *
 * runSandboxContractTests((script) => createFakeSandboxProvider(script));
 * ```
 */
export function runSandboxContractTests(makeProvider: SandboxContractProviderMaker): void {
  describe("sandbox provider contract", () => {
    it("lifecycle: create → running, stop → stopped, stop idempotent", async () => {
      const provider = await makeProvider({});
      const sandbox = await provider.create(spec());
      expect(typeof sandbox.id).toBe("string");
      expect(sandbox.id.length).toBeGreaterThan(0);
      expect(await sandbox.status()).toBe("running");

      await sandbox.stop();
      expect(await sandbox.status()).toBe("stopped");

      // stop is idempotent: a second call resolves without effect.
      await sandbox.stop();
      expect(await sandbox.status()).toBe("stopped");
    });

    it("meta reports image, createdAt, and spec ports", async () => {
      const provider = await makeProvider({});
      const before = Date.now();
      const sandbox = await provider.create(spec({ ports: [8080, 9090] }));
      expect(sandbox.meta.image).toBe("openeuler/contract:latest");
      expect(sandbox.meta.createdAt).toBeGreaterThanOrEqual(before);
      expect(sandbox.meta.ports).toEqual([8080, 9090]);
    });

    it("exec replays scripted results in order, then defaults to code 0", async () => {
      const provider = await makeProvider({
        execResults: [
          { code: 1, stdout: "one", stderr: "boom" },
          { code: 0, stdout: "two" },
        ],
      });
      const sandbox = await provider.create(spec());

      const first = await sandbox.exec(["sh", "-c", "failing"]);
      expect(first.code).toBe(1);
      expect(first.stdout).toBe("one");
      expect(first.stderr).toBe("boom");
      expect(first.durationMs).toBeGreaterThanOrEqual(0);

      const second = await sandbox.exec(["sh", "-c", "ok"]);
      expect(second).toMatchObject({ code: 0, stdout: "two", stderr: "" });

      // Queue exhausted → provider default must still succeed with code 0.
      const fallback = await sandbox.exec(["echo", "hello"]);
      expect(fallback.code).toBe(0);
      expect(fallback.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("exec rejects with SANDBOX_TIMEOUT when timeoutMs is exceeded", async () => {
      const provider = await makeProvider({ execDelayMs: 60 });
      const sandbox = await provider.create(spec());
      const failure = await sandbox.exec(["sleep", "60"], { timeoutMs: 5 }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(SandboxError);
      expect(failure).toMatchObject({ code: "SANDBOX_TIMEOUT" });
    });

    it("exec after stop rejects with SANDBOX_UNAVAILABLE", async () => {
      const provider = await makeProvider({});
      const sandbox = await provider.create(spec());
      await sandbox.stop();
      const failure = await sandbox.exec(["true"]).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(SandboxError);
      expect(failure).toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
    });

    it("destroy is idempotent and clears the sandbox", async () => {
      const provider = await makeProvider({});
      const sandbox = await provider.create(spec({ labels: { app: "contract" } }));
      await sandbox.destroy();

      const ids = (await provider.list()).map((summary) => summary.id);
      expect(ids).not.toContain(sandbox.id);

      await sandbox.destroy();
      expect(await sandbox.status()).not.toBe("running");
      expect(await sandbox.hostPorts()).toEqual({});

      const failure = await sandbox.exec(["true"]).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: "SANDBOX_UNAVAILABLE" });

      const logs: SandboxLogEntry[] = [];
      for await (const entry of sandbox.logs({ tail: 10 })) logs.push(entry);
      expect(logs).toEqual([]);
    });

    it("list returns summaries; labelSelector matches as a subset", async () => {
      const provider = await makeProvider({});
      const first = await provider.create(spec({ labels: { run: "r1", role: "worker" } }));
      const second = await provider.create(spec({ labels: { run: "r2" } }));

      const all = await provider.list();
      const ids = all.map((summary) => summary.id);
      expect(ids).toContain(first.id);
      expect(ids).toContain(second.id);

      const summary = all.find((entry) => entry.id === first.id);
      expect(summary).toMatchObject({
        id: first.id,
        image: "openeuler/contract:latest",
        labels: { run: "r1", role: "worker" },
        status: "running",
      });
      expect(summary?.createdAt).toBe(first.meta.createdAt);

      const r1 = await provider.list({ run: "r1" });
      expect(r1.map((entry) => entry.id)).toEqual([first.id]);

      const none = await provider.list({ run: "missing" });
      expect(none).toEqual([]);
    });

    it("hostPorts maps spec ports to stable host ports", async () => {
      const provider = await makeProvider({});
      const sandbox = await provider.create(spec({ ports: [8080, 9090] }));
      const ports = await sandbox.hostPorts();
      expect(Object.keys(ports).sort()).toEqual(["8080", "9090"]);
      for (const [containerPort, hostPort] of Object.entries(ports)) {
        expect(Number.parseInt(containerPort, 10)).toBeGreaterThan(0);
        expect(hostPort).toBeGreaterThan(0);
      }
      // The mapping is stable across calls.
      expect(await sandbox.hostPorts()).toEqual(ports);

      const portless = await provider.create(spec());
      expect(await portless.hostPorts()).toEqual({});
    });

    it("logs streams scripted entries with per-stream order, honoring tail", async () => {
      const logLines: SandboxLogEntry[] = [
        { stream: "stdout", line: "l1" },
        { stream: "stderr", line: "l2" },
        { stream: "stdout", line: "l3" },
      ];
      const provider = await makeProvider({ logLines });

      const sandbox = await provider.create(spec());
      const full: SandboxLogEntry[] = [];
      for await (const entry of sandbox.logs()) full.push(entry);
      // Cross-stream interleaving is provider-dependent (docker demultiplexes
      // stdout/stderr frames with no cross-stream ordering guarantee) — the
      // contract only pins PER-STREAM order and the full multiset.
      const stdoutLines = full.filter((e) => e.stream === "stdout").map((e) => e.line);
      const stderrLines = full.filter((e) => e.stream === "stderr").map((e) => e.line);
      expect(stdoutLines).toEqual(["l1", "l3"]);
      expect(stderrLines).toEqual(["l2"]);
      expect(full).toHaveLength(logLines.length);

      const tailed: SandboxLogEntry[] = [];
      for await (const entry of sandbox.logs({ tail: 2 })) tailed.push(entry);
      // tail N = the last N entries per the provider's own emission order,
      // again only per-stream order is pinned.
      expect(tailed).toHaveLength(2);
      const tailedStreams = new Set(tailed.map((e) => e.stream));
      expect(tailedStreams.size).toBeGreaterThan(0);
    });

    it("execStream streams chunks live, resolves exited with the code", async () => {
      const provider = await makeProvider({
        execStreams: [
          {
            chunks: [
              { stream: "stdout", chunk: "partial-json-" },
              { stream: "stderr", chunk: "warn\n" },
              { stream: "stdout", chunk: "line\n" },
            ],
            code: 5,
          },
        ],
      });
      const sandbox = await provider.create(spec());
      const stream = sandbox.execStream(["sh", "-c", "noisy"]);

      const chunks: SandboxExecChunk[] = [];
      for await (const chunk of stream.events) chunks.push(chunk);
      const exit = await stream.exited;

      // Chunk BOUNDARIES are transport-dependent (writes may coalesce); the
      // contract pins per-stream content+order and the exit code.
      expect(
        chunks
          .filter((c) => c.stream === "stdout")
          .map((c) => c.chunk)
          .join(""),
      ).toBe("partial-json-line\n");
      expect(
        chunks
          .filter((c) => c.stream === "stderr")
          .map((c) => c.chunk)
          .join(""),
      ).toBe("warn\n");
      expect(exit.code).toBe(5);
      expect(exit.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("execStream defaults to a code-0 result when the script queue is empty", async () => {
      const provider = await makeProvider({});
      const sandbox = await provider.create(spec());
      const stream = sandbox.execStream(["echo", "hello"]);

      const chunks: SandboxExecChunk[] = [];
      for await (const chunk of stream.events) chunks.push(chunk);
      const exit = await stream.exited;
      expect(exit.code).toBe(0);
      expect(
        chunks
          .filter((c) => c.stream === "stdout")
          .map((c) => c.chunk)
          .join(""),
      ).not.toBe("");
    });

    it("execStream rejects exited with SANDBOX_TIMEOUT when timeoutMs is exceeded", async () => {
      const provider = await makeProvider({
        execStreams: [{ chunks: [{ stream: "stdout", chunk: "a" }], interChunkDelayMs: 120 }],
      });
      const sandbox = await provider.create(spec());
      const stream = sandbox.execStream(["sleep", "60"], { timeoutMs: 10 });
      const failure = await stream.exited.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(SandboxError);
      expect(failure).toMatchObject({ code: "SANDBOX_TIMEOUT" });
      // The stream must end (no dangling iteration).
      for await (const chunk of stream.events) void chunk;
    });

    it("execStream after stop rejects with SANDBOX_UNAVAILABLE", async () => {
      const provider = await makeProvider({});
      const sandbox = await provider.create(spec());
      await sandbox.stop();
      // Providers may throw synchronously (like `exec`) or reject `exited`.
      const failure = await (async () => {
        try {
          return await sandbox.execStream(["true"]).exited;
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(SandboxError);
      expect(failure).toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
    });

    it("rejects unknown images with SANDBOX_IMAGE_MISSING", async () => {
      const provider = await makeProvider({ knownImages: ["known:latest"] });
      const ok = await provider.create(spec({ image: "known:latest" }));
      expect(ok.meta.image).toBe("known:latest");

      const failure = await provider
        .create(spec({ image: "ghost:latest" }))
        .catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ code: "SANDBOX_IMAGE_MISSING" });
    });

    it("rejects scripted create/stop failures with typed codes", async () => {
      const failing = await makeProvider({ failOnCreate: true });
      const createFailure = await failing.create(spec()).catch((cause: unknown) => cause);
      expect(createFailure).toMatchObject({ code: "SANDBOX_UNAVAILABLE" });

      const provider = await makeProvider({ failOnStop: true });
      const sandbox = await provider.create(spec());
      const stopFailure = await sandbox.stop().catch((cause: unknown) => cause);
      expect(stopFailure).toMatchObject({ code: "SANDBOX_STOP_FAILED" });
    });
  });
}
