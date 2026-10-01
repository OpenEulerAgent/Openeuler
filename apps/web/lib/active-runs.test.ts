import { describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import {
  activeRunsByProject,
  activeRunsCounts,
  mergeRunStatusIntoMap,
  type ActiveRunInfo,
} from "./active-runs";

describe("activeRunsCounts", () => {
  it("totals queued vs running", () => {
    expect(
      activeRunsCounts([
        { id: "a", status: "queued" },
        { id: "b", status: "running" },
        { id: "c", status: "running" },
      ]),
    ).toEqual({ queued: 1, running: 2 });
    expect(activeRunsCounts([])).toEqual({ queued: 0, running: 0 });
  });
});

describe("activeRunsByProject (project card counts)", () => {
  it("groups per project and skips entries without one", () => {
    expect(
      activeRunsByProject([
        { id: "a", status: "queued", projectId: "p1" },
        { id: "b", status: "running", projectId: "p1" },
        { id: "c", status: "running", projectId: "p2" },
        { id: "d", status: "queued" },
      ]),
    ).toEqual({
      p1: { queued: 1, running: 1 },
      p2: { queued: 0, running: 1 },
    });
  });
});

describe("mergeRunStatusIntoMap", () => {
  it("upserts live statuses and evicts terminal ones", () => {
    let map: Map<string, ActiveRunInfo> = new Map([
      ["a", { id: "a", status: "running", projectId: "p1" }],
    ]);

    map = mergeRunStatusIntoMap(map, { runId: "b", status: "queued", projectId: "p2" });
    expect(map.get("b")).toEqual({ id: "b", status: "queued", projectId: "p2" });

    map = mergeRunStatusIntoMap(map, { runId: "b", status: "running" });
    expect(map.get("b")).toEqual({ id: "b", status: "running", projectId: "p2" });

    map = mergeRunStatusIntoMap(map, { runId: "a", status: "success" as RunStatus });
    expect(map.has("a")).toBe(false);
  });
});
