import { describe, expect, it } from "vitest";
import type { RunStatus, StepRun } from "@openeuler/core";
import { nextRunHref, resumeEndpoint, resumePossible, retryEndpoint } from "./run-recovery.js";

const step = (overrides: Partial<StepRun> & { id: string }): StepRun => ({
  runId: "run-1",
  stepId: "adhoc",
  iteration: 1,
  status: "interrupted" satisfies RunStatus,
  output: "",
  ...overrides,
});

describe("resumePossible", () => {
  it("is trivially true when no step ever started (no rows)", () => {
    expect(resumePossible([])).toBe(true);
  });

  it("is true when every started step recorded a sessionId", () => {
    const steps = [
      step({ id: "a", stepId: "s1", status: "success", sessionId: "s-1", output: "done" }),
      step({ id: "b", stepId: "s2", sessionId: "s-2" }),
    ];
    expect(resumePossible(steps)).toBe(true);
  });

  it("is false when any started step lacks a sessionId (context lost)", () => {
    const steps = [
      step({ id: "a", stepId: "s1", status: "success", sessionId: "s-1", output: "done" }),
      step({ id: "b", stepId: "s2" }),
    ];
    expect(resumePossible(steps)).toBe(false);
  });
});

describe("recovery endpoints", () => {
  it("target the resume/retry POST endpoints with an encoded run id", () => {
    expect(resumeEndpoint("run/1")).toBe("/api/runs/run%2F1/resume");
    expect(retryEndpoint("run/1")).toBe("/api/runs/run%2F1/retry");
  });

  it("navigates retry results to the new run's detail page", () => {
    expect(nextRunHref("abc 123")).toBe("/runs/abc%20123");
  });
});
