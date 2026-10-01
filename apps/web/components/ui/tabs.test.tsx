import { describe, expect, it } from "vitest";
import { nextTabId, tabId, tabPanelId, tabPanelProps, type TabItem } from "./tabs.js";

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

describe("tab ↔ panel id wiring", () => {
  it("tabPanelProps pairs the panel with its tab via id/aria-labelledby", () => {
    expect(tabPanelProps("files")).toEqual({
      id: "tab-panel-files",
      role: "tabpanel",
      "aria-labelledby": "tab-files",
      tabIndex: 0,
    });
  });

  it("derives matching tab and panel ids from the same tab id", () => {
    expect(tabId("runs")).toBe("tab-runs");
    expect(tabPanelId("runs")).toBe("tab-panel-runs");
  });
});
