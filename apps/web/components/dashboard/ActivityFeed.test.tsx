// @vitest-environment jsdom
//
// ActivityFeed ops rows (#94): daemon-level `ops.*` events (boot, recovery
// sweep, GC) render as one small gray system line — message + relative age,
// no badge, no glyph bubble, no run link — while regular entity rows keep
// their badge/link rendering.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ActivityItem, ActivityType } from "@/lib/activity";
import { isOpsActivityType } from "@/lib/activity";
import { ActivityFeed } from "./ActivityFeed";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

const OPS_TYPES: ActivityType[] = ["ops.daemon-boot", "ops.recovery-sweep", "ops.gc"];

const REGULAR_TYPES: ActivityType[] = [
  "project.created",
  "workflow.created",
  "run.started",
  "run.completed",
  "run.failed",
  "run.aborted",
  "run.interrupted",
];

const items: ActivityItem[] = [
  {
    id: 3,
    type: "ops.recovery-sweep",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    message: "Boot recovery sweep: 1 interrupted run, 0 orphaned worktrees",
  },
  {
    id: 2,
    type: "run.completed",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    project: { id: "p-1", name: "repo" },
    run: { id: "run-1", status: "success", branch: "openeuler/run-1" },
    message: "Run repo completed",
  },
  {
    id: 1,
    type: "ops.daemon-boot",
    createdAt: new Date(Date.now() - 300_000).toISOString(),
    message: "Daemon v0.0.4 started",
  },
];

let root: Root | null = null;
let container: HTMLElement | null = null;

const render = (node: ReactNode): void => {
  if (container === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(node);
  });
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ items }), { status: 200 }));
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const feedRows = (): HTMLElement[] =>
  [...document.querySelectorAll('[aria-label="Activity feed"] > li')] as HTMLElement[];

const opsRows = (): HTMLElement[] =>
  [...document.querySelectorAll("[data-testid=activity-ops-item]")] as HTMLElement[];

describe("isOpsActivityType (feed mapping)", () => {
  it("classifies exactly the ops.* types as system rows", () => {
    for (const type of OPS_TYPES) expect(isOpsActivityType(type)).toBe(true);
    for (const type of REGULAR_TYPES) expect(isOpsActivityType(type)).toBe(false);
  });
});

describe("ActivityFeed ops rendering (#94)", () => {
  it("renders ops.* items as small gray system lines with no badge", async () => {
    render(createElement(ActivityFeed));
    await settle();

    expect(feedRows()).toHaveLength(3);

    const ops = opsRows();
    expect(ops).toHaveLength(2);
    const [sweep, boot] = ops as [HTMLElement, HTMLElement];
    expect(sweep.textContent).toContain("Boot recovery sweep: 1 interrupted run");
    // Small system line: the raw type segment (badge label) never renders.
    expect(sweep.textContent).not.toContain("recovery-sweep");
    expect(boot.textContent).toContain("Daemon v0.0.4 started");
    expect(boot.textContent).not.toContain("daemon-boot");
    // No run link on system rows.
    expect(boot.querySelector("a")).toBeNull();

    // Regular rows keep their badge ("completed") and run link.
    const regular = feedRows().find(
      (row) => !(row as HTMLElement).hasAttribute("data-testid"),
    ) as HTMLElement;
    expect(regular.textContent).toContain("Run repo completed");
    expect(regular.textContent).toContain("completed");
    expect(regular.querySelector("a")?.getAttribute("href")).toBe("/runs/run-1");
  });
});
