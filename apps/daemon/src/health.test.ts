import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_CONCURRENT_RUNS, resolveMaxConcurrentRuns } from "./concurrency.js";
import { healthPayload } from "./health.js";
import { getVersion } from "./version.js";

describe("@openeuler/daemon", () => {
  it("health payload reports ok with version, uptime and the concurrency cap", () => {
    expect(healthPayload()).toEqual({
      ok: true,
      version: getVersion(),
      uptime: expect.any(Number),
      maxConcurrentRuns: DEFAULT_MAX_CONCURRENT_RUNS,
    });
    expect(healthPayload(7).maxConcurrentRuns).toBe(7);
  });
});

describe("resolveMaxConcurrentRuns", () => {
  it("accepts integers >= 1 and rejects everything else (default 2)", () => {
    expect(DEFAULT_MAX_CONCURRENT_RUNS).toBe(2);
    expect(resolveMaxConcurrentRuns(undefined)).toBe(2);
    expect(resolveMaxConcurrentRuns("")).toBe(2);
    expect(resolveMaxConcurrentRuns("  ")).toBe(2);
    expect(resolveMaxConcurrentRuns("0")).toBe(2);
    expect(resolveMaxConcurrentRuns("-3")).toBe(2);
    expect(resolveMaxConcurrentRuns("1.5")).toBe(2);
    expect(resolveMaxConcurrentRuns("soon")).toBe(2);
    expect(resolveMaxConcurrentRuns("1")).toBe(1);
    expect(resolveMaxConcurrentRuns("2")).toBe(2);
    expect(resolveMaxConcurrentRuns("16")).toBe(16);
    expect(resolveMaxConcurrentRuns(" 4 ")).toBe(4);
  });
});
