import { describe, expect, it } from "vitest";
import {
  ProjectSandboxPolicySchema,
  SandboxOverridesSchema,
  StepConfigSchema,
  WorkflowGraphSchema,
  sandboxOverridesActive,
} from "./index.js";

/**
 * Sandbox policy schema rules (#101): execution-mode default, resource
 * clamps (422 messages), cachePaths container-path rules, image grammar,
 * and the additive `sandboxOverrides` on StepConfig (old revisions without
 * the key stay valid; graph save validates them via the same schema).
 */

const validStepConfig = {
  driver: "opencode",
  mode: "auto" as const,
  promptTemplate: "{{task}}",
  continueSession: false,
};

describe("ProjectSandboxPolicySchema", () => {
  it("defaults executionMode to local (sandboxing is opt-in, #102) and keeps everything else optional", () => {
    expect(ProjectSandboxPolicySchema.parse({})).toEqual({ executionMode: "local" });
  });

  it("accepts a fully-specified policy", () => {
    const policy = ProjectSandboxPolicySchema.parse({
      executionMode: "sandbox",
      image: "openeuler/worker:latest",
      cpus: 4,
      memoryMb: 4096,
      network: "limited",
      cachePaths: ["/root/.cache", "/workspace/node_modules"],
      keepForDebug: true,
    });
    expect(policy).toMatchObject({ executionMode: "sandbox", cpus: 4, keepForDebug: true });
  });

  it("rejects an unknown execution mode / network mode", () => {
    expect(ProjectSandboxPolicySchema.safeParse({ executionMode: "container" }).success).toBe(
      false,
    );
    expect(ProjectSandboxPolicySchema.safeParse({ network: "bridge" }).success).toBe(false);
  });

  it("clamps cpus to whole cores in 1..8 with actionable messages", () => {
    expect(ProjectSandboxPolicySchema.safeParse({ cpus: 0 }).success).toBe(false);
    expect(ProjectSandboxPolicySchema.safeParse({ cpus: 9 }).success).toBe(false);
    expect(ProjectSandboxPolicySchema.safeParse({ cpus: 1.5 }).success).toBe(false);
    const tooMany = ProjectSandboxPolicySchema.safeParse({ cpus: 9 });
    expect(tooMany.success).toBe(false);
    if (!tooMany.success) {
      expect(tooMany.error.issues[0]?.message).toContain("cpus must be <= 8");
    }
    const fractional = ProjectSandboxPolicySchema.safeParse({ cpus: 1.5 });
    if (!fractional.success) {
      expect(fractional.error.issues[0]?.message).toContain("whole number");
    }
    expect(ProjectSandboxPolicySchema.parse({ cpus: 1 }).cpus).toBe(1);
    expect(ProjectSandboxPolicySchema.parse({ cpus: 8 }).cpus).toBe(8);
  });

  it("clamps memoryMb to whole MiB in 512..8192", () => {
    expect(ProjectSandboxPolicySchema.safeParse({ memoryMb: 511 }).success).toBe(false);
    expect(ProjectSandboxPolicySchema.safeParse({ memoryMb: 8193 }).success).toBe(false);
    expect(ProjectSandboxPolicySchema.safeParse({ memoryMb: 1000.5 }).success).toBe(false);
    const tooSmall = ProjectSandboxPolicySchema.safeParse({ memoryMb: 128 });
    if (!tooSmall.success) {
      expect(tooSmall.error.issues[0]?.message).toContain("memoryMb must be >= 512");
    }
    expect(ProjectSandboxPolicySchema.parse({ memoryMb: 512 }).memoryMb).toBe(512);
    expect(ProjectSandboxPolicySchema.parse({ memoryMb: 8192 }).memoryMb).toBe(8192);
  });

  it("rejects malformed image refs (flag/whitespace safety)", () => {
    expect(ProjectSandboxPolicySchema.safeParse({ image: "--privileged" }).success).toBe(false);
    expect(ProjectSandboxPolicySchema.safeParse({ image: "UPPER/case" }).success).toBe(false);
    expect(ProjectSandboxPolicySchema.safeParse({ image: "" }).success).toBe(false);
    const issue = ProjectSandboxPolicySchema.safeParse({ image: "-evil" });
    if (!issue.success) {
      expect(issue.error.issues[0]?.message).toContain("image must be a lowercase reference");
    }
    expect(ProjectSandboxPolicySchema.parse({ image: "busybox:1.36" }).image).toBe("busybox:1.36");
    expect(ProjectSandboxPolicySchema.parse({ image: "openeuler/worker" }).image).toBe(
      "openeuler/worker",
    );
    expect(ProjectSandboxPolicySchema.parse({ image: "repo/img@sha256:abc" }).image).toBe(
      "repo/img@sha256:abc",
    );
  });

  it("requires cache paths to be absolute container paths, at most 5", () => {
    expect(ProjectSandboxPolicySchema.parse({ cachePaths: ["/root/.cache"] }).cachePaths).toEqual([
      "/root/.cache",
    ]);
    expect(ProjectSandboxPolicySchema.safeParse({ cachePaths: ["relative/path"] }).success).toBe(
      false,
    );
    expect(ProjectSandboxPolicySchema.safeParse({ cachePaths: [""] }).success).toBe(false);
    const six = ProjectSandboxPolicySchema.safeParse({
      cachePaths: ["/a", "/b", "/c", "/d", "/e", "/f"],
    });
    expect(six.success).toBe(false);
    if (!six.success) {
      expect(six.error.issues[0]?.message).toContain("at most 5 cache paths");
    }
    const relative = ProjectSandboxPolicySchema.safeParse({ cachePaths: ["/ok", "nope"] });
    if (!relative.success) {
      expect(relative.error.issues[0]?.message).toContain("absolute container paths");
    }
  });

  it("rejects unknown keys (strict)", () => {
    expect(ProjectSandboxPolicySchema.safeParse({ egressFilter: true }).success).toBe(false);
  });
});

describe("SandboxOverridesSchema", () => {
  it("accepts every override field with the same rules as the policy", () => {
    expect(
      SandboxOverridesSchema.parse({
        image: "busybox:1.36",
        cpus: 4,
        memoryMb: 1024,
        network: "none",
      }),
    ).toEqual({ image: "busybox:1.36", cpus: 4, memoryMb: 1024, network: "none" });
  });

  it("shares the policy clamps", () => {
    expect(SandboxOverridesSchema.safeParse({ cpus: 9 }).success).toBe(false);
    expect(SandboxOverridesSchema.safeParse({ memoryMb: 100 }).success).toBe(false);
    expect(SandboxOverridesSchema.safeParse({ image: "BAD" }).success).toBe(false);
    // cachePaths / executionMode / keepForDebug are NOT override fields.
    expect(SandboxOverridesSchema.safeParse({ cachePaths: ["/x"] }).success).toBe(false);
    expect(SandboxOverridesSchema.safeParse({ keepForDebug: true }).success).toBe(false);
  });

  it("sandboxOverridesActive reports whether any field is set", () => {
    expect(sandboxOverridesActive(undefined)).toBe(false);
    expect(sandboxOverridesActive({})).toBe(false);
    expect(sandboxOverridesActive({ cpus: 2 })).toBe(true);
    expect(sandboxOverridesActive({ network: "none" })).toBe(true);
  });
});

describe("StepConfig sandboxOverrides (#101 additive)", () => {
  it("keeps pre-#101 configs valid (no sandboxOverrides key)", () => {
    expect(StepConfigSchema.safeParse(validStepConfig).success).toBe(true);
  });

  it("accepts and validates overrides on the config", () => {
    const parsed = StepConfigSchema.parse({
      ...validStepConfig,
      sandboxOverrides: { cpus: 4, network: "limited" },
    });
    expect(parsed.sandboxOverrides).toEqual({ cpus: 4, network: "limited" });
    expect(
      StepConfigSchema.safeParse({ ...validStepConfig, sandboxOverrides: { cpus: 99 } }).success,
    ).toBe(false);
  });

  it("flows through WorkflowGraphSchema: valid overrides save, invalid ones 422", () => {
    const graph = (sandboxOverrides: unknown) => ({
      entryNodeId: "a",
      nodes: [
        {
          id: "a",
          type: "agent" as const,
          name: "Agent",
          position: { x: 0, y: 0 },
          config: {
            ...validStepConfig,
            ...(sandboxOverrides === undefined ? {} : { sandboxOverrides }),
          },
        },
      ],
      edges: [],
    });
    expect(WorkflowGraphSchema.safeParse(graph({ image: "busybox:1.36", cpus: 2 })).success).toBe(
      true,
    );
    const invalid = WorkflowGraphSchema.safeParse(graph({ memoryMb: 1 }));
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues[0]?.path.join(".")).toContain("sandboxOverrides");
    }
  });
});
