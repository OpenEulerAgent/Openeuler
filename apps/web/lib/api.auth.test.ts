// @vitest-environment jsdom
//
// apiFetch auth behavior (#92): header injection from the stored token and
// the 401 → token-gate hand-off (notify + pending retry).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "./api";
import { onUnauthorized, takePendingRetry, __clearPendingRetry } from "./auth-gate";
import {
  clearStoredToken,
  getStoredToken,
  storeToken,
  TOKEN_STORAGE_KEY,
  __resetMemoryToken,
} from "./token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  __clearPendingRetry();
  __resetMemoryToken();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const lastRequest = (): { url: string; headers: Headers } => {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined];
  if (!call) throw new Error("no fetch was made");
  return {
    url: call[0] as string,
    headers: new Headers(call[1]?.headers as HeadersInit | undefined),
  };
};

describe("apiFetch header injection (#92)", () => {
  it("sends Authorization: Bearer when a token is stored", async () => {
    storeToken("tok-en");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await apiFetch("/api/projects");
    const { url, headers } = lastRequest();
    expect(url).toBe("http://localhost:8787/api/projects");
    expect(headers.get("authorization")).toBe("Bearer tok-en");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("omits Authorization when nothing is stored", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await apiFetch("/api/projects");
    expect(lastRequest().headers.get("authorization")).toBeNull();
  });

  it("lets an explicit init Authorization win over the stored token", async () => {
    storeToken("stored-token");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await apiFetch("/api/projects", { headers: { Authorization: "Bearer explicit" } });
    expect(lastRequest().headers.get("authorization")).toBe("Bearer explicit");
  });
});

describe("apiFetch 401 interception (#92)", () => {
  it("notifies the gate and registers a retry on 401", async () => {
    const calls: number[] = [];
    const stop = onUnauthorized(() => calls.push(1));

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } }, 401),
    );
    await expect(apiFetch("/api/projects")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
    expect(calls).toEqual([1]);

    // The pending retry replays the SAME request; it reads the token from
    // storage at call time, so storing a good token first makes it succeed.
    storeToken("fixed-token");
    fetchMock.mockResolvedValueOnce(jsonResponse({ projects: [] }));
    const retry = takePendingRetry();
    await expect(retry?.()).resolves.toEqual({ projects: [] });
    expect(lastRequest().headers.get("authorization")).toBe("Bearer fixed-token");

    stop();
    clearStoredToken();
  });

  it("does not notify on other HTTP errors", async () => {
    const calls: number[] = [];
    const stop = onUnauthorized(() => calls.push(1));

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "INTERNAL_ERROR", message: "boom" } }, 500),
    );
    await expect(apiFetch("/api/projects")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toEqual([]);
    expect(takePendingRetry()).toBeNull();

    stop();
  });

  it("reads the token from localStorage (the documented store)", async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "from-local-storage");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await apiFetch("/api/projects");
    expect(getStoredToken()).toBe("from-local-storage");
    expect(lastRequest().headers.get("authorization")).toBe("Bearer from-local-storage");
    clearStoredToken();
  });
});
