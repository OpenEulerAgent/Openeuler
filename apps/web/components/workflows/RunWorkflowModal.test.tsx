// @vitest-environment jsdom
//
// Run workflow modal (#106): effective-mode hint line under the task field —
// "effective: local (Docker unavailable)" when the project policy is auto and
// the daemon reports docker down; quiet while the status loads or fails.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Workflow } from "@openeuler/core";
import { RunWorkflowModal } from "./RunWorkflowModal";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const BASE = "http://localhost:8787";

const workflow: Workflow = {
  id: "wf-1",
  projectId: "p-1",
  name: "demo flow",
  steps: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as Workflow;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const statusRoute = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  available: false,
  mode: "unavailable",
  checkedAt: 1,
  ...overrides,
});

const nav = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/projects/p-1/workflows",
  useSearchParams: () => new URLSearchParams(),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(RunWorkflowModal, { workflow, onClose: () => {} }));
  });
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const hint = (): string | null =>
  document.querySelector("[data-effective-mode-hint]")?.textContent ?? null;

describe("RunWorkflowModal effective-mode hint (#106)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    nav.push.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  it("shows the local-fallback hint for an auto project while docker is down", async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(statusRoute({ projectMode: "auto", effective: "local" })),
    );
    render();
    await settle();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/api/sandbox/status?projectId=p-1`);
    expect(hint()).toBe("effective: local (Docker unavailable)");
  });

  it("shows the detected-sandbox hint when docker is available", async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(
        statusRoute({ available: true, mode: "docker", projectMode: "auto", effective: "sandbox" }),
      ),
    );
    render();
    await settle();

    expect(hint()).toBe("effective: sandbox (Docker detected)");
  });

  it("stays quiet while the status is loading or unreachable", async () => {
    fetchMock.mockImplementationOnce(async () => new Promise(() => {}));
    render();
    await settle();
    expect(hint()).toBeNull();
  });

  it("stays quiet when the status fetch fails", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: { code: "X" } }, 500));
    render();
    await settle();
    expect(hint()).toBeNull();
  });
});
