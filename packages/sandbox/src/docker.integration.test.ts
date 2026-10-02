import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxError } from "./error.js";
import { createDockerAvailabilityProbe, docker } from "./docker-cli.js";
import { createDockerSandboxProvider, type DockerSandboxProvider } from "./docker.js";
import type { SandboxHandle, SandboxSpec } from "./types.js";

const BUSYBOX = "busybox:1.36";
const TEST_TAG = "docker-integration";

const dockerLive =
  process.env.DOCKER_E2E === "0"
    ? false
    : await createDockerAvailabilityProbe().check({ force: true });

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    runId: "run-docker-it",
    image: BUSYBOX,
    mounts: [],
    env: {},
    labels: { "openeuler.test": TEST_TAG },
    ...overrides,
  };
}

const handles: SandboxHandle[] = [];

function provider(): DockerSandboxProvider {
  return createDockerSandboxProvider();
}

async function track(handlePromise: Promise<SandboxHandle>): Promise<SandboxHandle> {
  const handle = await handlePromise;
  handles.push(handle);
  return handle;
}

describe.skipIf(!dockerLive)("docker provider integration (real daemon)", () => {
  beforeAll(async () => {
    const present = await docker(["image", "inspect", BUSYBOX], { timeoutMs: 30_000 });
    if (present.code !== 0) {
      const pull = await docker(["pull", BUSYBOX], { timeoutMs: 300_000 });
      if (pull.code !== 0) throw new Error(`failed to pull ${BUSYBOX}: ${pull.stderr}`);
    }
  });

  it("exec returns real code/stdout/stderr and honors spec env + workingDir", async () => {
    const sandbox = await track(
      provider().create(spec({ env: { FROM_SPEC: "yes" }, workingDir: "/tmp" })),
    );
    const result = await sandbox.exec(["sh", "-c", "pwd; echo $FROM_SPEC; echo $ONLY_EXEC"], {
      env: { ONLY_EXEC: "2" },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("/tmp\nyes\n2\n");
    expect(result.stderr).toBe("");

    const failing = await sandbox.exec(["sh", "-c", "echo oops >&2; exit 3"]);
    expect(failing.code).toBe(3);
    expect(failing.stderr).toBe("oops\n");
    await sandbox.destroy();
  });

  it("bind-mounts host dirs (read-only enforced) and defaults -w to /workspace", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "openeuler-mount-"));
    await writeFile(join(hostDir, "hello.txt"), "mounted-content\n");
    try {
      const sandbox = await track(
        provider().create(
          spec({
            mounts: [{ hostPath: hostDir, containerPath: "/workspace", readonly: true }],
          }),
        ),
      );
      const read = await sandbox.exec(["cat", "/workspace/hello.txt"]);
      expect(read).toMatchObject({ code: 0, stdout: "mounted-content\n" });

      const where = await sandbox.exec(["sh", "-c", "pwd"]);
      expect(where.stdout.trim()).toBe("/workspace");

      const write = await sandbox.exec(["sh", "-c", "touch /workspace/new.txt"]);
      expect(write.code).not.toBe(0); // read-only bind refuses the write
      await sandbox.destroy();
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("publishes ports and serves HTTP from inside the container", async () => {
    const sandbox = await track(provider().create(spec({ ports: [8080] })));
    const ports = await sandbox.hostPorts();
    expect(Object.keys(ports)).toEqual(["8080"]);
    const hostPort = ports[8080];
    expect(hostPort).toBeGreaterThan(0);

    // busybox httpd daemonizes; serve /tmp so GET / answers 404/200, not ECONNREFUSED.
    const start = await sandbox.exec(["httpd", "-p", "8080", "-h", "/tmp"]);
    expect(start.code).toBe(0);

    const response = await fetch(`http://127.0.0.1:${hostPort}/`);
    expect([200, 403, 404]).toContain(response.status);
    await response.body?.cancel();
    await sandbox.destroy();
  });

  it("applies resource limits (asserted via docker inspect)", async () => {
    const sandbox = await track(
      provider().create(spec({ resources: { memoryMb: 256, cpus: 1.5 } })),
    );
    const inspect = await docker(
      ["inspect", sandbox.id, "--format", "{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}"],
      { timeoutMs: 30_000 },
    );
    expect(inspect.code).toBe(0);
    const match = /^(\d+) (\d+)$/.exec(inspect.stdout.trim());
    expect(match).not.toBeNull();
    expect(Number.parseInt(match?.[1] ?? "0", 10)).toBe(256 * 1024 * 1024);
    expect(Number.parseInt(match?.[2] ?? "0", 10)).toBe(1_500_000_000);
    await sandbox.destroy();
  });

  it("network none blocks egress and DNS", async () => {
    const sandbox = await track(provider().create(spec({ network: "none" })));
    const wget = await sandbox.exec(
      ["wget", "-q", "-O", "/dev/null", "-T", "3", "-t", "1", "http://1.1.1.1/"],
      { timeoutMs: 20_000 },
    );
    expect(wget.code).not.toBe(0);
    const dns = await sandbox.exec(["nslookup", "example.com"], { timeoutMs: 20_000 });
    expect(dns.code).not.toBe(0);
    await sandbox.destroy();
  });

  it("network default allows egress", async () => {
    const sandbox = await track(provider().create(spec()));
    const wget = await sandbox.exec(
      ["wget", "-q", "-O", "/dev/null", "-T", "10", "http://example.com/"],
      { timeoutMs: 30_000 },
    );
    expect(wget.code).toBe(0);
    await sandbox.destroy();
  });

  it("network limited uses the dedicated bridge: DNS resolves (egress NOT filtered in v0.2)", async () => {
    const sandbox = await track(provider().create(spec({ network: "limited" })));
    const dns = await sandbox.exec(["nslookup", "example.com"], { timeoutMs: 20_000 });
    expect(dns.code).toBe(0); // embedded DNS works on the custom bridge

    const inspect = await docker(
      ["inspect", sandbox.id, "--format", "{{.HostConfig.NetworkMode}}"],
      { timeoutMs: 30_000 },
    );
    expect(inspect.stdout.trim()).toBe("openeuler-limited");
    await sandbox.destroy();
  });

  it("logs snapshots demux per stream, honoring tail and since", async () => {
    const logsProvider = createDockerSandboxProvider({
      idleCommand: ["sh", "-c", "echo out-1; echo err-1 >&2; echo out-2; exec tail -f /dev/null"],
    });
    const sandbox = await track(logsProvider.create(spec()));
    const entries: Array<{ stream: string; line: string }> = [];
    for await (const entry of sandbox.logs()) entries.push(entry);
    const stdoutLines = entries.filter((e) => e.stream === "stdout").map((e) => e.line);
    const stderrLines = entries.filter((e) => e.stream === "stderr").map((e) => e.line);
    expect(stdoutLines).toEqual(["out-1", "out-2"]);
    expect(stderrLines).toEqual(["err-1"]);

    const tailed: string[] = [];
    for await (const entry of sandbox.logs({ tail: 2 })) tailed.push(entry.line);
    expect(tailed).toHaveLength(2);

    const future: string[] = [];
    for await (const entry of sandbox.logs({ since: Date.now() + 60_000 })) future.push(entry.line);
    expect(future).toEqual([]);
    await sandbox.destroy();
  });

  it("stop transitions to stopped and destroy removes the container", async () => {
    const sandbox = await track(provider().create(spec()));
    expect(await sandbox.status()).toBe("running");

    await sandbox.stop(2_000);
    expect(await sandbox.status()).toBe("stopped");
    const state = await docker(["inspect", sandbox.id, "--format", "{{.State.Status}}"], {
      timeoutMs: 30_000,
    });
    expect(state.stdout.trim()).toBe("exited"); // docker-side truth

    await sandbox.destroy();
    const remaining = await docker(
      [
        "ps",
        "-aq",
        "--filter",
        `label=openeuler.test=${TEST_TAG}`,
        "--filter",
        `name=${sandbox.id}`,
      ],
      { timeoutMs: 30_000 },
    );
    expect(remaining.stdout.trim()).toBe("");
  });

  it("rejects a genuinely missing image with SANDBOX_IMAGE_MISSING", async () => {
    const ghost = `busybox:1.36-missing-${randomBytes(4).toString("hex")}`;
    const failure = await provider()
      .create(spec({ image: ghost, labels: { "openeuler.test": TEST_TAG } }))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "SANDBOX_IMAGE_MISSING" });
  });

  it("list reports only provider-managed containers (orphan query)", async () => {
    const mine = await track(
      provider().create(spec({ labels: { "openeuler.test": TEST_TAG, run: "mine" } })),
    );
    const orphanName = `openeuler-orphan-${randomBytes(3).toString("hex")}`;
    const orphan = await docker(["run", "--name", orphanName, BUSYBOX, "true"], {
      timeoutMs: 60_000,
    });
    expect(orphan.code).toBe(0); // no openeuler labels

    try {
      const all = await provider().list();
      const ids = all.map((summary) => summary.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(orphanName);

      const mineSummary = all.find((summary) => summary.id === mine.id);
      expect(mineSummary).toMatchObject({
        image: BUSYBOX,
        status: "running",
        labels: { run: "mine" },
        createdAt: mine.meta.createdAt,
      });

      expect(await provider().list({ run: "mine" })).toHaveLength(1);
      expect(await provider().list({ run: "not-a-run" })).toEqual([]);
    } finally {
      await docker(["rm", "-f", orphanName], { timeoutMs: 30_000 });
      await mine.destroy();
    }
  });

  it("stats reports live usage for running sandboxes", async () => {
    const sandbox = await track(provider().create(spec()));
    const usage = await provider().stats();
    const mine = usage.find((entry) => entry.id === sandbox.id);
    expect(mine).toBeDefined();
    expect(mine?.memoryMb === undefined || mine.memoryMb >= 0).toBe(true);
    await sandbox.destroy();
  });

  it("reports unavailability when the docker CLI cannot be spawned (PATH stripped)", async () => {
    const originalPath = process.env.PATH;
    const probe = createDockerAvailabilityProbe();
    try {
      process.env.PATH = "";
      await expect(probe.check({ force: true })).resolves.toBe(false);
      const providerNoRunner = createDockerSandboxProvider(); // default runner
      await expect(providerNoRunner.create(spec())).rejects.toMatchObject({
        code: "SANDBOX_UNAVAILABLE",
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  afterAll(async () => {
    for (const handle of handles) {
      await handle.destroy().catch(() => undefined);
    }
    const leftovers = await docker(["ps", "-aq", "--filter", `label=openeuler.test=${TEST_TAG}`], {
      timeoutMs: 30_000,
    });
    const ids = leftovers.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const id of ids) {
      await docker(["rm", "-f", id], { timeoutMs: 30_000 });
    }
    const after = await docker(["ps", "-aq", "--filter", `label=openeuler.test=${TEST_TAG}`], {
      timeoutMs: 30_000,
    });
    if (after.stdout.trim() !== "") {
      throw new Error(`docker integration suite left containers behind: ${after.stdout}`);
    }
  });
});
