import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  deleteSandboxImage,
  effectiveModeHint,
  fetchSandboxImages,
  fetchSandboxJob,
  fetchSandboxStatus,
  imageRefOf,
  isImageInUseError,
  isImageNotFoundError,
  resolveEffectiveMode,
  showLocalFallbackBanner,
  startSandboxImageBuild,
  startSandboxImagePull,
  waitForSandboxJob,
  type SandboxFetcher,
  type SandboxImageEntry,
  type SandboxJob,
} from "./sandbox-api";

/**
 * Sandbox image API client tests (#100): request shapes (method/path/body)
 * against a mocked transport (the fetcher already parses JSON — same pattern
 * as settings.test.ts), the job-poll loop, and the typed-error predicates
 * the UI branches on.
 */

const image = (overrides: Partial<SandboxImageEntry> = {}): SandboxImageEntry => ({
  repository: "openeuler/worker",
  tag: "latest",
  id: "sha256:abc",
  sizeBytes: 12_500_000,
  createdAt: Date.UTC(2026, 9, 1, 10, 0, 0),
  ours: true,
  ...overrides,
});

const job = (overrides: Partial<SandboxJob> = {}): SandboxJob => ({
  id: "j1",
  kind: "pull",
  ref: "busybox:musl",
  status: "done",
  createdAt: 1,
  finishedAt: 2,
  ...overrides,
});

const asFetcher = (fn: ReturnType<typeof vi.fn>): SandboxFetcher => fn as unknown as SandboxFetcher;

describe("fetchSandboxImages (#100)", () => {
  it("GETs /api/sandbox/images and unwraps the images array", async () => {
    const fetcher = vi.fn(async () => ({ images: [image()] }));
    await expect(fetchSandboxImages(asFetcher(fetcher))).resolves.toEqual([image()]);
    expect(fetcher).toHaveBeenCalledWith("/api/sandbox/images");
  });
});

describe("startSandboxImagePull (#100)", () => {
  it("POSTs {ref} and returns the jobId", async () => {
    const inits: RequestInit[] = [];
    const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
      inits.push(init ?? {});
      return { jobId: "j1" };
    });
    await expect(startSandboxImagePull("busybox:musl", asFetcher(fetcher))).resolves.toEqual({
      jobId: "j1",
    });
    expect(fetcher).toHaveBeenCalledWith("/api/sandbox/images/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "busybox:musl" }),
    });
  });
});

describe("startSandboxImageBuild (#100)", () => {
  it("POSTs name/dockerfileText/baseRef verbatim and returns jobId + tag", async () => {
    const fetcher = vi.fn(async () => ({ jobId: "j2", tag: "openeuler/worker:latest" }));
    await expect(
      startSandboxImageBuild({ name: "worker", baseRef: "alpine:3.20" }, asFetcher(fetcher)),
    ).resolves.toEqual({ jobId: "j2", tag: "openeuler/worker:latest" });
    expect(fetcher).toHaveBeenCalledWith("/api/sandbox/images/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "worker", baseRef: "alpine:3.20" }),
    });
  });
});

describe("deleteSandboxImage (#100)", () => {
  it("DELETEs the percent-encoded ref (slashes survive)", async () => {
    const fetcher = vi.fn(async () => undefined);
    await deleteSandboxImage("openeuler/worker:latest", asFetcher(fetcher));
    expect(fetcher).toHaveBeenCalledWith("/api/sandbox/images/openeuler%2Fworker%3Alatest", {
      method: "DELETE",
    });
  });

  it("rejects with ApiError on 409 IMAGE_IN_USE", async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError("IMAGE_IN_USE", "used by 1 sandbox", 409);
    });
    const err = await deleteSandboxImage("openeuler/worker:latest", asFetcher(fetcher)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isImageInUseError(err)).toBe(true);
    expect(isImageNotFoundError(err)).toBe(false);
  });

  it("rejects with ApiError on 404 IMAGE_NOT_FOUND", async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError("IMAGE_NOT_FOUND", "no such image", 404);
    });
    const err = await deleteSandboxImage("openeuler/ghost:latest", asFetcher(fetcher)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isImageNotFoundError(err)).toBe(true);
    expect(isImageInUseError(err)).toBe(false);
  });

  it("predicates reject non-ApiError throwables", () => {
    expect(isImageInUseError(new Error("nope"))).toBe(false);
    expect(isImageInUseError(undefined)).toBe(false);
  });
});

describe("fetchSandboxJob + waitForSandboxJob (#100)", () => {
  it("fetches the job by id", async () => {
    const fetcher = vi.fn(async () => job());
    await expect(fetchSandboxJob("j1", asFetcher(fetcher))).resolves.toMatchObject({
      id: "j1",
      status: "done",
    });
    expect(fetcher).toHaveBeenCalledWith("/api/sandbox/jobs/j1");
  });

  it("polls while running and resolves the terminal job", async () => {
    const states = [
      job({ status: "running" }),
      job({ status: "running" }),
      job({ status: "failed", error: "boom" }),
    ];
    const fetcher = vi.fn(async () => states.shift() ?? job());
    const outcome = await waitForSandboxJob("j1", { pollMs: 0, fetcher: asFetcher(fetcher) });
    expect(outcome).toMatchObject({ status: "failed", error: "boom" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("resolves immediately when the job is already terminal", async () => {
    const fetcher = vi.fn(async () => job({ status: "done" }));
    const outcome = await waitForSandboxJob("j1", { pollMs: 5_000, fetcher: asFetcher(fetcher) });
    expect(outcome.status).toBe("done");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("propagates fetch failures mid-poll", async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError("NETWORK_ERROR", "down", 0);
    });
    await expect(
      waitForSandboxJob("j1", { pollMs: 0, fetcher: asFetcher(fetcher) }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});

describe("imageRefOf (#100)", () => {
  it("joins repository and tag", () => {
    expect(imageRefOf({ repository: "busybox", tag: "musl" })).toBe("busybox:musl");
    expect(imageRefOf(image({ repository: "openeuler/worker", tag: "latest" }))).toBe(
      "openeuler/worker:latest",
    );
  });
});

describe("fetchSandboxStatus (#106)", () => {
  it("GETs the plain status endpoint without a projectId", async () => {
    const fetcher = vi.fn(async () => ({
      available: true,
      version: "27.3.1",
      mode: "docker",
      checkedAt: 1,
    }));
    await expect(fetchSandboxStatus(undefined, asFetcher(fetcher))).resolves.toMatchObject({
      available: true,
      version: "27.3.1",
    });
    expect(fetcher).toHaveBeenCalledWith("/api/sandbox/status");
  });

  it("appends the percent-encoded projectId when given", async () => {
    const fetcher = vi.fn(async () => ({
      available: false,
      mode: "unavailable",
      checkedAt: 2,
      projectMode: "auto",
      effective: "local",
    }));
    await expect(fetchSandboxStatus("proj/1", asFetcher(fetcher))).resolves.toMatchObject({
      projectMode: "auto",
      effective: "local",
    });
    expect(fetcher).toHaveBeenCalledWith("/api/sandbox/status?projectId=proj%2F1");
  });
});

describe("resolveEffectiveMode (#106)", () => {
  it("mirrors the executor: sandbox stays, auto follows availability, else local", () => {
    expect(resolveEffectiveMode("sandbox", false)).toBe("sandbox");
    expect(resolveEffectiveMode("sandbox", true)).toBe("sandbox");
    expect(resolveEffectiveMode("auto", true)).toBe("sandbox");
    expect(resolveEffectiveMode("auto", false)).toBe("local");
    expect(resolveEffectiveMode("local", true)).toBe("local");
    expect(resolveEffectiveMode("local", false)).toBe("local");
  });
});

describe("showLocalFallbackBanner (#106)", () => {
  const base = { sandboxPresent: false, available: false };

  it("shows for auto/sandbox policies without a sandbox while docker is down", () => {
    expect(showLocalFallbackBanner({ ...base, projectMode: "auto" })).toBe(true);
    expect(showLocalFallbackBanner({ ...base, projectMode: "sandbox" })).toBe(true);
  });

  it("hides when the run has a live sandbox, the policy is local, or docker is up", () => {
    expect(showLocalFallbackBanner({ ...base, projectMode: "auto", sandboxPresent: true })).toBe(
      false,
    );
    expect(showLocalFallbackBanner({ ...base, projectMode: "local" })).toBe(false);
    expect(showLocalFallbackBanner({ ...base, projectMode: undefined })).toBe(false);
    expect(
      showLocalFallbackBanner({ sandboxPresent: false, projectMode: "auto", available: true }),
    ).toBe(false);
  });
});

describe("effectiveModeHint (#106)", () => {
  it("renders the detected-sandbox and unavailable-fallback hints", () => {
    expect(effectiveModeHint({ executionMode: "auto", available: true })).toBe(
      "effective: sandbox (Docker detected)",
    );
    expect(effectiveModeHint({ executionMode: "auto", available: false })).toBe(
      "effective: local (Docker unavailable)",
    );
  });

  it("is honest about the remaining corners", () => {
    expect(effectiveModeHint({ executionMode: "sandbox", available: true })).toBe(
      "effective: sandbox (Docker detected)",
    );
    expect(effectiveModeHint({ executionMode: "sandbox", available: false })).toBe(
      "effective: sandbox (Docker unavailable — sandbox runs will fail)",
    );
    expect(effectiveModeHint({ executionMode: "local", available: true })).toBe(
      "effective: local (policy: local)",
    );
    expect(effectiveModeHint({ executionMode: "local", available: false })).toBe(
      "effective: local (policy: local)",
    );
  });
});
