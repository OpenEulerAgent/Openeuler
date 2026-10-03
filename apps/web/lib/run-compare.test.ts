import { describe, expect, it } from "vitest";
import type { Run } from "@openeuler/core";
import {
  alignRunSteps,
  clipToLines,
  compareHref,
  eventSpark,
  filesOnlyIn,
  parseCompareQuery,
  runCompareStats,
  type CompareRunDetail,
  type CompareStepRun,
} from "./run-compare";

const step = (overrides: Partial<CompareStepRun> = {}): CompareStepRun => ({
  id: "sr-1",
  runId: "run-A",
  stepId: "a",
  iteration: 1,
  status: "success",
  output: "did the thing",
  ...overrides,
});

const run = (overrides: Partial<Run> = {}): Run => ({
  id: "run-A",
  projectId: "p1",
  workflowId: "wf-1",
  workflowRevisionId: "rev-1",
  status: "success",
  branch: "agentloop/run-A",
  iteration: 0,
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:02:30Z",
  ...overrides,
});

const detail = (overrides: Partial<CompareRunDetail> = {}): CompareRunDetail => ({
  run: run(),
  steps: [],
  summary: { eventCount: 0 },
  ...overrides,
});

describe("compare URL codec", () => {
  it("parses both ids and tolerates missing/empty params", () => {
    expect(parseCompareQuery("?a=run-1&b=run-2")).toEqual({ a: "run-1", b: "run-2" });
    expect(parseCompareQuery("a=run-1")).toEqual({ a: "run-1", b: null });
    expect(parseCompareQuery("a=&b=run-2")).toEqual({ a: null, b: "run-2" });
    expect(parseCompareQuery("")).toEqual({ a: null, b: null });
    expect(new URLSearchParams("a=x&b=y").toString()).toContain("a=x");
    expect(parseCompareQuery(new URLSearchParams("a=x&b=y"))).toEqual({ a: "x", b: "y" });
  });

  it("builds the canonical compare href (encoded, selection order preserved)", () => {
    expect(compareHref("run 1", "run/2")).toBe("/runs/compare?a=run%201&b=run%2F2");
    const query = parseCompareQuery(compareHref("r-a", "r-b"));
    expect(query).toEqual({ a: "r-a", b: "r-b" });
  });
});

describe("alignRunSteps (union by stepId + iteration)", () => {
  it("aligns identical node sets side by side", () => {
    const rows = alignRunSteps(
      [step({ stepId: "a", iteration: 1, name: "Worker A" }), step({ stepId: "b", iteration: 1 })],
      [step({ stepId: "a", iteration: 1 }), step({ stepId: "b", iteration: 1 })],
    );
    expect(rows.map((row) => row.key)).toEqual(["a#1", "b#1"]);
    expect(rows[0]?.a?.stepId).toBe("a");
    expect(rows[0]?.b?.stepId).toBe("a");
    expect(rows.every((row) => row.a !== null && row.b !== null)).toBe(true);
  });

  it("keeps a node that only ran in A (B column empty)", () => {
    const rows = alignRunSteps(
      [step({ stepId: "a", iteration: 1 }), step({ stepId: "extra", iteration: 1 })],
      [step({ stepId: "a", iteration: 1 })],
    );
    const extra = rows.find((row) => row.stepId === "extra");
    expect(extra?.a).not.toBeNull();
    expect(extra?.b).toBeNull();
    // A-only nodes follow A's own order; the shared node aligns in place.
    expect(rows.map((row) => row.key)).toEqual(["a#1", "extra#1"]);
  });

  it("keeps a node that only ran in B", () => {
    const rows = alignRunSteps(
      [step({ stepId: "a", iteration: 1 })],
      [step({ stepId: "a", iteration: 1 }), step({ stepId: "only-b", iteration: 1 })],
    );
    const onlyB = rows.find((row) => row.stepId === "only-b");
    expect(onlyB?.a).toBeNull();
    expect(onlyB?.b).not.toBeNull();
  });

  it("unions different iteration counts into per-iteration rows (loops)", () => {
    const rows = alignRunSteps(
      [
        step({ stepId: "impl", iteration: 1 }),
        step({ stepId: "impl", iteration: 2 }),
        step({ stepId: "impl", iteration: 3 }),
      ],
      [step({ stepId: "impl", iteration: 1 }), step({ stepId: "impl", iteration: 2 })],
    );
    expect(rows.map((row) => row.key)).toEqual(["impl#1", "impl#2", "impl#3"]);
    expect(rows[2]?.b).toBeNull();
  });

  it("sorts by iteration first, then A's execution order; label prefers the node name", () => {
    const rows = alignRunSteps(
      [
        step({ stepId: "impl", iteration: 1, name: "Implementer" }),
        step({ stepId: "review", iteration: 1, name: "Reviewer" }),
        step({ stepId: "impl", iteration: 2 }),
      ],
      [step({ stepId: "impl", iteration: 1 })],
    );
    expect(rows.map((row) => `${row.label}@${row.iteration}`)).toEqual([
      "Implementer@1",
      "Reviewer@1",
      "Implementer@2",
    ]);
  });

  it("falls back to B's name when A's side is absent", () => {
    const rows = alignRunSteps([], [step({ stepId: "b-only", iteration: 1, name: "Named" })]);
    expect(rows[0]?.label).toBe("Named");
  });
});

describe("runCompareStats (header stat cards)", () => {
  it("assembles every card field from the run detail", () => {
    const stats = runCompareStats(
      detail({
        run: run({
          status: "failed",
          ports: [3000, 5173],
          workflowRevisionId: "rev-7",
          createdAt: "2026-10-01T10:00:00Z",
          updatedAt: "2026-10-01T10:02:30Z",
        }),
        steps: [
          step({ stepId: "a", iteration: 1 }),
          step({ stepId: "a", iteration: 2 }),
          step({ stepId: "b", iteration: 2 }),
        ],
        summary: { eventCount: 42 },
        sandbox: { id: "sb-1", image: "openeuler/node:20", status: "running" },
      }),
    );
    expect(stats).toMatchObject({
      runId: "run-A",
      branch: "agentloop/run-A",
      status: "failed",
      live: false,
      durationMs: 150_000,
      executions: 3,
      iterations: 2,
      ports: [3000, 5173],
      sandboxed: true,
      sandboxImage: "openeuler/node:20",
      eventCount: 42,
    });
  });

  it("maps missing revision/ports/sandbox to neutral values", () => {
    const stats = runCompareStats(
      detail({
        run: run({
          workflowId: undefined,
          workflowRevisionId: undefined,
          ports: undefined,
        }),
      }),
    );
    expect(stats.workflowRevision).toBeNull();
    expect(stats.ports).toEqual([]);
    expect(stats.sandboxed).toBe(false);
    expect(stats.sandboxImage).toBeNull();
    expect(stats.iterations).toBe(0);
  });

  it("marks live runs and measures duration against now", () => {
    const stats = runCompareStats(
      detail({
        run: run({
          status: "running",
          createdAt: "2026-10-01T10:00:00Z",
          updatedAt: "2026-10-01T10:00:10Z",
        }),
      }),
      Date.parse("2026-10-01T10:01:00Z"),
    );
    expect(stats.live).toBe(true);
    expect(stats.durationMs).toBe(60_000);
  });
});

describe("eventSpark", () => {
  it("scales both counts to the shared max", () => {
    expect(eventSpark(10, 5)).toEqual({ a: 10, b: 5, max: 10, aFraction: 1, bFraction: 0.5 });
    expect(eventSpark(3, 12)).toEqual({ a: 3, b: 12, max: 12, aFraction: 0.25, bFraction: 1 });
  });

  it("renders zero-height bars when both counts are zero", () => {
    expect(eventSpark(0, 0)).toEqual({ a: 0, b: 0, max: 0, aFraction: 0, bFraction: 0 });
  });
});

describe("filesOnlyIn (cumulative patch path sets)", () => {
  const patch = (paths: string[]): string =>
    paths
      .map(
        (path) =>
          `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
      )
      .join("");

  it("extracts files changed only in A, only in B, and in both", () => {
    const sets = filesOnlyIn(
      patch(["shared.ts", "only-a.ts"]),
      patch(["shared.ts", "only-b.ts", "also-b.md"]),
    );
    expect(sets.onlyInA).toEqual(["only-a.ts"]);
    expect(sets.onlyInB).toEqual(["only-b.ts", "also-b.md"]);
    expect(sets.inBoth).toEqual(["shared.ts"]);
  });

  it("handles empty patches on either side", () => {
    const sets = filesOnlyIn(patch(["a.ts"]), "");
    expect(sets).toEqual({ onlyInA: ["a.ts"], onlyInB: [], inBoth: [] });
    expect(filesOnlyIn("", "")).toEqual({ onlyInA: [], onlyInB: [], inBoth: [] });
  });

  it("uses the deletion path for deleted files", () => {
    const deleted =
      "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0 @@\n-x\n";
    expect(filesOnlyIn(deleted, "").onlyInA).toEqual(["gone.ts"]);
  });
});

describe("clipToLines (2-line output cells)", () => {
  it("keeps short output whole", () => {
    expect(clipToLines("one line", 2)).toEqual({ text: "one line", clipped: false });
  });

  it("clips to the first N lines and reports the cut", () => {
    const output = clipToLines("line 1\nline 2\nline 3\nline 4", 2);
    expect(output).toEqual({ text: "line 1\nline 2", clipped: true });
  });
});
