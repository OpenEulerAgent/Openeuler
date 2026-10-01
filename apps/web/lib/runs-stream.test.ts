import { describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import { applyRunStatusEvent, parseRunStatusStreamEvent, runsStreamUrl } from "./runs-stream";

describe("parseRunStatusStreamEvent", () => {
  it("parses a full frame with a pinned revision", () => {
    expect(
      parseRunStatusStreamEvent(
        JSON.stringify({
          runId: "r1",
          status: "running",
          projectId: "p1",
          workflowRevision: { id: "rev-3", number: 3 },
        }),
      ),
    ).toEqual({
      runId: "r1",
      status: "running",
      projectId: "p1",
      workflowRevision: { id: "rev-3", number: 3 },
    });
  });

  it("rejects malformed payloads", () => {
    expect(parseRunStatusStreamEvent("not json")).toBeNull();
    expect(parseRunStatusStreamEvent("42")).toBeNull();
    expect(parseRunStatusStreamEvent(JSON.stringify({ runId: "r1" }))).toBeNull();
    expect(
      parseRunStatusStreamEvent(
        JSON.stringify({ runId: "r1", status: "exploded", projectId: "p1" }),
      ),
    ).toBeNull();
    expect(
      parseRunStatusStreamEvent(JSON.stringify({ runId: "", status: "running", projectId: "p1" })),
    ).toBeNull();
  });
});

describe("applyRunStatusEvent (stream → row reducer)", () => {
  const rows = [
    { id: "r1", status: "queued" as RunStatus },
    { id: "r2", status: "running" as RunStatus },
  ];

  it("updates the matching row in place", () => {
    const next = applyRunStatusEvent(rows, { runId: "r1", status: "running", projectId: "p" });
    expect(next.map((row) => row.status)).toEqual(["running", "running"]);
  });

  it("leaves the array untouched for unknown ids and no-op transitions", () => {
    expect(applyRunStatusEvent(rows, { runId: "zz", status: "success", projectId: "p" })).toBe(
      rows,
    );
    expect(applyRunStatusEvent(rows, { runId: "r2", status: "running", projectId: "p" })).toBe(
      rows,
    );
  });
});

describe("runsStreamUrl", () => {
  it("points at the daemon's global stream", () => {
    expect(runsStreamUrl("http://localhost:8787")).toBe("http://localhost:8787/api/runs/stream");
  });
});
