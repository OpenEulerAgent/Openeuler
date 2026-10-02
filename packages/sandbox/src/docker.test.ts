import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SandboxError } from "./error.js";
import {
  DockerCliError,
  type DockerCliResult,
  type DockerLogsSource,
  createDockerAvailabilityProbe,
  defaultDockerCliRunner,
} from "./docker-cli.js";
import { createDockerSandboxProvider } from "./docker.js";
import type { SandboxHandle, SandboxSpec } from "./types.js";

/**
 * Records every invocation and serves scripted results FIFO (its `run`
 * method is what the provider consumes as a DockerCliRunner); scripted
 * errors are thrown as DockerCliError.
 */
class RecordingRunner {
  readonly calls: string[][] = [];
  private readonly handlers: Array<
    (args: readonly string[]) => DockerCliResult | Promise<DockerCliResult>
  > = [];

  ok(stdout = ""): this {
    return this.push(() => ({ code: 0, stdout, stderr: "" }));
  }

  fail(code: number, stderr: string): this {
    return this.push(() => ({ code, stdout: "", stderr }));
  }

  throw(error: DockerCliError): this {
    return this.push(() => {
      throw error;
    });
  }

  push(handler: (args: readonly string[]) => DockerCliResult | Promise<DockerCliResult>): this {
    this.handlers.push(handler);
    return this;
  }

  async run(args: readonly string[], _options?: { timeoutMs?: number }): Promise<DockerCliResult> {
    void _options;
    this.calls.push([...args]);
    const handler = this.handlers.shift();
    if (handler === undefined) {
      throw new Error(`unexpected docker call: docker ${args.join(" ")}`);
    }
    return handler(args);
  }
}

const INSPECT_RUNNING = JSON.stringify([
  {
    State: { Status: "running" },
    NetworkSettings: {
      Ports: {
        "8080/tcp": [
          { HostIp: "0.0.0.0", HostPort: "32771" },
          { HostIp: "::", HostPort: "32771" },
        ],
      },
    },
  },
]);

/** Happy-path create() script: probe → image present → (network) → run → inspect. */
function scriptCreate(runner: RecordingRunner, options: { limited?: boolean } = {}): void {
  runner.ok("29.8.1"); // docker info (availability probe)
  runner.ok("{}"); // docker image inspect → present, no pull
  if (options.limited) runner.ok("[]"); // docker network inspect → exists
  runner.ok("container-id-123\n"); // docker run
  runner.ok(INSPECT_RUNNING); // docker inspect for port bindings
}

function baseSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return { runId: "run-1", image: "img:2", mounts: [], env: {}, ...overrides };
}

function findCall(runner: RecordingRunner, head: string): string[] {
  const match = runner.calls.find((args) => args[0] === head);
  if (match === undefined) throw new Error(`no docker ${head} call recorded`);
  return match;
}

describe("docker provider unit (fake CLI runner)", () => {
  it("builds the exact docker run argument vector", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner, { limited: true });
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(
      baseSpec({
        mounts: [{ hostPath: "/host/wt", containerPath: "/workspace", readonly: true }],
        env: { K: "V=X" },
        ports: [8080],
        resources: { memoryMb: 256, cpus: 1.5 },
        network: "limited",
        labels: { team: "core" },
      }),
    );

    const runArgs = findCall(runner, "run");
    const createdAtIndex = runArgs.findIndex((arg) => arg.startsWith("openeuler.createdAt="));
    expect(createdAtIndex).toBeGreaterThan(0);
    const createdAt = runArgs[createdAtIndex]?.split("=")[1] ?? "";
    expect(createdAt).toMatch(/^\d+$/);
    expect(runArgs).toEqual([
      "run",
      "-d",
      "--init",
      "--name",
      expect.stringMatching(/^openeuler-run-1-[a-z0-9]{6}$/) as unknown as string,
      "--label",
      "openeuler.sandbox=1",
      "--label",
      "openeuler.run=run-1",
      "--label",
      "openeuler.image=img:2",
      "--label",
      `openeuler.createdAt=${createdAt}`,
      "--label",
      "team=core",
      "--log-driver=json-file",
      "-w",
      "/workspace",
      "-v",
      "/host/wt:/workspace:ro",
      "-e",
      "K=V=X",
      "-p",
      "8080",
      "--memory=256m",
      "--cpus=1.5",
      "--network",
      "openeuler-limited",
      "img:2",
      "tail",
      "-f",
      "/dev/null",
    ]);
    expect(sandbox.id).toMatch(/^openeuler-run-1-[a-z0-9]{6}$/);
    expect(sandbox.meta).toMatchObject({ image: "img:2", ports: [8080] });
    expect(sandbox.meta.createdAt).toBeGreaterThan(0);
  });

  it("omits -w without mounts and uses spec workingDir when given", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await provider.create(baseSpec());
    expect(findCall(runner, "run")).not.toContain("-w");

    const runner2 = new RecordingRunner();
    scriptCreate(runner2);
    const provider2 = createDockerSandboxProvider({ runner: (a) => runner2.run(a) });
    await provider2.create(baseSpec({ workingDir: "/srv/app" }));
    const runArgs = findCall(runner2, "run");
    expect(runArgs[runArgs.indexOf("-w") + 1]).toBe("/srv/app");
  });

  it("uses a custom idle command", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    const provider = createDockerSandboxProvider({
      runner: (a) => runner.run(a),
      idleCommand: ["sleep", "1000"],
    });
    await provider.create(baseSpec());
    expect(findCall(runner, "run").slice(-3)).toEqual(["img:2", "sleep", "1000"]);
  });

  it("adds --network none for isolated sandboxes", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await provider.create(baseSpec({ network: "none" }));
    const runArgs = findCall(runner, "run");
    expect(runArgs[runArgs.indexOf("--network") + 1]).toBe("none");
  });

  it("rejects relative mount host paths with a typed validation error", async () => {
    const runner = new RecordingRunner();
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const failure = await provider
      .create(baseSpec({ mounts: [{ hostPath: "relative/path", containerPath: "/workspace" }] }))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    expect(runner.calls).toEqual([]); // rejected before touching docker
  });

  it("rejects relative container paths, empty images, and bad ports", async () => {
    const runner = new RecordingRunner();
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await expect(
      provider.create(baseSpec({ mounts: [{ hostPath: "/h", containerPath: "c" }] })),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    await expect(provider.create(baseSpec({ image: "" }))).rejects.toMatchObject({
      code: "SANDBOX_IMAGE_MISSING",
    });
    await expect(provider.create(baseSpec({ ports: [0] }))).rejects.toMatchObject({
      code: "SANDBOX_INVALID_SPEC",
    });
    await expect(provider.create(baseSpec({ network: "none", ports: [80] }))).rejects.toMatchObject(
      { code: "SANDBOX_INVALID_SPEC" },
    );
  });

  it("maps daemon-down output to SANDBOX_UNAVAILABLE", async () => {
    const runner = new RecordingRunner();
    runner
      .ok("29.8.1") // probe ok
      .ok("{}") // image present
      .fail(
        125,
        "docker: Error response from daemon: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?.",
      );
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await expect(provider.create(baseSpec())).rejects.toMatchObject({
      code: "SANDBOX_UNAVAILABLE",
    });
  });

  it("maps image-missing run output to SANDBOX_IMAGE_MISSING", async () => {
    const runner = new RecordingRunner();
    runner
      .ok("29.8.1")
      .ok("{}")
      .fail(
        125,
        "docker: Error response from daemon: pull access denied for ghost, repository does not exist or may require 'docker login'",
      );
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await expect(provider.create(baseSpec())).rejects.toMatchObject({
      code: "SANDBOX_IMAGE_MISSING",
    });
  });

  it("pulls a missing image and maps pull failure to SANDBOX_IMAGE_MISSING", async () => {
    const runner = new RecordingRunner();
    runner
      .ok("29.8.1")
      .fail(1, "Error: No such image: img:2") // inspect → missing
      .fail(1, "Error response from daemon: manifest for img:2 not found: manifest unknown");
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await expect(provider.create(baseSpec())).rejects.toMatchObject({
      code: "SANDBOX_IMAGE_MISSING",
    });
    expect(findCall(runner, "pull")).toEqual(["pull", "img:2"]);
  });

  it("skips the pull when the image already exists locally (never-if-exists)", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await provider.create(baseSpec());
    expect(runner.calls.some((args) => args[0] === "pull")).toBe(false);
  });

  it("creates the limited bridge on demand and tolerates a create race", async () => {
    const runner = new RecordingRunner();
    runner
      .ok("29.8.1")
      .ok("{}")
      .fail(1, "Error: No such network: openeuler-limited") // inspect → missing
      .fail(1, "Error response from daemon: network with name openeuler-limited already exists")
      .ok("container-id-123\n")
      .ok(INSPECT_RUNNING);
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(baseSpec({ network: "limited" }));
    const networkCreate = runner.calls.find(
      (args) => args[0] === "network" && args[1] === "create",
    );
    expect(networkCreate).toEqual(["network", "create", "--driver", "bridge", "openeuler-limited"]);
    expect(sandbox.id).toMatch(/^openeuler-run-1-[a-z0-9]{6}$/);
  });

  it("surfaces other run failures as SANDBOX_EXEC_FAILED with a stderr tail", async () => {
    const runner = new RecordingRunner();
    runner
      .ok("29.8.1")
      .ok("{}")
      .fail(125, `docker: some obscure failure\n${"x".repeat(900)}`);
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const failure = await provider.create(baseSpec()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_EXEC_FAILED" });
    expect((failure as SandboxError).message).toContain("…"); // truncated tail marker
    expect((failure as SandboxError).message.length).toBeLessThan(600);
  });

  it("fails fast with SANDBOX_UNAVAILABLE when the docker CLI cannot spawn", async () => {
    const runner = new RecordingRunner();
    runner.throw(new DockerCliError("docker CLI not found in PATH", { failedToSpawn: true }));
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await expect(provider.create(baseSpec())).rejects.toMatchObject({
      code: "SANDBOX_UNAVAILABLE",
    });
  });

  it("maps CLI timeouts to SANDBOX_TIMEOUT", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    runner.throw(new DockerCliError("docker exec timed out after 5ms", { timedOut: true }));
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(baseSpec());
    await expect(sandbox.exec(["sleep", "60"], { timeoutMs: 5 })).rejects.toMatchObject({
      code: "SANDBOX_TIMEOUT",
    });
    expect(findCall(runner, "exec")).toEqual(["exec", sandbox.id, "sleep", "60"]);
  });

  it("builds exec args with cwd and per-call env", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    runner.ok("out\n"); // docker exec result
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(baseSpec());
    const result = await sandbox.exec(["echo", "hi"], { cwd: "/tmp", env: { A: "B=C" } });
    expect(result).toMatchObject({ code: 0, stdout: "out\n" });
    expect(typeof result.durationMs).toBe("number");
    expect(findCall(runner, "exec")).toEqual([
      "exec",
      "-w",
      "/tmp",
      "-e",
      "A=B=C",
      sandbox.id,
      "echo",
      "hi",
    ]);
  });

  it("treats non-zero exec exit codes as results, not errors", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    runner.fail(42, "boom\n"); // docker exec exits 42
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(baseSpec());
    await expect(sandbox.exec(["false"])).resolves.toMatchObject({
      code: 42,
      stderr: "boom\n",
    });
  });

  it("maps exec-on-stopped-container output to SANDBOX_UNAVAILABLE", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    runner.fail(1, "Error response from daemon: container abc123 is not running");
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(baseSpec());
    await expect(sandbox.exec(["true"])).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
  });

  it("stop/destroy build the right args and destroy is idempotent", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    runner.ok("name"); // docker stop
    runner.ok("name"); // docker rm -f
    runner.fail(1, "Error: No such container: gone"); // second destroy (idempotent)
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(baseSpec());

    await sandbox.stop();
    expect(findCall(runner, "stop")).toEqual(["stop", "-t", "10", sandbox.id]);

    await sandbox.destroy();
    expect(findCall(runner, "rm")).toEqual(["rm", "-f", sandbox.id]);

    await expect(sandbox.destroy()).resolves.toBeUndefined(); // missing container = ok
    await expect(sandbox.exec(["true"])).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
    await expect(sandbox.hostPorts()).resolves.toEqual({});
  });

  it("stop with explicit grace maps to -t seconds and failures to STOP_FAILED", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    runner.fail(1, "Error response from daemon: stop went wrong");
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(baseSpec());
    await expect(sandbox.stop(1500)).rejects.toMatchObject({ code: "SANDBOX_STOP_FAILED" });
    expect(findCall(runner, "stop").slice(0, 3)).toEqual(["stop", "-t", "2"]);
  });

  it("hostPorts parses IPv4 bindings from docker inspect", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(baseSpec({ ports: [8080] }));
    await expect(sandbox.hostPorts()).resolves.toEqual({ 8080: 32771 });
    await expect(sandbox.hostPorts()).resolves.toEqual({ 8080: 32771 }); // cached, stable
  });

  it("list builds label filters and parses docker ps json rows", async () => {
    const runner = new RecordingRunner();
    runner.ok(
      [
        JSON.stringify({
          Names: "openeuler-run-1-abc123",
          Image: "img:2",
          Labels:
            "openeuler.sandbox=1,openeuler.run=run-1,openeuler.image=img:2,openeuler.createdAt=1700000000000,team=core",
          State: "running",
        }),
        JSON.stringify({
          Names: "openeuler-run-2-def456",
          Image: "other:9",
          Labels: "openeuler.sandbox=1,openeuler.run=run-2,openeuler.createdAt=1700000001000",
          State: "exited",
        }),
      ].join("\n"),
    );
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const summaries = await provider.list({ team: "core" });
    expect(findCall(runner, "ps")).toEqual([
      "ps",
      "-a",
      "--filter",
      "label=openeuler.sandbox=1",
      "--filter",
      "label=team=core",
      "--format",
      "json",
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: "openeuler-run-1-abc123",
      image: "img:2",
      status: "running",
      createdAt: 1700000000000,
      labels: { team: "core" }, // provider-owned labels stripped
    });
  });

  it("stats parses docker stats json rows", async () => {
    const runner = new RecordingRunner();
    runner.ok(
      `${JSON.stringify({
        Name: "openeuler-run-1-abc123",
        CPUPerc: "12.50%",
        MemUsage: "64.0MiB / 256MiB",
      })}\n`,
    );
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const usage = await provider.stats();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ id: "openeuler-run-1-abc123", memoryMb: 64 });
    expect(usage[0]?.cpus ?? 0).toBeGreaterThan(0);
  });
});

describe("docker logs demux (fake spawner)", () => {
  function fakeLogsSource(
    stdoutChunks: string[],
    stderrChunks: string[],
    exitCode: number,
  ): DockerLogsSource {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = new EventEmitter();
    const source: DockerLogsSource = {
      stdout,
      stderr,
      on(event, listener) {
        emitter.on(event, listener as (...args: unknown[]) => void);
        return undefined;
      },
    };
    let streamsClosed = 0;
    const maybeClose = (): void => {
      if (streamsClosed === 2) emitter.emit("close", exitCode);
    };
    stdout.on("close", () => {
      streamsClosed += 1;
      maybeClose();
    });
    stderr.on("close", () => {
      streamsClosed += 1;
      maybeClose();
    });
    queueMicrotask(() => {
      for (const chunk of stdoutChunks) stdout.write(chunk);
      stdout.end();
      for (const chunk of stderrChunks) stderr.write(chunk);
      stderr.end();
    });
    return source;
  }

  function logsProvider(
    stdoutChunks: string[],
    stderrChunks: string[],
    exitCode: number,
  ): ReturnType<typeof createDockerSandboxProvider> {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    return createDockerSandboxProvider({
      runner: (a) => runner.run(a),
      logsSpawner: () => fakeLogsSource(stdoutChunks, stderrChunks, exitCode),
    });
  }

  async function collect(handle: SandboxHandle): Promise<string[]> {
    const lines: string[] = [];
    for await (const entry of handle.logs()) lines.push(`${entry.stream}:${entry.line}`);
    return lines;
  }

  it("demultiplexes stdout/stderr streams and strips --timestamps prefixes", async () => {
    const provider = logsProvider(
      ["2026-10-03T04:57:41.089908247Z l1\n", "2026-10-03T04:57:41.090908247Z l3\n"],
      ["2026-10-03T04:57:41.089908248Z l2\n"],
      0,
    );
    const sandbox = await provider.create(baseSpec());
    const lines = await collect(sandbox);
    expect(lines).toContain("stdout:l1");
    expect(lines).toContain("stdout:l3");
    expect(lines).toContain("stderr:l2");
    expect(lines).toHaveLength(3);
    expect(lines.filter((line) => line.startsWith("stdout"))).toEqual(["stdout:l1", "stdout:l3"]); // per-stream order pinned
  });

  it("passes --tail and --since flags", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    const spawnerCalls: string[][] = [];
    const provider = createDockerSandboxProvider({
      runner: (a) => runner.run(a),
      logsSpawner: (args) => {
        spawnerCalls.push([...args]);
        return fakeLogsSource([], [], 0);
      },
    });
    const sandbox = await provider.create(baseSpec());
    const since = Date.parse("2026-10-03T00:00:00.000Z");
    await collect(sandbox);
    for await (const entry of sandbox.logs({ tail: 5, since })) void entry;
    expect(spawnerCalls).toHaveLength(2);
    expect(spawnerCalls[0]).toEqual(["logs", "--timestamps", sandbox.id]);
    expect(spawnerCalls[1]).toEqual([
      "logs",
      "--timestamps",
      "--tail",
      "5",
      "--since",
      new Date(since).toISOString(),
      sandbox.id,
    ]);
  });

  it("resolves to an empty stream when the container vanished externally", async () => {
    const provider = logsProvider([], ["Error: No such container: gone\n"], 1);
    const sandbox = await provider.create(baseSpec());
    await expect(collect(sandbox)).resolves.toEqual([]);
  });

  it("rejects with SANDBOX_EXEC_FAILED on other docker logs failures", async () => {
    const provider = logsProvider([], ["something broke\n"], 1);
    const sandbox = await provider.create(baseSpec());
    const failure = await collect(sandbox).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_EXEC_FAILED" });
  });

  it("rejects follow:true in v0.2", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(baseSpec());
    expect(() => sandbox.logs({ follow: true } as never)).toThrow(SandboxError);
  });
});

describe("docker availability probe", () => {
  it("caches the probe result for the TTL", async () => {
    const runner = new RecordingRunner();
    runner.ok("29.8.1").ok("29.8.1");
    const probe = createDockerAvailabilityProbe((a) => runner.run(a), 60_000);
    await expect(probe.check()).resolves.toBe(true);
    await expect(probe.check()).resolves.toBe(true);
    expect(runner.calls).toHaveLength(1); // second hit served from cache

    await expect(probe.check({ force: true })).resolves.toBe(true);
    expect(runner.calls).toHaveLength(2);
  });

  it("expires the cache after the TTL", async () => {
    const runner = new RecordingRunner();
    runner.ok("29.8.1").ok("29.8.1");
    const probe = createDockerAvailabilityProbe((a) => runner.run(a), 5);
    await expect(probe.check()).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(probe.check()).resolves.toBe(true);
    expect(runner.calls).toHaveLength(2);
  });

  it("reports false when docker info exits non-zero", async () => {
    const runner = new RecordingRunner();
    runner.fail(1, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
    const probe = createDockerAvailabilityProbe((a) => runner.run(a));
    await expect(probe.check()).resolves.toBe(false);
  });

  it("default runner surfaces structured DockerCliError on spawn failure", async () => {
    const failure = await defaultDockerCliRunner(["info"], { timeoutMs: 1 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Either a real timeout or (with a broken PATH) a spawn failure — both
    // must surface as structured DockerCliError, never a raw child_process error.
    expect(failure).toBeInstanceOf(DockerCliError);
  });
});
