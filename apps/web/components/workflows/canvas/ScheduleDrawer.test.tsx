// @vitest-environment jsdom
//
// ScheduleDrawer (#121) round-trip: loads the schedule (or the fresh
// form), shows the humanized cron + upcoming-run preview (computed
// client-side from the same core cron code), validates inline, saves the
// full config via PUT, pauses/resumes via the header toggle and deletes
// after confirmation.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkflowSchedule } from "@openeuler/core";
import { ApiError } from "@/lib/api";
import { ScheduleDrawer } from "./ScheduleDrawer";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = async (node: ReactNode): Promise<void> => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

const schedule: WorkflowSchedule = {
  id: "sched-1",
  workflowId: "w1",
  enabled: true,
  cron: "30 9 * * 1-5",
  taskTemplate: "morning triage",
  timezone: "UTC",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

vi.mock("@/lib/schedules-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/schedules-api")>();
  return {
    ...original,
    fetchWorkflowSchedule: vi.fn(),
    putWorkflowSchedule: vi.fn(),
    deleteWorkflowSchedule: vi.fn(),
  };
});

const api = await import("@/lib/schedules-api");

const text = (): string => document.body.textContent ?? "";

const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === label) as
    HTMLButtonElement | undefined;

const change = async (selector: string, value: string): Promise<void> => {
  const input = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const drawer = () =>
  createElement(ScheduleDrawer, { open: true, workflowId: "w1", onClose: () => {} });

describe("ScheduleDrawer", () => {
  it("renders the fresh form (local timezone default) when none exists", async () => {
    vi.mocked(api.fetchWorkflowSchedule).mockResolvedValue(null);
    await render(drawer());
    expect(api.fetchWorkflowSchedule).toHaveBeenCalledWith("w1");
    const tz = document.querySelector("#schedule-timezone") as HTMLInputElement;
    expect(tz.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    // Humanized default cron + a non-empty upcoming preview.
    expect(document.querySelector("[data-schedule-humanized]")?.textContent).toContain("Monday");
    expect(document.querySelectorAll("[data-schedule-upcoming] li").length).toBe(5);
  });

  it("round-trips an existing schedule: status, humanized cron, upcoming runs", async () => {
    vi.mocked(api.fetchWorkflowSchedule).mockResolvedValue(schedule);
    await render(drawer());

    expect(document.querySelector("[data-schedule-status]")?.textContent).toContain("enabled");
    expect((document.querySelector("#schedule-cron") as HTMLInputElement).value).toBe(
      "30 9 * * 1-5",
    );
    expect((document.querySelector("#schedule-task") as HTMLTextAreaElement).value).toBe(
      "morning triage",
    );
    expect(document.querySelector("[data-schedule-humanized]")?.textContent).toContain(
      "Monday, Tuesday, Wednesday, Thursday and Friday at 09:30",
    );
    // Upcoming runs are ISO-labeled client-side previews.
    expect(document.querySelector("[data-schedule-upcoming]")?.textContent).toMatch(
      /T09:30:00\.000Z/,
    );
  });

  it("validates the cron inline and empties the preview on error", async () => {
    vi.mocked(api.fetchWorkflowSchedule).mockResolvedValue(schedule);
    await render(drawer());
    await change("#schedule-cron", "99 * * * *");
    expect(text()).toContain("Invalid schedule");
    expect(document.querySelector("[data-schedule-humanized]")?.textContent).toContain(
      "Invalid schedule: cron minute field",
    );
    expect(document.querySelectorAll("[data-schedule-upcoming] li")).toHaveLength(1);
    expect(document.querySelector("[data-schedule-upcoming]")?.textContent).toContain(
      "Fix the schedule above",
    );
    expect(button("Save schedule")?.disabled).toBe(true);
  });

  it("rejects unknown timezones inline", async () => {
    vi.mocked(api.fetchWorkflowSchedule).mockResolvedValue(schedule);
    await render(drawer());
    await change("#schedule-timezone", "Mars/Olympus");
    expect(text()).toContain("unknown timezone");
    expect(button("Save schedule")?.disabled).toBe(true);
  });

  it("saves the full config via PUT and adopts the stored row", async () => {
    vi.mocked(api.fetchWorkflowSchedule).mockResolvedValue(null);
    const saved: WorkflowSchedule = { ...schedule, id: "sched-2" };
    vi.mocked(api.putWorkflowSchedule).mockResolvedValue(saved);
    await render(drawer());

    await change("#schedule-task", "nightly sweep");
    await act(async () => {
      button("Save schedule")?.click();
    });
    expect(api.putWorkflowSchedule).toHaveBeenCalledWith({
      workflowId: "w1",
      config: {
        enabled: true,
        cron: "30 9 * * 1-5",
        taskTemplate: "nightly sweep",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      },
    });
    expect(document.querySelector("[data-schedule-status]")?.textContent).toContain("enabled");
  });

  it("pause toggle PUTs the inverted enabled flag", async () => {
    vi.mocked(api.fetchWorkflowSchedule).mockResolvedValue(schedule);
    vi.mocked(api.putWorkflowSchedule).mockResolvedValue({ ...schedule, enabled: false });
    await render(drawer());

    await act(async () => {
      button("Pause")?.click();
    });
    expect(api.putWorkflowSchedule).toHaveBeenCalledWith({
      workflowId: "w1",
      config: {
        enabled: false,
        cron: "30 9 * * 1-5",
        taskTemplate: "morning triage",
        timezone: "UTC",
      },
    });
    expect(document.querySelector("[data-schedule-status]")?.textContent).toContain("paused");
    expect(button("Resume")).toBeTruthy();
  });

  it("delete confirms first, then removes and empties the form", async () => {
    vi.mocked(api.fetchWorkflowSchedule).mockResolvedValue(schedule);
    vi.mocked(api.deleteWorkflowSchedule).mockResolvedValue(undefined);
    vi.mocked(api.fetchWorkflowSchedule).mockResolvedValueOnce(schedule).mockResolvedValue(null);
    await render(drawer());

    await act(async () => {
      button("Delete")?.click();
    });
    expect(api.deleteWorkflowSchedule).not.toHaveBeenCalled();
    expect(text()).toContain("Delete this schedule?");

    await act(async () => {
      button("Delete schedule")?.click();
    });
    expect(api.deleteWorkflowSchedule).toHaveBeenCalledWith("w1");
    expect(document.querySelector("#schedule-cron")).toBeTruthy(); // fresh form again
  });

  it("surfaces load failures inline", async () => {
    vi.mocked(api.fetchWorkflowSchedule).mockRejectedValue(
      new ApiError("NETWORK_ERROR", "no daemon", 0),
    );
    await render(drawer());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("no daemon");
  });
});
