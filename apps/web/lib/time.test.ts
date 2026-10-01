import { describe, expect, it } from "vitest";
import { formatDuration, formatRelativeAge, isLiveStatus, runDuration } from "./time";

describe("formatDuration", () => {
  it("renders sub-second as milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(450)).toBe("450ms");
  });

  it("renders seconds, minutes and compound forms", () => {
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(180_000)).toBe("3m");
    expect(formatDuration(200_000)).toBe("3m 20s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(7_320_000)).toBe("2h 02m");
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
  });

  it("clamps clock skew to zero", () => {
    expect(formatDuration(-5_000)).toBe("0ms");
  });
});

describe("formatRelativeAge", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");

  it("buckets common ages", () => {
    expect(formatRelativeAge(new Date(now - 10_000).toISOString(), now)).toBe("just now");
    expect(formatRelativeAge(new Date(now - 4 * 60_000).toISOString(), now)).toBe("4m ago");
    expect(formatRelativeAge(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3h ago");
    expect(formatRelativeAge(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe("2d ago");
  });

  it("falls back to a date past two weeks, and to a dash on garbage", () => {
    expect(formatRelativeAge("2026-09-01T12:00:00Z", now)).toBe("9/1/2026");
    expect(formatRelativeAge("not-a-date", now)).toBe("—");
  });
});

describe("runDuration", () => {
  const created = "2026-10-01T11:00:00Z";
  const updated = "2026-10-01T11:02:30Z";
  const now = Date.parse("2026-10-01T11:05:00Z");

  it("spans createdAt → updatedAt once terminal", () => {
    expect(runDuration({ createdAt: created, updatedAt: updated, status: "success" }, now)).toBe(
      150_000,
    );
  });

  it("spans createdAt → now while queued/running", () => {
    expect(runDuration({ createdAt: created, updatedAt: updated, status: "running" }, now)).toBe(
      300_000,
    );
    expect(isLiveStatus("queued")).toBe(true);
    expect(isLiveStatus("success")).toBe(false);
  });
});
