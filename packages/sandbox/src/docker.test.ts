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
  docker,
} from "./docker-cli.js";
import { createDockerSandboxProvider } from "./docker.js";
import type { SandboxHandle, SandboxLogEntry, SandboxSpec } from "./types.js";

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
      "127.0.0.1::8080",
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

  it("appends mount consistency and mounts named volumes after bind mounts (#102)", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await provider.create(
      baseSpec({
        mounts: [{ hostPath: "/host/wt", containerPath: "/workspace", consistency: "cached" }],
        volumes: [
          {
            name: "openeuler-cache-p1-workspace-node_modules",
            containerPath: "/workspace/node_modules",
          },
        ],
      }),
    );
    const runArgs = findCall(runner, "run");
    const volumeIndex = runArgs.indexOf("-v");
    expect(volumeIndex).toBeGreaterThan(0);
    expect(runArgs).toContain("/host/wt:/workspace:cached");
    expect(runArgs).toContain("openeuler-cache-p1-workspace-node_modules:/workspace/node_modules");
    // Bind mount comes before the cache volume in the arg vector.
    expect(runArgs.indexOf("/host/wt:/workspace:cached")).toBeLessThan(
      runArgs.indexOf("openeuler-cache-p1-workspace-node_modules:/workspace/node_modules"),
    );
  });

  it("rejects invalid volume names/paths and unknown consistency values (#102)", async () => {
    const runner = new RecordingRunner();
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await expect(
      provider.create(baseSpec({ volumes: [{ name: "-bad", containerPath: "/c" }] })),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    await expect(
      provider.create(baseSpec({ volumes: [{ name: "ok", containerPath: "rel" }] })),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    await expect(
      provider.create(baseSpec({ volumes: [{ name: "ok", containerPath: "/a:b" }] })),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    await expect(
      provider.create(
        baseSpec({
          mounts: [{ hostPath: "/h", containerPath: "/c", consistency: "zfs" as never }],
        }),
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
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

  it("publishes ports on a configurable host via publishHost", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    const provider = createDockerSandboxProvider({
      runner: (a) => runner.run(a),
      publishHost: "192.0.2.10",
    });
    await provider.create(baseSpec({ ports: [8080] }));
    const runArgs = findCall(runner, "run");
    expect(runArgs[runArgs.indexOf("-p") + 1]).toBe("192.0.2.10::8080");
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

  it("rejects image refs that could reach docker's flag parser", async () => {
    const runner = new RecordingRunner();
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    for (const bad of [
      "--privileged", // flag-injection via leading dash
      "-v", // short-flag lookalike
      " img", // leading whitespace
      "img ", // trailing whitespace
      "img\nlatest",
      "IMG:latest", // uppercase repo (conservative lowercase-only grammar)
      "repo/name:has space",
      "re po",
    ]) {
      const failure = await provider.create(baseSpec({ image: bad })).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure, `image "${bad}" must be rejected`).toMatchObject({
        code: "SANDBOX_INVALID_SPEC",
      });
    }
    expect(runner.calls).toEqual([]); // rejected before touching docker
  });

  it("accepts conservative image refs including digests", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner); // first create (also warms the availability cache)
    runner.ok("{}").ok("container-id-456\n").ok(INSPECT_RUNNING); // second create
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await expect(
      provider.create(baseSpec({ image: "reg.example.com/team/worker:1.0_beta-2" })),
    ).resolves.toBeTruthy();
    await expect(
      provider.create(baseSpec({ image: "img:2@sha256:abcdef0123456789" })),
    ).resolves.toBeTruthy();
  });

  it("rejects spec labels in the provider-reserved openeuler.* namespace", async () => {
    const runner = new RecordingRunner();
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await expect(
      provider.create(baseSpec({ labels: { "openeuler.run": "evil" } })),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    await expect(
      provider.create(baseSpec({ labels: { "openeuler.sandbox": "1" } })),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    await expect(
      provider.create(baseSpec({ labels: { "openeuler.custom": "x" } })),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    expect(runner.calls).toEqual([]); // rejected before touching docker
  });

  it("rejects mount paths containing ':' (docker -v separator)", async () => {
    const runner = new RecordingRunner();
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await expect(
      provider.create(
        baseSpec({ mounts: [{ hostPath: "/host:evil", containerPath: "/workspace" }] }),
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    await expect(
      provider.create(baseSpec({ mounts: [{ hostPath: "/host", containerPath: "/work:space" }] })),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    expect(runner.calls).toEqual([]);
  });

  it("validates exec-time env keys like spec env", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(baseSpec());
    await expect(
      sandbox.exec(["true"], { env: { "BAD=KEY": "v" } as Record<string, string> }),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    await expect(
      sandbox.exec(["true"], { env: { "": "v" } as Record<string, string> }),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    expect(runner.calls.some((args) => args[0] === "exec")).toBe(false);
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

  it("best-effort removes the container when post-start inspect fails", async () => {
    const runner = new RecordingRunner();
    runner
      .ok("29.8.1") // probe ok
      .ok("{}") // image present
      .ok("container-id-123\n") // docker run succeeds
      .fail(1, "Error: No such container: vanished"); // inspect fails
    runner.ok("removed"); // best-effort rm -f
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const failure = await provider.create(baseSpec()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_EXEC_FAILED" }); // original error rethrown
    const rmCalls = runner.calls.filter((args) => args[0] === "rm");
    expect(rmCalls).toHaveLength(1);
    expect(rmCalls[0]?.[1]).toBe("-f");
    expect(rmCalls[0]?.[2]).toMatch(/^openeuler-run-1-[a-z0-9]{6}$/); // our leaked container
  });

  it("best-effort removes the container when docker run times out", async () => {
    const runner = new RecordingRunner();
    runner.ok("29.8.1").ok("{}"); // probe + image present
    runner.throw(new DockerCliError("docker run timed out after 30000ms", { timedOut: true }));
    runner.ok("removed"); // best-effort rm -f
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await expect(provider.create(baseSpec())).rejects.toMatchObject({ code: "SANDBOX_TIMEOUT" });
    const rmCalls = runner.calls.filter((args) => args[0] === "rm");
    expect(rmCalls).toHaveLength(1);
    expect(rmCalls[0]?.[2]).toMatch(/^openeuler-run-1-[a-z0-9]{6}$/);
  });

  it("best-effort cleanup swallows its own failure and rethrows the original error", async () => {
    const runner = new RecordingRunner();
    runner.ok("29.8.1").ok("{}").ok("container-id-123\n"); // probe + image + run
    runner.fail(1, "Error: No such container: vanished"); // inspect fails
    runner.throw(new DockerCliError("docker CLI not found in PATH", { failedToSpawn: true })); // rm also fails
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const failure = await provider.create(baseSpec()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_EXEC_FAILED" }); // inspect error, not the rm failure
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

  it("destroy stays retryable when rm fails and succeeds on retry", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    runner.fail(1, "Error: removal went wrong"); // first rm fails
    runner.ok("name"); // retried rm succeeds
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(baseSpec());

    await expect(sandbox.destroy()).rejects.toMatchObject({ code: "SANDBOX_EXEC_FAILED" });
    // Failure did NOT mark the handle destroyed → destroy is retryable.
    await expect(sandbox.destroy()).resolves.toBeUndefined();
    // Now destroyed: idempotent, no further docker calls.
    await expect(sandbox.destroy()).resolves.toBeUndefined();
    expect(runner.calls.filter((args) => args[0] === "rm")).toHaveLength(2);
    await expect(sandbox.exec(["true"])).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
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

  it("stats scopes to provider sandboxes via list() ids", async () => {
    const runner = new RecordingRunner();
    runner.ok(
      `${JSON.stringify({
        Names: "openeuler-run-1-abc123",
        Image: "img:2",
        Labels: "openeuler.sandbox=1,openeuler.image=img:2,openeuler.createdAt=1700000000000",
        State: "running",
      })}\n`,
    );
    runner.ok(
      `${JSON.stringify({
        Name: "openeuler-run-1-abc123",
        CPUPerc: "12.50%",
        MemUsage: "64.0MiB / 256MiB",
      })}\n`,
    );
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const usage = await provider.stats();
    expect(findCall(runner, "stats")).toEqual([
      "stats",
      "--no-stream",
      "--format",
      "json",
      "openeuler-run-1-abc123", // ids from list(), never the whole host
    ]);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ id: "openeuler-run-1-abc123", memoryMb: 64 });
    expect(usage[0]?.cpus ?? 0).toBeGreaterThan(0);
  });

  it("stats returns [] without invoking docker stats when list() is empty", async () => {
    const runner = new RecordingRunner();
    runner.ok(""); // docker ps → no sandboxes
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    await expect(provider.stats()).resolves.toEqual([]);
    expect(runner.calls.some((args) => args[0] === "stats")).toBe(false);
  });

  it("destroy(id) runs docker rm -f; missing containers resolve, failures reject typed (#105)", async () => {
    const runner = new RecordingRunner();
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    runner.ok("openeuler-run-1-abc123\n");
    await provider.destroy?.("openeuler-run-1-abc123");
    expect(findCall(runner, "rm")).toEqual(["rm", "-f", "openeuler-run-1-abc123"]);

    runner.fail(1, "Error response from daemon: No such container: ghost");
    await expect(provider.destroy?.("ghost")).resolves.toBeUndefined();

    runner.fail(1, "driver failure while removing");
    await expect(provider.destroy?.("stuck")).rejects.toMatchObject({
      code: "SANDBOX_EXEC_FAILED",
    });
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

  it("caps per-stream accumulation with a truncation marker and stops reading", async () => {
    // ~100-byte lines in 10KiB chunks, comfortably past the 8 MiB cap.
    const line = `${"x".repeat(99)}\n`;
    const chunk = line.repeat(100);
    const stdoutChunks: string[] = [];
    for (let i = 0; i < 900; i += 1) stdoutChunks.push(chunk); // ~9.2 MiB total
    const provider = logsProvider(stdoutChunks, ["2026-10-03T04:57:41.089908247Z err\n"], 1);
    const sandbox = await provider.create(baseSpec());
    const entries: SandboxLogEntry[] = [];
    for await (const entry of sandbox.logs()) entries.push(entry);

    const stdoutLines = entries.filter((e) => e.stream === "stdout");
    const stdoutBytes = stdoutLines.reduce((sum, e) => sum + e.line.length + 1, 0);
    expect(stdoutBytes).toBeLessThanOrEqual(8 * 1024 * 1024 + 1_000); // bounded, not 9.2 MiB
    expect(stdoutLines[stdoutLines.length - 1]?.line).toMatch(
      /stdout log snapshot truncated at 8388608 bytes/,
    );
    // The other stream still flows through.
    expect(entries.filter((e) => e.stream === "stderr").map((e) => e.line)).toEqual(["err"]);
    // Truncation treats the CLI's broken-pipe exit (here 1) as success.
    expect(entries.some((e) => e.stream === "stdout" && e.line === "x".repeat(99))).toBe(true);
  });

  it("rejects follow:true in v0.2", async () => {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    const provider = createDockerSandboxProvider({ runner: (a) => runner.run(a) });
    const sandbox = await provider.create(baseSpec());
    expect(() => sandbox.logs({ follow: true } as never)).toThrow(SandboxError);
  });

  it("exposes the parsed --timestamps prefix as `at`", async () => {
    const provider = logsProvider(
      ["2026-10-03T04:57:41.089908247Z l1\n", "no-timestamp-line\n"],
      [],
      0,
    );
    const sandbox = await provider.create(baseSpec());
    const entries: SandboxLogEntry[] = [];
    for await (const entry of sandbox.logs()) entries.push(entry);
    expect(entries[0]).toMatchObject({ line: "l1", at: Date.parse("2026-10-03T04:57:41.089Z") });
    expect(entries[1]).toMatchObject({ line: "no-timestamp-line" });
    expect(entries[1]?.at).toBeUndefined();
  });
});

describe("docker execStream (fake spawner, #104)", () => {
  /**
   * Scripted exec source: writes chunks (with optional pauses), then closes.
   * Writing starts only when the FIRST listener attaches (constructing the
   * source and calling `execStream` are separated by an `await` — a
   * construction-time microtask would emit before listeners exist). A
   * `spawnError` is likewise emitted after attachment (EventEmitter rethrows
   * unhandled 'error' events).
   */
  function fakeExecSource(
    script:
      | { stdout: string[]; stderr: string[]; exitCode: number; chunkDelayMs?: number }
      | { spawnError: Error },
  ): DockerLogsSource & { killCalls: string[] } {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = new EventEmitter();
    const killCalls: string[] = [];
    let started = false;
    const start = (): void => {
      if (started) return;
      started = true;
      if ("spawnError" in script) {
        const err = script.spawnError;
        queueMicrotask(() => emitter.emit("error", err));
        return;
      }
      queueMicrotask(() => {
        const writeAll = async (): Promise<void> => {
          for (const chunk of script.stdout) {
            stdout.write(chunk);
            if (script.chunkDelayMs) await new Promise((r) => setTimeout(r, script.chunkDelayMs));
          }
          stdout.end();
          for (const chunk of script.stderr) stderr.write(chunk);
          stderr.end();
        };
        void writeAll().then(() => emitter.emit("close", script.exitCode));
      });
    };
    const source: DockerLogsSource & { killCalls: string[] } = {
      stdout,
      stderr,
      on(event, listener) {
        start();
        emitter.on(event, listener as (...args: unknown[]) => void);
        return undefined;
      },
      kill(signal?: NodeJS.Signals) {
        killCalls.push(signal ?? "default");
        stdout.destroy();
        stderr.destroy();
        emitter.emit("close", null);
      },
      killCalls,
    };
    return source;
  }

  function streamProvider(
    source: ReturnType<typeof fakeExecSource>,
    calls: string[][] = [],
  ): {
    provider: ReturnType<typeof createDockerSandboxProvider>;
    runner: RecordingRunner;
    calls: string[][];
  } {
    const runner = new RecordingRunner();
    scriptCreate(runner);
    const provider = createDockerSandboxProvider({
      runner: (a) => runner.run(a),
      execSpawner: (args) => {
        calls.push([...args]);
        return source;
      },
    });
    return { provider, runner, calls };
  }

  const collectChunks = async (
    stream: ReturnType<SandboxHandle["execStream"]>,
  ): Promise<Array<{ stream: string; chunk: string }>> => {
    const chunks: Array<{ stream: string; chunk: string }> = [];
    for await (const chunk of stream.events) {
      chunks.push({ stream: chunk.stream, chunk: chunk.chunk });
    }
    return chunks;
  };

  it("spawns docker exec with cwd/env args and streams both pipes live", async () => {
    const calls: string[][] = [];
    const source = fakeExecSource({
      stdout: ['{"type":"text"', "…\n"],
      stderr: ["warn\n"],
      exitCode: 7,
      chunkDelayMs: 30,
    });
    const { provider, calls: spawned } = streamProvider(source, calls);
    const sandbox = await provider.create(baseSpec());
    const stream = sandbox.execStream(["opencode", "run", "p"], {
      cwd: "/workspace",
      env: { TOKEN: "x" },
    });

    // LIVE delivery: the first chunk arrives while the source is still open
    // (the second chunk waits chunkDelayMs), i.e. before close.
    const first = await stream.events[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ stream: "stdout", chunk: '{"type":"text"' });

    const rest: Array<{ stream: string; chunk: string }> = [];
    for await (const chunk of stream.events)
      rest.push({ stream: chunk.stream, chunk: chunk.chunk });
    const exit = await stream.exited;
    expect(rest).toEqual([
      { stream: "stdout", chunk: "…\n" },
      { stream: "stderr", chunk: "warn\n" },
    ]);
    expect(exit).toMatchObject({ code: 7 });
    expect(exit.durationMs).toBeGreaterThanOrEqual(0);
    expect(spawned).toEqual([
      ["exec", "-w", "/workspace", "-e", "TOKEN=x", sandbox.id, "opencode", "run", "p"],
    ]);
  });

  it("rejects exited with SANDBOX_TIMEOUT and kills the CLI when timeoutMs fires", async () => {
    // One chunk, then the source stays open (5s pause before close): the
    // 20ms exec timeout must fire first and SIGKILL the CLI.
    const source = fakeExecSource({ stdout: ["x"], stderr: [], exitCode: 0, chunkDelayMs: 5_000 });
    const { provider } = streamProvider(source);
    const sandbox = await provider.create(baseSpec());
    const stream = sandbox.execStream(["sleep", "60"], { timeoutMs: 20 });
    const failure = await stream.exited.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_TIMEOUT" });
    expect(source.killCalls).toContain("SIGKILL");
    for await (const chunk of stream.events) void chunk; // iteration ends
  });

  it("maps not-running stderr on close to SANDBOX_UNAVAILABLE", async () => {
    const source = fakeExecSource({
      stdout: [],
      stderr: ["Error response from daemon: container x is not running\n"],
      exitCode: 1,
    });
    const { provider } = streamProvider(source);
    const sandbox = await provider.create(baseSpec());
    const stream = sandbox.execStream(["true"]);
    const failure = await stream.exited.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
  });

  it("maps CLI spawn errors to SANDBOX_UNAVAILABLE", async () => {
    const source = fakeExecSource({ spawnError: new Error("ENOENT docker") });
    const { provider } = streamProvider(source);
    const sandbox = await provider.create(baseSpec());
    const stream = sandbox.execStream(["true"]);
    const failure = await stream.exited.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
    await collectChunks(stream);
  });

  it("cancel() kills the CLI, ends events and rejects exited", async () => {
    const source = fakeExecSource({ stdout: ["x"], stderr: [], exitCode: 0, chunkDelayMs: 60_000 });
    const { provider } = streamProvider(source);
    const sandbox = await provider.create(baseSpec());
    const stream = sandbox.execStream(["stuck"]);
    stream.cancel?.();
    const failure = await stream.exited.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
    expect(source.killCalls).toContain("SIGKILL");
    await collectChunks(stream);
  });

  it("throws synchronously for invalid cmds and stopped sandboxes", async () => {
    const source = fakeExecSource({ stdout: [], stderr: [], exitCode: 0 });
    const { provider, runner } = streamProvider(source);
    const sandbox = await provider.create(baseSpec());
    expect(() => sandbox.execStream([])).toThrow(SandboxError);
    runner.ok(""); // docker stop
    await sandbox.stop();
    expect(() => sandbox.execStream(["true"])).toThrow(/not running/);
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

describe("docker CLI error hygiene (argv redaction, maxBuffer)", () => {
  it("redacts -e values in argv summaries used for error messages", async () => {
    const args = ["exec", "-e", "TOKEN=hunter2", "-e", "PLAIN", "sandbox-1", "env"];
    const failure = await docker(args, {
      runner: async () => {
        throw new DockerCliError("docker exec timed out after 5ms", {
          timedOut: true,
          args,
        });
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_TIMEOUT" });
    const message = (failure as SandboxError).message;
    expect(message).toContain("-e TOKEN=***");
    expect(message).toContain("-e ***"); // value-less -e arg fully redacted
    expect(message).not.toContain("hunter2");
  });

  it("maps maxBuffer overflow to SANDBOX_EXEC_FAILED with a size message", async () => {
    const args = ["logs", "--timestamps", "sandbox-1"];
    const failure = await docker(args, {
      runner: async () => {
        throw new DockerCliError(
          "docker logs --timestamps sandbox-1 output exceeded maxBuffer (33554432 bytes)",
          { maxBufferExceeded: true, args },
        );
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_EXEC_FAILED" });
    const message = (failure as SandboxError).message;
    expect(message).toContain("33554432");
    expect(message).toContain("maxBuffer");
  });
});
