import { describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import { statusMeta, STATUS_META, type BadgeStatus } from "@/components/ui/badge";

const RUN_STATUSES: RunStatus[] = [
  "queued",
  "running",
  "success",
  "failed",
  "aborted",
  "interrupted",
];

describe("statusMeta (StatusBadge mapping)", () => {
  it("maps every run status plus neutral", () => {
    for (const status of [...RUN_STATUSES, "neutral"] as BadgeStatus[]) {
      const meta = statusMeta(status);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.variant).toBeTruthy();
    }
  });

  it("labels statuses in sentence case", () => {
    const entries = RUN_STATUSES.map((status) => [status, statusMeta(status).label] as const);
    expect(Object.fromEntries(entries)).toEqual({
      queued: "Queued",
      running: "Running",
      success: "Success",
      failed: "Failed",
      aborted: "Aborted",
      interrupted: "Interrupted",
    });
  });

  it("uses success tone for success and danger tone for failed", () => {
    expect(statusMeta("success").variant).toBe("success");
    expect(statusMeta("failed").variant).toBe("danger");
    expect(statusMeta("running").variant).toBe("info");
    expect(statusMeta("queued").variant).toBe("neutral");
  });

  it("keeps every variant a known Badge variant", () => {
    const variants = new Set(Object.values(STATUS_META).map((meta) => meta.variant));
    for (const variant of variants) {
      expect(["neutral", "accent", "success", "warning", "danger", "info", "outline"]).toContain(
        variant,
      );
    }
  });

  it("maps every status exactly once (no collisions, no gaps)", () => {
    const keys = Object.keys(STATUS_META);
    expect(new Set(keys).size).toBe(keys.length);
    for (const status of [...RUN_STATUSES, "neutral"] as BadgeStatus[]) {
      expect(keys).toContain(status);
    }
  });
});
