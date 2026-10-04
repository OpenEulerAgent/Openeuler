import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowSchedule } from "@openeuler/core";
import { ApiError } from "./api";
import {
  deleteWorkflowSchedule,
  fetchWorkflowSchedule,
  isScheduleMissing,
  localTimezone,
  putWorkflowSchedule,
} from "./schedules-api";

/** Minimal stand-in for apiFetch: records the call, replies canned JSON. */
const fetcher = vi.fn();

const schedule: WorkflowSchedule = {
  id: "sched-1",
  workflowId: "w1",
  enabled: true,
  cron: "30 9 * * 1-5",
  taskTemplate: "morning triage",
  timezone: "America/New_York",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  fetcher.mockReset();
});

describe("fetchWorkflowSchedule", () => {
  it("GETs the schedule", async () => {
    fetcher.mockResolvedValue({ schedule });
    await expect(fetchWorkflowSchedule("w1", fetcher)).resolves.toEqual(schedule);
    expect(fetcher).toHaveBeenCalledWith("/api/workflows/w1/schedule");
  });

  it("returns null on 404 SCHEDULE_NOT_FOUND, rethrows everything else", async () => {
    fetcher.mockRejectedValue(new ApiError("SCHEDULE_NOT_FOUND", "none", 404));
    await expect(fetchWorkflowSchedule("w1", fetcher)).resolves.toBeNull();

    fetcher.mockRejectedValue(new ApiError("HTTP_ERROR", "boom", 500));
    await expect(fetchWorkflowSchedule("w1", fetcher)).rejects.toBeInstanceOf(ApiError);
    expect(isScheduleMissing(new ApiError("SCHEDULE_NOT_FOUND", "none", 404))).toBe(true);
    expect(isScheduleMissing(new ApiError("OTHER", "none", 404))).toBe(false);
  });

  it("encodes the workflow id", async () => {
    fetcher.mockRejectedValue(new ApiError("SCHEDULE_NOT_FOUND", "none", 404));
    await fetchWorkflowSchedule("a/b c", fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/workflows/a%2Fb%20c/schedule");
  });
});

describe("putWorkflowSchedule", () => {
  it("PUTs the full config and returns the stored schedule", async () => {
    fetcher.mockResolvedValue({ schedule });
    const saved = await putWorkflowSchedule({
      workflowId: "w1",
      config: {
        enabled: true,
        cron: "30 9 * * 1-5",
        taskTemplate: "morning triage",
        timezone: "America/New_York",
      },
      fetcher,
    });
    expect(saved.id).toBe("sched-1");
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/workflows/w1/schedule");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      enabled: true,
      cron: "30 9 * * 1-5",
      taskTemplate: "morning triage",
      timezone: "America/New_York",
    });
  });
});

describe("deleteWorkflowSchedule", () => {
  it("DELETEs the schedule", async () => {
    fetcher.mockResolvedValue(undefined);
    await deleteWorkflowSchedule("w1", fetcher);
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/workflows/w1/schedule");
    expect(init.method).toBe("DELETE");
  });
});

describe("localTimezone", () => {
  it("returns a non-empty IANA zone (UTC fallback)", () => {
    const zone = localTimezone();
    expect(zone.length).toBeGreaterThan(0);
    expect(zone).toMatch(/^[A-Za-z_]+\/[A-Za-z_+0-9-]+$|UTC/);
  });
});
