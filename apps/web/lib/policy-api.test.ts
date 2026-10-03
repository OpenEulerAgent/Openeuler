import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSandboxPolicy } from "@openeuler/core";
import { fetchProjectPolicy, patchProjectPolicy, policyIssue } from "./policy-api";

/** Minimal stand-in for apiFetch: records the call, replies canned JSON. */
const fetcher = vi.fn();

beforeEach(() => {
  fetcher.mockReset();
});

const savedPolicy: ProjectSandboxPolicy = {
  executionMode: "sandbox",
  image: "openeuler/worker:latest",
  cpus: 4,
  memoryMb: 4096,
  network: "limited",
  keepForDebug: true,
};

describe("fetchProjectPolicy", () => {
  it("GETs the project and returns its saved policy", async () => {
    fetcher.mockResolvedValue({ project: { sandboxPolicy: savedPolicy } });
    await expect(fetchProjectPolicy("p1", fetcher)).resolves.toEqual(savedPolicy);
    expect(fetcher).toHaveBeenCalledWith("/api/projects/p1");
  });

  it("returns null when no policy was saved yet", async () => {
    fetcher.mockResolvedValue({ project: {} });
    await expect(fetchProjectPolicy("p1", fetcher)).resolves.toBeNull();
  });
});

describe("patchProjectPolicy", () => {
  it("PATCHes the whole policy as JSON and returns the stored one", async () => {
    fetcher.mockResolvedValue({ project: { sandboxPolicy: savedPolicy } });
    await expect(patchProjectPolicy("p1", savedPolicy, fetcher)).resolves.toEqual(savedPolicy);
    expect(fetcher).toHaveBeenCalledWith("/api/projects/p1/policy", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(savedPolicy),
    });
  });

  it("throws when the daemon answer carries no policy (defensive)", async () => {
    fetcher.mockResolvedValue({ project: {} });
    await expect(patchProjectPolicy("p1", savedPolicy, fetcher)).rejects.toThrow(/policy/);
  });
});

describe("policyIssue (client-side mirror)", () => {
  it("accepts a valid policy and returns null", () => {
    expect(policyIssue({ executionMode: "auto" })).toBeNull();
    expect(policyIssue(savedPolicy)).toBeNull();
  });

  it("reports the first clamp/rule message otherwise", () => {
    expect(policyIssue({ executionMode: "auto", cpus: 99 })).toContain("cpus must be <= 8");
    expect(policyIssue({ executionMode: "auto", memoryMb: 100 })).toContain(
      "memoryMb must be >= 512",
    );
    expect(policyIssue({ executionMode: "auto", image: "BAD REF" })).toContain(
      "image must be a lowercase reference",
    );
    expect(policyIssue({ executionMode: "auto", cachePaths: ["rel"] })).toContain(
      "absolute container paths",
    );
  });
});
