// @vitest-environment jsdom
//
// Docker availability pill (#106): "Docker ready" / "Docker unavailable"
// labels off the status endpoint, muted while checking, unknown on failure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DockerPill } from "./DockerPill";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(DockerPill));
  });
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe("DockerPill (#106)", () => {
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

  it("renders Docker ready when the daemon reports docker available", async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ available: true, version: "27.3.1", mode: "docker", checkedAt: 1 }),
    );
    render();
    await settle();

    const pill = document.querySelector('[role="status"]');
    expect(pill?.textContent).toBe("Docker ready");
    expect(pill?.getAttribute("title")).toBe("docker 27.3.1");
  });

  it("renders Docker unavailable when the daemon reports docker down", async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ available: false, mode: "unavailable", checkedAt: 2 }),
    );
    render();
    await settle();

    expect(document.querySelector('[role="status"]')?.textContent).toBe("Docker unavailable");
  });

  it("renders the muted unknown state when the status cannot be fetched", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: { code: "X" } }, 500));
    render();
    await settle();

    expect(document.querySelector('[role="status"]')?.textContent).toBe("Docker status unknown");
  });
});
