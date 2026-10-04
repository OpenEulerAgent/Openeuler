import { describe, expect, it, vi } from "vitest";
import {
  artifactPathToUrl,
  downloadRunArtifact,
  fetchRunArtifacts,
  formatArtifactSize,
  type RunArtifactsBody,
} from "./artifacts-api";

const manifest: RunArtifactsBody = {
  runId: "r1",
  runStatus: "success",
  capturedAt: "2026-01-01T00:00:00.000Z",
  patterns: ["dist/**"],
  files: [
    { path: "dist/app.js", size: 1024 },
    { path: "dist/assets/style.css", size: 15_728_640 },
  ],
  totalBytes: 15_729_664,
  truncated: false,
};

describe("fetchRunArtifacts", () => {
  it("requests the manifest endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(manifest);
    const body = await fetchRunArtifacts("r/1", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/runs/r%2F1/artifacts");
    expect(body).toEqual(manifest);
  });
});

describe("artifactPathToUrl", () => {
  it("encodes each segment but keeps slashes", () => {
    expect(artifactPathToUrl("dist/a b/c#d.js")).toBe("dist/a%20b/c%23d.js");
    expect(artifactPathToUrl("dist/app.js")).toBe("dist/app.js");
  });

  it("drops empty segments", () => {
    expect(artifactPathToUrl("dist//a.js")).toBe("dist/a.js");
  });
});

describe("downloadRunArtifact", () => {
  it("fetches with the auth header and saves the blob under the basename", async () => {
    const blob = new Blob(["bytes"]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(blob, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    const save = vi.fn();

    await downloadRunArtifact("r1", "dist/app.js", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      save,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as [string, RequestInit | undefined];
    expect(calledUrl).toContain("/api/runs/r1/artifacts/dist/app.js");
    // No stored token → no Authorization header (token gate handles prompts).
    expect(init?.headers).toEqual({});
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1]).toBe("app.js");
  });

  it("throws the daemon error message on failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "nope" } }), { status: 404 }),
      );
    await expect(
      downloadRunArtifact("r1", "dist/x.js", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow("nope");
  });
});

describe("formatArtifactSize", () => {
  it("formats bytes, KiB and MiB", () => {
    expect(formatArtifactSize(0)).toBe("0 B");
    expect(formatArtifactSize(512)).toBe("512 B");
    expect(formatArtifactSize(1024)).toBe("1.0 KiB");
    expect(formatArtifactSize(15_728_640)).toBe("15 MiB");
  });
});
