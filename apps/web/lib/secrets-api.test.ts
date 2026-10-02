import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  deleteProjectSecret,
  fetchProjectSecrets,
  isSecretsUnavailable,
  putProjectSecret,
  secretNameIssue,
} from "./secrets-api";

/** Minimal stand-in for apiFetch: records the call, replies canned JSON. */
const fetcher = vi.fn();

beforeEach(() => {
  fetcher.mockReset();
});

describe("fetchProjectSecrets", () => {
  it("GETs the project secrets list and returns it", async () => {
    fetcher.mockResolvedValue({
      secrets: [{ name: "NPM_TOKEN", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    await expect(fetchProjectSecrets("p1", fetcher)).resolves.toEqual([
      { name: "NPM_TOKEN", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(fetcher).toHaveBeenCalledWith("/api/projects/p1/secrets");
  });

  it("encodes the project id", async () => {
    fetcher.mockResolvedValue({ secrets: [] });
    await fetchProjectSecrets("a/b c", fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/projects/a%2Fb%20c/secrets");
  });
});

describe("putProjectSecret", () => {
  it("PUTs name+value as JSON and returns the stored name row", async () => {
    fetcher.mockResolvedValue({ secret: { name: "API_KEY", createdAt: "x" } });
    await expect(putProjectSecret("p1", "API_KEY", "sk-1", fetcher)).resolves.toEqual({
      name: "API_KEY",
      createdAt: "x",
    });
    expect(fetcher).toHaveBeenCalledWith("/api/projects/p1/secrets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "API_KEY", value: "sk-1" }),
    });
  });
});

describe("deleteProjectSecret", () => {
  it("DELETEs the encoded name", async () => {
    fetcher.mockResolvedValue(undefined);
    await deleteProjectSecret("p1", "NPM_TOKEN", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/projects/p1/secrets/NPM_TOKEN", {
      method: "DELETE",
    });
  });
});

describe("secretNameIssue", () => {
  it("mirrors the daemon rules", () => {
    expect(secretNameIssue("NPM_TOKEN")).toBeNull();
    expect(secretNameIssue("_OK")).toBeNull();
    expect(secretNameIssue("A2")).toBeNull();
    expect(secretNameIssue("bad")).toBeTruthy();
    expect(secretNameIssue("1BAD")).toBeTruthy();
    expect(secretNameIssue("")).toBeTruthy();
    expect(secretNameIssue("X".repeat(65))).toBeTruthy();
  });
});

describe("isSecretsUnavailable", () => {
  it("matches only the daemon's SECRETS_UNAVAILABLE error code", () => {
    const unavailable = new ApiError("SECRETS_UNAVAILABLE", "no key", 503);
    const other = new ApiError("HTTP_ERROR", "boom", 500);
    expect(isSecretsUnavailable(unavailable)).toBe(true);
    expect(isSecretsUnavailable(other)).toBe(false);
    expect(isSecretsUnavailable(new Error("nope"))).toBe(false);
  });
});
