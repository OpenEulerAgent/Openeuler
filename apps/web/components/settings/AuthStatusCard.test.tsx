// @vitest-environment jsdom
//
// Settings auth-status wiring (#92): the card asks the open
// GET /api/system/auth-status route and shows Auth enabled/disabled, plus
// the local token state when auth is on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AuthStatusCard } from "./AuthStatusCard";
import { clearStoredToken, storeToken } from "@/lib/token";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(createElement(AuthStatusCard)));
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const text = (): string => document.body.textContent ?? "";

beforeEach(() => {
  window.localStorage.clear();
  clearStoredToken();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  clearStoredToken();
});

describe("AuthStatusCard (#92)", () => {
  it("shows Auth disabled when the daemon answers authRequired:false", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ authRequired: false }));
    render();
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8787/api/system/auth-status",
      expect.objectContaining({ headers: expect.anything() }),
    );
    expect(text()).toContain("Auth disabled");
  });

  it("shows Auth enabled and the saved-token state when authRequired:true", async () => {
    storeToken("tok-en");
    fetchMock.mockResolvedValueOnce(jsonResponse({ authRequired: true }));
    render();
    await settle();

    expect(text()).toContain("Auth enabled");
    expect(text()).toContain("token saved in this browser");

    const forget = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Forget token",
    );
    expect(forget).toBeDefined();
    act(() => forget?.click());
    expect(text()).toContain("No token saved");
  });

  it("shows unknown when the daemon cannot be reached", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    render();
    await settle();

    expect(text()).toContain("unknown");
  });

  it("shows checking… before the answer lands", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    render();

    expect(text()).toContain("checking…");
  });
});
