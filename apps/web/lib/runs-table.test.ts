import { describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import type { RunStatusStreamEvent, RunsApiRow } from "./runs-stream";
import {
  decodeRunsFilters,
  encodeRunsFilters,
  filterRuns,
  filtersToSearch,
  nextStopConfirmState,
  rowActionFor,
  runsTableReducer,
} from "./runs-table";

const row = (overrides: Partial<RunsApiRow> = {}): RunsApiRow => ({
  id: "run-1",
  projectId: "p1",
  status: "running",
  branch: "run/abc",
  iteration: 0,
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:01:00Z",
  project: { id: "p1", name: "alpha" },
  ...overrides,
});

const event = (runId: string, status: RunStatus): RunStatusStreamEvent => ({
  runId,
  status,
  projectId: "p1",
});

describe("runs filters URL codec", () => {
  it("serializes status and project together (filters compose)", () => {
    expect(encodeRunsFilters({ statuses: ["running", "queued"], projectId: "p1" })).toBe(
      "status=queued%2Crunning&projectId=p1",
    );
    expect(encodeRunsFilters({ statuses: ["failed"] })).toBe("status=failed");
    expect(encodeRunsFilters({ statuses: [], projectId: "p1" })).toBe("projectId=p1");
    expect(encodeRunsFilters({ statuses: [] })).toBe("");
  });

  it("drops invalid statuses and keeps valid siblings when parsing", () => {
    expect(decodeRunsFilters("?status=running,nope,queued")).toEqual({
      statuses: ["queued", "running"],
      projectId: undefined,
    });
    expect(decodeRunsFilters("?projectId=p2")).toEqual({ statuses: [], projectId: "p2" });
    expect(decodeRunsFilters("")).toEqual({ statuses: [], projectId: undefined });
  });

  it("round-trips through a URL query string (reload preserves state)", () => {
    for (const filters of [
      { statuses: [] as RunStatus[], projectId: undefined },
      { statuses: ["success", "failed", "aborted", "interrupted"] as RunStatus[], projectId: "p9" },
      { statuses: ["running"] as RunStatus[], projectId: undefined },
    ]) {
      const search = filtersToSearch(filters);
      expect(decodeRunsFilters(new URLSearchParams(search.replace(/^\?/, "")))).toEqual(filters);
      expect(decodeRunsFilters(search)).toEqual(filters);
    }
  });

  it("applies status and project filters jointly to loaded rows", () => {
    const rows = [
      row({ id: "a", status: "running", projectId: "p1" }),
      row({ id: "b", status: "success", projectId: "p1" }),
      row({ id: "c", status: "success", projectId: "p2" }),
    ];
    expect(filterRuns(rows, { statuses: ["success"], projectId: "p1" }).map((r) => r.id)).toEqual([
      "b",
    ]);
    expect(filterRuns(rows, { statuses: [] }).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(
      filterRuns(rows, { statuses: ["running", "success"], projectId: "p2" }).map((r) => r.id),
    ).toEqual(["c"]);
  });
});

describe("runsTableReducer", () => {
  it("patches a known row from a stream event and drops stale queue metadata", () => {
    const rows = [row({ status: "queued", queuePosition: 2 }), row({ id: "run-2" })];
    const next = runsTableReducer(rows, { type: "streamEvent", event: event("run-1", "running") });
    const patched = next[0] as RunsApiRow;
    expect(patched).toMatchObject({ id: "run-1", status: "running" });
    expect("queuePosition" in patched).toBe(false);
    expect(next[1]).toBe(rows[1]);
  });

  it("ignores stream events for unknown rows (same reference, no refetch churn)", () => {
    const rows = [row()];
    const next = runsTableReducer(rows, {
      type: "streamEvent",
      event: event("nope", "success" as RunStatus),
    });
    expect(next).toEqual(rows);
    expect(next).not.toBe(rows);
    expect(next[0]).toBe(rows[0]);
  });

  it("stop: flips the row optimistically and reverts on failure", () => {
    const rows = [row({ status: "running" })];
    const stopped = runsTableReducer(rows, { type: "stopOptimistic", runId: "run-1" });
    expect(stopped[0]?.status).toBe("aborted");
    const reverted = runsTableReducer(stopped, {
      type: "stopFailed",
      runId: "run-1",
      previous: "running",
    });
    expect(reverted[0]?.status).toBe("running");
  });

  it("retry: optimistic queued row is replaced by the real run, or removed on failure", () => {
    const source = row({ status: "failed", task: "do it" });
    const optimistic = runsTableReducer([source], {
      type: "retryQueued",
      tempId: "temp-1",
      from: source,
    });
    expect(optimistic).toHaveLength(2);
    expect(optimistic[0]).toMatchObject({ id: "temp-1", status: "queued", task: "do it" });
    expect(optimistic[0]?.iteration).toBe(0);

    const real = row({ id: "real-1", status: "queued" });
    const resolved = runsTableReducer(optimistic, {
      type: "retryResolved",
      tempId: "temp-1",
      run: real,
    });
    expect(resolved.map((r) => r.id)).toEqual(["real-1", "run-1"]);

    const failed = runsTableReducer(optimistic, { type: "retryFailed", tempId: "temp-1" });
    expect(failed.map((r) => r.id)).toEqual(["run-1"]);
  });
});

describe("stop arm-confirm state machine", () => {
  it("requires a second click to confirm; escape/cancel disarm; done resets", () => {
    expect(nextStopConfirmState("idle", "click")).toBe("armed");
    expect(nextStopConfirmState("armed", "confirm")).toBe("stopping");
    expect(nextStopConfirmState("armed", "escape")).toBe("idle");
    expect(nextStopConfirmState("armed", "cancel")).toBe("idle");
    expect(nextStopConfirmState("stopping", "escape")).toBe("stopping");
    expect(nextStopConfirmState("stopping", "done")).toBe("idle");
    expect(nextStopConfirmState("idle", "confirm")).toBe("idle");
  });
});

describe("rowActionFor", () => {
  it("offers stop for live rows and retry for terminal ones", () => {
    expect(rowActionFor("queued")).toBe("stop");
    expect(rowActionFor("running")).toBe("stop");
    expect(rowActionFor("success")).toBe("retry");
    expect(rowActionFor("failed")).toBe("retry");
    expect(rowActionFor("aborted")).toBe("retry");
    expect(rowActionFor("interrupted")).toBe("retry");
  });
});
