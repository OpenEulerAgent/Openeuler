import { describe, expect, it } from "vitest";
import type { RunStatusStreamEvent, RunsApiRow } from "../runs-stream";
import {
  LANE_EXIT_FADE_MS,
  isLaneActiveStatus,
  lanesReducer,
  type LaneCard,
} from "./lanes-reducer";

/** Minimal run row for the board (the fields the reducer touches). */
const row = (overrides: Partial<RunsApiRow> & Pick<RunsApiRow, "id">): RunsApiRow => ({
  projectId: "p1",
  status: "running",
  branch: "run/one",
  iteration: 2,
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:01:00Z",
  ...overrides,
});

const event = (
  runId: string,
  status: RunStatusStreamEvent["status"],
  extra: Partial<RunStatusStreamEvent> = {},
): RunStatusStreamEvent => ({ runId, status, projectId: "p1", ...extra });

describe("isLaneActiveStatus", () => {
  it("active = exactly queued or running (non-terminal)", () => {
    expect(isLaneActiveStatus("queued")).toBe(true);
    expect(isLaneActiveStatus("running")).toBe(true);
    for (const status of ["success", "failed", "aborted", "interrupted"] as const) {
      expect(isLaneActiveStatus(status)).toBe(false);
    }
  });
});

describe("lanesReducer: seeded (initial fetch merge)", () => {
  it("keeps only active rows, ordered oldest → newest (new lanes append right)", () => {
    const next = lanesReducer([], {
      type: "seeded",
      rows: [
        row({ id: "new", createdAt: "2026-10-01T12:00:00Z" }),
        row({ id: "old", createdAt: "2026-10-01T09:00:00Z" }),
        row({ id: "done", status: "success" }),
      ],
      nowMs: 0,
    });
    expect(next.map((lane) => lane.id)).toEqual(["old", "new"]);
  });

  it("retains a mid-fade terminal lane the fetch no longer lists", () => {
    const exiting: LaneCard = {
      ...row({ id: "gone", status: "success" }),
      exiting: true,
      exitAtMs: 10_000,
    };
    const kept = lanesReducer([exiting], { type: "seeded", rows: [], nowMs: 4_999 });
    expect(kept.map((lane) => lane.id)).toEqual(["gone"]);
    expect(kept[0]?.exiting).toBe(true);

    const dropped = lanesReducer([exiting], { type: "seeded", rows: [], nowMs: 10_000 });
    expect(dropped).toEqual([]);
  });

  it("un-exits a lane the fetch reports active again (it wins over the fade)", () => {
    const exiting: LaneCard = {
      ...row({ id: "back", status: "success" }),
      exiting: true,
      exitAtMs: 10_000,
    };
    const next = lanesReducer([exiting], {
      type: "seeded",
      rows: [row({ id: "back", status: "running" })],
      nowMs: 5_000,
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.status).toBe("running");
    expect(next[0]?.exiting).toBeUndefined();
  });

  it("fills a placeholder lane with the fetched row's full detail", () => {
    const placeholder = lanesReducer([], {
      type: "streamEvent",
      event: event("r9", "queued"),
      nowMs: Date.parse("2026-10-01T10:00:00Z"),
    });
    const filled = lanesReducer(placeholder, {
      type: "seeded",
      rows: [
        row({
          id: "r9",
          status: "queued",
          project: { id: "p1", name: "alpha" },
          workflow: { id: "wf1", name: "ship-it" },
        }),
      ],
      nowMs: Date.parse("2026-10-01T10:00:01Z"),
    });
    expect(filled).toHaveLength(1);
    expect(filled[0]?.project?.name).toBe("alpha");
    expect(filled[0]?.workflow?.name).toBe("ship-it");
  });
});

describe("lanesReducer: streamEvent", () => {
  it("patches a known lane in place (queued → running drops queuePosition)", () => {
    const lanes = lanesReducer([], {
      type: "seeded",
      rows: [row({ id: "r1", status: "queued", queuePosition: 2 })],
      nowMs: 0,
    });
    const next = lanesReducer(lanes, {
      type: "streamEvent",
      event: event("r1", "running"),
      nowMs: 1,
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.status).toBe("running");
    expect(next[0]?.queuePosition).toBeUndefined();
    // No-op transitions keep the same array reference (no re-render churn).
    expect(
      lanesReducer(next, { type: "streamEvent", event: event("r1", "running"), nowMs: 2 }),
    ).toBe(next);
  });

  it("terminal transitions mark the lane exiting with a 5s grace", () => {
    const lanes = lanesReducer([], {
      type: "seeded",
      rows: [row({ id: "r1", status: "running" })],
      nowMs: 0,
    });
    const next = lanesReducer(lanes, {
      type: "streamEvent",
      event: event("r1", "success"),
      nowMs: 1_000,
    });
    expect(next[0]?.exiting).toBe(true);
    expect(next[0]?.exitAtMs).toBe(1_000 + LANE_EXIT_FADE_MS);
    expect(next[0]?.status).toBe("success");
    // A second terminal event for the same exiting lane is a no-op…
    expect(
      lanesReducer(next, { type: "streamEvent", event: event("r1", "success"), nowMs: 1_100 }),
    ).toBe(next);
    // …but a DIFFERENT terminal status still updates the card.
    const aborted = lanesReducer(next, {
      type: "streamEvent",
      event: event("r1", "aborted"),
      nowMs: 1_200,
    });
    expect(aborted[0]?.status).toBe("aborted");
    expect(aborted[0]?.exitAtMs).toBe(1_000 + LANE_EXIT_FADE_MS);
  });

  it("an active transition for an unknown id adds a placeholder lane immediately", () => {
    const lanes = lanesReducer([], {
      type: "seeded",
      rows: [row({ id: "r1", createdAt: "2026-10-01T09:00:00Z" })],
      nowMs: 0,
    });
    const next = lanesReducer(lanes, {
      type: "streamEvent",
      event: event("r2", "queued", { workflowRevision: { id: "rev1", number: 3 } }),
      nowMs: Date.parse("2026-10-01T10:00:00Z"),
    });
    expect(next.map((lane) => lane.id)).toEqual(["r1", "r2"]);
    expect(next[1]?.status).toBe("queued");
    expect(next[1]?.workflowRevision).toEqual({ id: "rev1", number: 3 });
    // Placeholders carry no names yet — the debounced seed refetch fills them.
    expect(next[1]?.project).toBeUndefined();
  });

  it("ignores terminal transitions for unknown ids (history's job)", () => {
    const lanes: LaneCard[] = [];
    expect(
      lanesReducer(lanes, { type: "streamEvent", event: event("ghost", "failed"), nowMs: 0 }),
    ).toBe(lanes);
  });

  it("an active transition un-exits an exiting lane", () => {
    const exiting: LaneCard = {
      ...row({ id: "r1", status: "success" }),
      exiting: true,
      exitAtMs: 10_000,
    };
    const next = lanesReducer([exiting], {
      type: "streamEvent",
      event: event("r1", "running"),
      nowMs: 2_000,
    });
    expect(next[0]?.status).toBe("running");
    expect(next[0]?.exiting).toBeUndefined();
  });
});

describe("lanesReducer: pruneExpired", () => {
  it("drops lanes at/past their grace and keeps the rest", () => {
    const lanes: LaneCard[] = [
      { ...row({ id: "live" }), exiting: undefined, exitAtMs: undefined },
      { ...row({ id: "fading", status: "success" }), exiting: true, exitAtMs: 10_500 },
      { ...row({ id: "expired", status: "failed" }), exiting: true, exitAtMs: 10_000 },
    ];
    const next = lanesReducer(lanes, { type: "pruneExpired", nowMs: 10_000 });
    expect(next.map((lane) => lane.id)).toEqual(["live", "fading"]);
  });
});

describe("lanesReducer: runFetched", () => {
  it("upserts an active row (fills placeholders, refreshes detail)", () => {
    const placeholder = lanesReducer([], {
      type: "streamEvent",
      event: event("r1", "running"),
      nowMs: Date.parse("2026-10-01T10:00:00Z"),
    });
    const next = lanesReducer(placeholder, {
      type: "runFetched",
      row: row({ id: "r1", status: "running", project: { id: "p1", name: "beta" } }),
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.project?.name).toBe("beta");
  });

  it("a terminal fetch under a live lane starts the fade (event/fetch race)", () => {
    const lanes = lanesReducer([], {
      type: "seeded",
      rows: [row({ id: "r1", status: "running" })],
      nowMs: 0,
    });
    const next = lanesReducer(lanes, {
      type: "runFetched",
      row: row({ id: "r1", status: "success" }),
    });
    expect(next[0]?.exiting).toBe(true);
    expect(next[0]?.exitAtMs).toBeGreaterThan(0);
  });

  it("a terminal fetch for an unknown lane is a no-op", () => {
    const lanes: LaneCard[] = [];
    expect(
      lanesReducer(lanes, { type: "runFetched", row: row({ id: "r2", status: "failed" }) }),
    ).toBe(lanes);
  });
});
