import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError, daemonBaseUrl, DEFAULT_DAEMON_URL } from "./api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

async function errorFrom(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw new Error(`expected ApiError, got ${String(error)}`);
  }
  throw new Error("expected promise to reject");
}

describe("daemonBaseUrl", () => {
  it("defaults to the local daemon", () => {
    expect(daemonBaseUrl(undefined)).toBe(DEFAULT_DAEMON_URL);
  });

  it("uses NEXT_PUBLIC_DAEMON_URL when provided", () => {
    expect(daemonBaseUrl("http://daemon.local:8787")).toBe("http://daemon.local:8787");
  });

  it("strips trailing slashes", () => {
    expect(daemonBaseUrl("http://daemon.local:8787/")).toBe("http://daemon.local:8787");
    expect(daemonBaseUrl("http://daemon.local:8787//")).toBe("http://daemon.local:8787");
  });

  it("reads process.env when no override is passed", () => {
    vi.stubEnv("NEXT_PUBLIC_DAEMON_URL", "http://env-daemon:8787/");
    try {
      expect(daemonBaseUrl()).toBe("http://env-daemon:8787");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("apiFetch", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON for a successful response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, version: "0.1.0", uptime: 5 }));

    await expect(apiFetch("/health")).resolves.toEqual({
      ok: true,
      version: "0.1.0",
      uptime: 5,
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${DEFAULT_DAEMON_URL}/health`,
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("normalizes daemon error bodies into ApiError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "NOT_FOUND", message: "No route for GET /nope" } }, 404),
    );

    const error = await errorFrom(apiFetch("/nope"));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("No route for GET /nope");
    expect(error.status).toBe(404);
  });

  it("carries currentRevision from a 409 REVISION_CONFLICT body (#76)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: "REVISION_CONFLICT",
            message: "workflow w1 is at revision 3, not the expected 1",
            details: { currentRevision: 3 },
          },
        },
        409,
      ),
    );

    const error = await errorFrom(apiFetch("/api/workflows/w1/graph"));
    expect(error.code).toBe("REVISION_CONFLICT");
    expect(error.status).toBe(409);
    expect(error.currentRevision).toBe(3);
    expect(error.details).toBeUndefined();
  });

  it("carries zod 422 validation details on ApiError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "promptTemplate must be a non-empty string",
            details: [
              {
                path: "steps.0.promptTemplate",
                message: "promptTemplate must be a non-empty string",
              },
              { path: "loopBack.maxIterations", message: "maxIterations must be an integer >= 1" },
            ],
          },
        },
        422,
      ),
    );

    const error = await errorFrom(apiFetch("/api/workflows"));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.status).toBe(422);
    expect(error.details).toEqual([
      { path: "steps.0.promptTemplate", message: "promptTemplate must be a non-empty string" },
      { path: "loopBack.maxIterations", message: "maxIterations must be an integer >= 1" },
    ]);
  });

  it("returns undefined for empty (204) bodies", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(apiFetch("/api/workflows/w-1")).resolves.toBeUndefined();
  });

  it("falls back to a generic code/message for non-JSON error bodies", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("boom", 500));

    const error = await errorFrom(apiFetch("/health"));
    expect(error.code).toBe("HTTP_ERROR");
    expect(error.message).toBe("Request failed with status 500");
    expect(error.status).toBe(500);
  });

  it("maps network failures to NETWORK_ERROR with status 0", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const error = await errorFrom(apiFetch("/health"));
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.status).toBe(0);
    expect(error.message).toContain(DEFAULT_DAEMON_URL);
  });

  it("maps malformed success bodies to BAD_JSON", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("not json", 200));

    const error = await errorFrom(apiFetch("/health"));
    expect(error.code).toBe("BAD_JSON");
    expect(error.status).toBe(200);
  });
});
