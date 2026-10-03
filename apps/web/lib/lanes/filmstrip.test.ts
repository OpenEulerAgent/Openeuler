import { describe, expect, it } from "vitest";
import type { LaneStepRun } from "./filmstrip";
import {
  blockTone,
  FILMSTRIP_MIN_BLOCK_PCT,
  filmstripBlockTitle,
  filmstripBlocks,
  filmstripRuler,
} from "./filmstrip";

const step = (
  overrides: Partial<LaneStepRun> & Pick<LaneStepRun, "id" | "stepId">,
): LaneStepRun => ({
  runId: "run-1",
  iteration: 1,
  status: "success",
  output: "",
  ...overrides,
});

const widthSum = (blocks: { widthPct: number }[]): number =>
  Math.round(blocks.reduce((sum, block) => sum + block.widthPct, 0) * 100) / 100;

describe("filmstripBlocks (proportional layout)", () => {
  it("sizes blocks proportionally to durationMs", () => {
    const blocks = filmstripBlocks([
      step({ id: "sr-1", stepId: "a", name: "Worker A", durationMs: 3_000 }),
      step({ id: "sr-2", stepId: "b", name: "Worker B", durationMs: 1_000 }),
    ]);
    expect(blocks.map((block) => block.widthPct)).toEqual([75, 25]);
    expect(widthSum(blocks)).toBe(100);
  });

  it("carries name/iteration/status/duration for the tooltip", () => {
    const blocks = filmstripBlocks([
      step({
        id: "sr-1",
        stepId: "a",
        name: "Worker A",
        iteration: 2,
        status: "failed",
        durationMs: 1_500,
      }),
    ]);
    expect(blocks[0]).toMatchObject({
      stepRunId: "sr-1",
      name: "Worker A",
      iteration: 2,
      status: "failed",
      durationMs: 1_500,
    });
  });

  it("falls back to the raw stepId when the enrichment has no name", () => {
    const blocks = filmstripBlocks([step({ id: "sr-1", stepId: "node-x9" })]);
    expect(blocks[0]?.name).toBe("node-x9");
  });

  it("clamps tiny blocks to a minimum share and renormalizes the row to 100%", () => {
    const blocks = filmstripBlocks([
      step({ id: "sr-1", stepId: "long", durationMs: 9_800 }),
      step({ id: "sr-2", stepId: "blip1", durationMs: 100 }),
      step({ id: "sr-3", stepId: "blip2", durationMs: 100 }),
    ]);
    // Raw shares are 98/1/1 — the blips must keep >= ~4% visibility while
    // the long block shrinks to make room, and the row still sums to 100.
    const [long, blip1, blip2] = blocks.map((block) => block.widthPct);
    expect(blip1).toBeGreaterThanOrEqual(FILMSTRIP_MIN_BLOCK_PCT - 0.5);
    expect(blip2).toBeGreaterThanOrEqual(FILMSTRIP_MIN_BLOCK_PCT - 0.5);
    expect(long).toBeGreaterThan(80);
    expect(long).toBeLessThan(98);
    // Per-block 2dp rounding may leave hundredths — the row stays full.
    expect(widthSum(blocks)).toBeCloseTo(100, 1);
    // Proportionality between the two equal blips survives the clamp.
    expect(blip1).toBe(blip2);
  });

  it("gives unknown durations the mean of the known ones", () => {
    const blocks = filmstripBlocks([
      step({ id: "sr-1", stepId: "a", durationMs: 1_000 }),
      step({ id: "sr-2", stepId: "b" }),
      step({ id: "sr-3", stepId: "c", durationMs: 3_000 }),
    ]);
    // Effective durations 1000/2000/3000 → 1/6, 1/3, 1/2.
    expect(blocks.map((block) => block.durationMs)).toEqual([1_000, null, 3_000]);
    expect(blocks.map((block) => block.widthPct)).toEqual([16.67, 33.33, 50]);
  });

  it("splits equally when no duration is known at all", () => {
    const blocks = filmstripBlocks([
      step({ id: "sr-1", stepId: "a" }),
      step({ id: "sr-2", stepId: "b" }),
      step({ id: "sr-3", stepId: "c" }),
      step({ id: "sr-4", stepId: "d" }),
    ]);
    expect(blocks.every((block) => block.widthPct === 25)).toBe(true);
  });

  it("returns [] for an empty step list", () => {
    expect(filmstripBlocks([])).toEqual([]);
  });
});

describe("filmstripBlockTitle / blockTone", () => {
  it("formats the hover tooltip: name · iter N · duration", () => {
    expect(
      filmstripBlockTitle({
        stepRunId: "sr-1",
        name: "Worker A",
        iteration: 2,
        status: "success",
        durationMs: 3_000,
        widthPct: 50,
      }),
    ).toBe("Worker A · iter 2 · 3s");
  });

  it("labels unknown durations explicitly", () => {
    expect(
      filmstripBlockTitle({
        stepRunId: "sr-1",
        name: "Worker B",
        iteration: 1,
        status: "success",
        durationMs: null,
        widthPct: 50,
      }),
    ).toBe("Worker B · iter 1 · unknown duration");
  });

  it("maps statuses to tones (colors)", () => {
    expect(blockTone("success")).toBe("success");
    expect(blockTone("failed")).toBe("failed");
    expect(blockTone("aborted")).toBe("warning");
    expect(blockTone("interrupted")).toBe("warning");
    expect(blockTone("running")).toBe("info");
    expect(blockTone("queued")).toBe("info");
  });
});

describe("filmstripRuler (run-level start → end)", () => {
  const run = {
    status: "success",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:03:20Z",
  };

  it("spans createdAt → updatedAt for terminal runs", () => {
    const ruler = filmstripRuler(run);
    expect(ruler.totalMs).toBe(200_000);
  });

  it("ticks start/middle/end with wall-clock labels", () => {
    const ruler = filmstripRuler(run);
    expect(ruler.ticks).toEqual([
      { pct: 0, label: "0ms" },
      { pct: 50, label: "1m 40s" },
      { pct: 100, label: "3m 20s" },
    ]);
  });

  it("spans createdAt → now for live rows and supports custom fractions", () => {
    const ruler = filmstripRuler(
      { ...run, status: "running" },
      { fractions: [0, 1], nowMs: Date.parse("2026-10-01T10:00:30Z") },
    );
    expect(ruler.totalMs).toBe(30_000);
    expect(ruler.ticks.map((tick) => tick.label)).toEqual(["0ms", "30s"]);
  });
});
