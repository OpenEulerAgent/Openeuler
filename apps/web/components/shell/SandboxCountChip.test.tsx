// @vitest-environment jsdom
//
// Sidebar sandboxes chip (#112): renders "Sandboxes: N active" and links to
// the dashboard's sandboxes anchor; stays hidden while unknown or zero.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SandboxCountChip } from "./SandboxCountChip";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const instancesResponse = (statuses: string[]): Response =>
  jsonResponse({
    instances: statuses.map((status, index) => ({
      id: `sb-${index}`,
      runId: `run-${index}`,
      image: "openeuler/worker:latest",
      status,
      startedAt: 1,
    })),
    checkedAt: 1,
  });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(SandboxCountChip));
  });
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe("SandboxCountChip (#112)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  it("renders the running count and links to the dashboard section", async () => {
    fetchMock.mockImplementationOnce(async () =>
      instancesResponse(["running", "running", "exited"]),
    );
    render();
    await settle();

    const chip = document.querySelector('[data-testid="sandbox-count-chip"]');
    expect(chip?.textContent).toContain("Sandboxes");
    expect(chip?.textContent).toContain("2 active");
    expect(chip?.getAttribute("href")).toBe("/#sandboxes");
  });

  it("stays hidden while no sandbox is running", async () => {
    fetchMock.mockImplementationOnce(async () => instancesResponse(["exited"]));
    render();
    await settle();
    expect(document.querySelector('[data-testid="sandbox-count-chip"]')).toBeNull();
  });

  it("stays hidden when the count cannot be fetched", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: { code: "X" } }, 500));
    render();
    await settle();
    expect(document.querySelector('[data-testid="sandbox-count-chip"]')).toBeNull();
  });
});
