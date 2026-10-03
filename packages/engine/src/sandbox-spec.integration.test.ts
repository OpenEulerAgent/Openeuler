import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerAvailabilityProbe, docker } from "@openeuler/sandbox";
import { createDockerSandboxProvider } from "@openeuler/sandbox";
import type { SandboxHandle } from "@openeuler/sandbox";
import type { ProjectSandboxPolicy } from "@openeuler/core";
import { buildSandboxSpec } from "./sandbox-spec.js";

/**
 * Real-docker spot check (#101, reusing the #99 integration patterns):
 * a spec BUILT FROM A POLICY + node overrides must start a sandbox whose
 * resource flags and network mode are observable via `docker inspect`.
 * Skips itself when no docker daemon is reachable (DOCKER_E2E=0 or probe).
 */

const BUSYBOX = "busybox:1.36";
const TEST_TAG = "policy-integration";

const dockerLive =
  process.env.DOCKER_E2E === "0"
    ? false
    : await createDockerAvailabilityProbe().check({ force: true });

const handles: SandboxHandle[] = [];

describe.skipIf(!dockerLive)("buildSandboxSpec → docker provider (real daemon)", () => {
  beforeAll(async () => {
    const present = await docker(["image", "inspect", BUSYBOX], { timeoutMs: 30_000 });
    if (present.code !== 0) {
      const pull = await docker(["pull", BUSYBOX], { timeoutMs: 300_000 });
      if (pull.code !== 0) throw new Error(`failed to pull ${BUSYBOX}: ${pull.stderr}`);
    }
  });

  it("creates a sandbox from a policy spec with overrides honored (inspect-asserted)", async () => {
    const policy: ProjectSandboxPolicy = {
      executionMode: "sandbox",
      image: BUSYBOX,
      cpus: 1,
      memoryMb: 512,
      network: "default",
    };
    // Node override wins: 2 CPUs / 768 MiB / limited bridge.
    const spec = buildSandboxSpec(
      policy,
      { cpus: 2, memoryMb: 768, network: "limited" },
      `run-policy-${Date.now()}`,
      [],
      { FROM_POLICY: "yes" },
    );
    const provider = createDockerSandboxProvider();
    const sandbox = await provider.create({
      ...spec,
      labels: { ...spec.labels, "openeuler-test": TEST_TAG },
    });
    handles.push(sandbox);

    const inspect = await docker(
      [
        "inspect",
        sandbox.id,
        "--format",
        "{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.NetworkMode}}",
      ],
      { timeoutMs: 30_000 },
    );
    expect(inspect.code).toBe(0);
    const [memory, nanoCpus, networkMode] = inspect.stdout.trim().split(" ");
    expect(Number.parseInt(memory ?? "0", 10)).toBe(768 * 1024 * 1024);
    expect(Number.parseInt(nanoCpus ?? "0", 10)).toBe(2_000_000_000);
    expect(networkMode).toBe("openeuler-limited");

    // The spec env really reaches the container.
    const result = await sandbox.exec(["sh", "-c", "echo $FROM_POLICY"]);
    expect(result.stdout.trim()).toBe("yes");
    await sandbox.destroy();
  });

  afterAll(async () => {
    for (const handle of handles) {
      await handle.destroy().catch(() => undefined);
    }
    const leftovers = await docker(["ps", "-aq", "--filter", `label=openeuler-test=${TEST_TAG}`], {
      timeoutMs: 30_000,
    });
    const ids = leftovers.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const id of ids) {
      await docker(["rm", "-f", id], { timeoutMs: 30_000 });
    }
    const after = await docker(["ps", "-aq", "--filter", `label=openeuler-test=${TEST_TAG}`], {
      timeoutMs: 30_000,
    });
    if (after.stdout.trim() !== "") {
      throw new Error(`policy integration suite left containers behind: ${after.stdout}`);
    }
  });
});
