import { describe, expect, it } from "vitest";
import { nextTabId, type TabItem } from "./tabs.js";

const tabs: ReadonlyArray<TabItem<string>> = [
  { id: "files", label: "Files" },
  { id: "workflows", label: "Workflows" },
  { id: "runs", label: "Runs" },
];

describe("nextTabId (Tabs keyboard navigation)", () => {
  it("ArrowRight moves forward with wrap-around", () => {
    expect(nextTabId("ArrowRight", tabs, "files")).toBe("workflows");
    expect(nextTabId("ArrowRight", tabs, "runs")).toBe("files");
  });

  it("ArrowLeft moves backward with wrap-around", () => {
    expect(nextTabId("ArrowLeft", tabs, "files")).toBe("runs");
    expect(nextTabId("ArrowLeft", tabs, "workflows")).toBe("files");
  });

  it("Home/End jump to the ends", () => {
    expect(nextTabId("Home", tabs, "runs")).toBe("files");
    expect(nextTabId("End", tabs, "files")).toBe("runs");
  });

  it("ignores unrelated keys and unknown current ids", () => {
    expect(nextTabId("Enter", tabs, "files")).toBeNull();
    expect(nextTabId("ArrowRight", tabs, "nope")).toBeNull();
  });
});
