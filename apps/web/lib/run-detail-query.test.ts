import { describe, expect, it } from "vitest";
import {
  diffDeepLink,
  isRunDetailTab,
  parseRunDetailQuery,
  runDetailHref,
  runDetailQuery,
  RUN_DETAIL_TABS,
} from "./run-detail-query";

describe("run-detail query helpers", () => {
  it("parses tab + stepRunId and rejects unknown values", () => {
    expect(parseRunDetailQuery("?tab=diff&stepRunId=sr-1")).toEqual({
      tab: "diff",
      stepRunId: "sr-1",
    });
    expect(parseRunDetailQuery("?tab=graph")).toEqual({ tab: "graph", stepRunId: null });
    expect(parseRunDetailQuery("?tab=bogus")).toEqual({ tab: null, stepRunId: null });
    expect(parseRunDetailQuery("")).toEqual({ tab: null, stepRunId: null });
    expect(parseRunDetailQuery("?stepRunId=")).toEqual({ tab: null, stepRunId: null });
  });

  it("round-trips the canonical query string", () => {
    expect(runDetailQuery({ tab: "diff", stepRunId: "sr 1" })).toBe("?tab=diff&stepRunId=sr+1");
    expect(runDetailQuery({})).toBe("");
    expect(runDetailQuery({ tab: null, stepRunId: null })).toBe("");
  });

  it("builds the node drawer's diff deep link", () => {
    expect(diffDeepLink("run/1", "sr-9")).toBe("/runs/run%2F1?tab=diff&stepRunId=sr-9");
  });

  it("builds plain run hrefs with optional tabs", () => {
    expect(runDetailHref("r1")).toBe("/runs/r1");
    expect(runDetailHref("r1", "timeline")).toBe("/runs/r1?tab=timeline");
  });

  it("knows the tab roster", () => {
    expect(RUN_DETAIL_TABS.map((tab) => tab.id)).toEqual(["graph", "events", "diff", "timeline"]);
    expect(isRunDetailTab("graph")).toBe(true);
    expect(isRunDetailTab("nope")).toBe(false);
    expect(isRunDetailTab(null)).toBe(false);
  });
});
