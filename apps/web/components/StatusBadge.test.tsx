import { describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import { statusBadgeStyle, type BadgeStatus } from "./StatusBadge.js";

const RUN_STATUSES: RunStatus[] = [
  "queued",
  "running",
  "success",
  "failed",
  "aborted",
  "interrupted",
];

describe("statusBadgeStyle", () => {
  it("maps every run status plus neutral", () => {
    for (const status of [...RUN_STATUSES, "neutral"] as BadgeStatus[]) {
      const style = statusBadgeStyle(status);
      expect(style.label.length).toBeGreaterThan(0);
      expect(style.className).toMatch(/bg-\w+-100 text-\w+-\d00/);
    }
  });

  it("labels statuses in sentence case", () => {
    const entries = RUN_STATUSES.map(
      (status) => [status, statusBadgeStyle(status).label] as const,
    );
    expect(Object.fromEntries(entries)).toEqual({
      queued: "Queued",
      running: "Running",
      success: "Success",
      failed: "Failed",
      aborted: "Aborted",
      interrupted: "Interrupted",
    });
  });

  it("uses green for success and red for failed", () => {
    expect(statusBadgeStyle("success").className).toContain("bg-emerald-100");
    expect(statusBadgeStyle("failed").className).toContain("bg-red-100");
  });
});
