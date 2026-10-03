// @vitest-environment jsdom
//
// Local-fallback banner (#106): renders "Running locally — Docker
// unavailable" only when the daemon reports docker down AND the project's
// policy wants a sandbox AND the run itself has no live sandbox info.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LocalFallbackBanner } from "./LocalFallbackBanner";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const BASE = "http://localhost:8787";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const statusRoute = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  available: false,
  mode: "unavailable",
  checkedAt: 1,
  ...overrides,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (props: { projectId?: string; sandboxPresent?: boolean }): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(LocalFallbackBanner, {
        projectId: props.projectId ?? "p1",
        sandboxPresent: props.sandboxPresent ?? false,
      }),
    );
  });
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe("LocalFallbackBanner (#106)", () => {
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

  const mountWith = async (
    statusBody: Record<string, unknown>,
    props: { projectId?: string; sandboxPresent?: boolean } = {},
  ): Promise<void> => {
    fetchMock.mockImplementationOnce(async () => jsonResponse(statusBody));
    render(props);
    await settle();
  };

  it("shows the banner for an auto-policy run without a sandbox while docker is down", async () => {
    await mountWith(statusRoute({ projectMode: "auto", effective: "local" }));
    const banner = document.querySelector("[data-local-fallback-banner]");
    expect(banner?.textContent).toBe("Running locally — Docker unavailable");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/api/sandbox/status?projectId=p1`);
  });

  it("hides when docker is available again", async () => {
    await mountWith(
      statusRoute({ available: true, mode: "docker", projectMode: "auto", effective: "sandbox" }),
    );
    expect(document.querySelector("[data-local-fallback-banner]")).toBeNull();
  });

  it("hides when the run itself executes sandboxed (sandbox info present)", async () => {
    await mountWith(statusRoute({ projectMode: "auto", effective: "local" }), {
      sandboxPresent: true,
    });
    expect(document.querySelector("[data-local-fallback-banner]")).toBeNull();
  });

  it("hides for local-policy projects (local by choice)", async () => {
    await mountWith(statusRoute({ projectMode: "local", effective: "local" }));
    expect(document.querySelector("[data-local-fallback-banner]")).toBeNull();
  });

  it("stays quiet when the status fetch fails", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: { code: "X" } }, 500));
    render({});
    await settle();
    expect(document.querySelector("[data-local-fallback-banner]")).toBeNull();
  });
});
