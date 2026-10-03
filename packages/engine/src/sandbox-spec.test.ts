import { describe, expect, it } from "vitest";
import { SandboxError } from "@openeuler/sandbox";
import type { ProjectSandboxPolicy } from "@openeuler/core";
import {
  DEFAULT_SANDBOX_CPUS,
  DEFAULT_SANDBOX_MEMORY_MB,
  buildRunSandboxSpec,
  buildSandboxSpec,
  cacheVolumeName,
  mergeSandboxConfig,
} from "./sandbox-spec.js";

/**
 * buildSandboxSpec (#101, prep for #102): pure policy + node-override
 * merge with engine defaults, and the typed SANDBOX_INVALID_SPEC error
 * (with an actionable message) when sandbox execution has no image.
 */

const basePolicy: ProjectSandboxPolicy = {
  executionMode: "sandbox",
  image: "openeuler/worker:latest",
  cpus: 2,
  memoryMb: 2048,
  network: "limited",
};

describe("mergeSandboxConfig", () => {
  it("uses the policy as-is when no overrides are set", () => {
    expect(mergeSandboxConfig(basePolicy, undefined)).toEqual({
      image: "openeuler/worker:latest",
      cpus: 2,
      memoryMb: 2048,
      network: "limited",
    });
  });

  it("override wins per field; unset override fields inherit", () => {
    expect(mergeSandboxConfig(basePolicy, { cpus: 8, network: "none" })).toEqual({
      image: "openeuler/worker:latest",
      cpus: 8,
      memoryMb: 2048,
      network: "none",
    });
    expect(mergeSandboxConfig(basePolicy, {})).toEqual(mergeSandboxConfig(basePolicy, undefined));
  });

  it("fills engine defaults (2 CPUs / 2048 MiB) when neither policy nor override sets resources", () => {
    const merged = mergeSandboxConfig({}, undefined);
    expect(merged.cpus).toBe(DEFAULT_SANDBOX_CPUS);
    expect(merged.memoryMb).toBe(DEFAULT_SANDBOX_MEMORY_MB);
    expect(merged.image).toBeUndefined();
    expect(merged.network).toBeUndefined();
  });

  it("an empty override does not shadow the policy image ({} means inherit)", () => {
    expect(mergeSandboxConfig(basePolicy, { image: undefined }).image).toBe(basePolicy.image);
  });
});

describe("buildSandboxSpec", () => {
  it("maps the merged config onto SandboxSpec fields", () => {
    const spec = buildSandboxSpec(
      basePolicy,
      { cpus: 4 },
      "run-1",
      [{ hostPath: "/tmp/wt", containerPath: "/workspace" }],
      { TASK: "ship it" },
      [8080],
    );
    expect(spec).toEqual({
      runId: "run-1",
      image: "openeuler/worker:latest",
      mounts: [{ hostPath: "/tmp/wt", containerPath: "/workspace" }],
      env: { TASK: "ship it" },
      ports: [8080],
      resources: { cpus: 4, memoryMb: 2048 },
      network: "limited",
    });
  });

  it("defaults: no ports key when none requested, resources always present", () => {
    const spec = buildSandboxSpec(basePolicy, undefined, "run-2", [], {});
    expect(spec.ports).toBeUndefined();
    expect(spec.resources).toEqual({ cpus: 2, memoryMb: 2048 });
  });

  it("omits network when neither policy nor override sets one (provider default)", () => {
    const spec = buildSandboxSpec(
      { executionMode: "sandbox", image: "busybox:1.36" },
      undefined,
      "r",
      [],
      {},
    );
    expect(spec.network).toBeUndefined();
  });

  it("throws typed SANDBOX_INVALID_SPEC with actionable message when no image anywhere", () => {
    try {
      buildSandboxSpec({ executionMode: "sandbox" }, undefined, "run-3", [], {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      const sandboxError = err as SandboxError;
      expect(sandboxError.code).toBe("SANDBOX_INVALID_SPEC");
      expect(sandboxError.message).toContain("needs an image");
      // Actionable pointer: the image-management endpoints.
      expect(sandboxError.message).toContain("GET /api/sandbox/images");
      expect(sandboxError.message).toContain("POST /api/sandbox/images/pull");
    }
  });

  it("an override image satisfies a policy without one", () => {
    const spec = buildSandboxSpec(
      { executionMode: "sandbox" },
      { image: "busybox:1.36" },
      "run-4",
      [],
      {},
    );
    expect(spec.image).toBe("busybox:1.36");
    expect(spec.resources).toEqual({
      cpus: DEFAULT_SANDBOX_CPUS,
      memoryMb: DEFAULT_SANDBOX_MEMORY_MB,
    });
  });
});

describe("buildRunSandboxSpec (#102)", () => {
  it("mounts the worktree rw+cached at /workspace, labels it with the run, and defaults workingDir", () => {
    const spec = buildRunSandboxSpec({
      policy: basePolicy,
      runId: "run-42",
      projectId: "p1",
      worktreePath: "/store/run-42",
    });
    expect(spec.mounts).toEqual([
      { hostPath: "/store/run-42", containerPath: "/workspace", consistency: "cached" },
    ]);
    expect(spec.labels).toEqual({ run: "run-42" });
    expect(spec.workingDir).toBe("/workspace");
    expect(spec.volumes).toBeUndefined();
    expect(spec.env).toEqual({});
    expect(spec.image).toBe("openeuler/worker:latest");
    expect(spec.resources).toEqual({ cpus: 2, memoryMb: 2048 });
  });

  it("maps policy.cachePaths onto stable per-project named volumes", () => {
    const spec = buildRunSandboxSpec({
      policy: {
        ...basePolicy,
        cachePaths: ["/workspace/node_modules", "/workspace/.pnpm-store"],
      },
      runId: "run-42",
      projectId: "p1",
      worktreePath: "/store/run-42",
      env: { OPENEULER_RUN_ID: "run-42" },
    });
    expect(spec.volumes).toEqual([
      {
        name: "openeuler-cache-p1-workspace-node_modules",
        containerPath: "/workspace/node_modules",
      },
      { name: "openeuler-cache-p1-workspace-.pnpm-store", containerPath: "/workspace/.pnpm-store" },
    ]);
    expect(spec.env).toEqual({ OPENEULER_RUN_ID: "run-42" });
  });

  it("cache volume names are stable per (project, path) and differ per project", () => {
    expect(cacheVolumeName("p1", "/workspace/node_modules")).toBe(
      cacheVolumeName("p1", "/workspace/node_modules"),
    );
    expect(cacheVolumeName("p1", "/workspace/node_modules")).not.toBe(
      cacheVolumeName("p2", "/workspace/node_modules"),
    );
    expect(cacheVolumeName("p1", "/workspace/node_modules")).toBe(
      "openeuler-cache-p1-workspace-node_modules",
    );
  });

  it("sanitizes characters docker volume names reject", () => {
    expect(cacheVolumeName("p~1", "/a b/c")).toBe("openeuler-cache-p-1-a-b-c");
  });

  it("throws the typed, actionable SANDBOX_INVALID_SPEC when no image is configured", () => {
    const policy: ProjectSandboxPolicy = { executionMode: "sandbox" };
    expect(() =>
      buildRunSandboxSpec({ policy, runId: "r", projectId: "p", worktreePath: "/w" }),
    ).toThrowError(SandboxError);
    expect(() =>
      buildRunSandboxSpec({ policy, runId: "r", projectId: "p", worktreePath: "/w" }),
    ).toThrow(/sandbox execution needs an image/);
  });
});
