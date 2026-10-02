import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type Db } from "@openeuler/db";
import {
  createDockerAvailabilityProbe,
  createDockerSandboxProvider,
  docker,
  type SandboxHandle,
} from "@openeuler/sandbox";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";
import type { SandboxJob } from "./sandbox.js";

/**
 * Sandbox image API against a REAL docker daemon (#100), gated to auto-skip
 * when docker is unavailable (same pattern as the sandbox package's
 * docker.integration.test.ts). Exercises the full async job lifecycle
 * (pull + build), the catalog's ours/common-base split, delete with the
 * in-use guard, and the ops completion events — then scrubs every container
 * and image it created.
 */

const PULL_REF = "busybox:musl";
const BUILD_BASE = "alpine:3.20";
const TEST_TAG = "sandbox-img-it";
const BUILD_NAME = `test-img-${randomBytes(3).toString("hex")}`;
const BUILD_TAG = `openeuler/${BUILD_NAME}:latest`;

const dockerLive =
  process.env.DOCKER_E2E === "0"
    ? false
    : await createDockerAvailabilityProbe().check({ force: true });

interface Harness {
  db: Db;
  dir: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

const handles: SandboxHandle[] = [];

let harness: Harness;

/** Polls the jobs endpoint until terminal; throws past the deadline. */
const waitForJob = async (jobId: string, deadlineMs = 240_000): Promise<SandboxJob> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const res = await harness.request(`/api/sandbox/jobs/${jobId}`);
    expect(res.status).toBe(200);
    const job = (await res.json()) as SandboxJob;
    if (job.status !== "running") return job;
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} (${job.ref}) did not finish within ${deadlineMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

const catalog = async (): Promise<Array<Record<string, unknown>>> => {
  const res = await harness.request("/api/sandbox/images");
  expect(res.status).toBe(200);
  return ((await res.json()) as { images: Array<Record<string, unknown>> }).images;
};

const postJson = (path: string, body: unknown): Promise<Response> =>
  harness.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe.skipIf(!dockerLive)("sandbox image API integration (real daemon)", () => {
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-it-"));
    const db = createDatabase({ path: join(dir, "test.db") });
    const { app } = createApp({
      db,
      logger: createLogger("silent"),
      sandbox: { provider: createDockerSandboxProvider() },
    });
    harness = {
      db,
      dir,
      request: (path, init) => Promise.resolve(app.request(path, init)),
    };
  });

  it("lists an initially non-empty daemon host without guessing", async () => {
    // Smoke: the catalog endpoint answers 200 with well-formed rows (whatever
    // this host happens to have under openeuler/ or the curated bases).
    const images = await catalog();
    for (const image of images) {
      expect(typeof image["repository"]).toBe("string");
      expect(typeof image["tag"]).toBe("string");
      expect(typeof image["ours"]).toBe("boolean");
      expect(typeof image["sizeBytes"]).toBe("number");
    }
  });

  it(
    "pulls busybox:musl via an async job and lists it as a common base",
    { timeout: 300_000 },
    async () => {
      const started = await postJson("/api/sandbox/images/pull", { ref: PULL_REF });
      expect(started.status).toBe(202);
      const { jobId } = (await started.json()) as { jobId: string };
      const job = await waitForJob(jobId);
      expect(job).toMatchObject({ kind: "pull", ref: PULL_REF, status: "done" });

      const images = await catalog();
      const pulled = images.find((image) => `${image["repository"]}:${image["tag"]}` === PULL_REF);
      expect(pulled).toBeDefined();
      expect(pulled?.["ours"]).toBe(false);
      expect(pulled?.["sizeBytes"]).toBeGreaterThan(0);
    },
  );

  it(
    "builds openeuler/<name>:latest from a stdin Dockerfile and lists it as ours",
    { timeout: 300_000 },
    async () => {
      const started = await postJson("/api/sandbox/images/build", {
        name: BUILD_NAME,
        dockerfileText: `FROM ${BUILD_BASE}\nLABEL openeuler.integration="${TEST_TAG}"\n`,
      });
      expect(started.status).toBe(202);
      const body = (await started.json()) as { jobId: string; tag: string };
      expect(body.tag).toBe(BUILD_TAG);
      const job = await waitForJob(body.jobId);
      expect(job).toMatchObject({ kind: "build", ref: BUILD_TAG, status: "done" });

      const images = await catalog();
      const built = images.find((image) => `${image["repository"]}:${image["tag"]}` === BUILD_TAG);
      expect(built).toBeDefined();
      expect(built?.["ours"]).toBe(true);
      expect(String(built?.["id"] ?? "")).toMatch(/^sha256:[0-9a-f]{64}$/);
    },
  );

  it("answers 404 IMAGE_NOT_FOUND for an unknown ref after inspecting", async () => {
    const ref = encodeURIComponent(`openeuler/no-such-${randomBytes(3).toString("hex")}:latest`);
    const res = await harness.request(`/api/sandbox/images/${ref}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("IMAGE_NOT_FOUND");
  });

  it(
    "refuses to delete an image a sandbox runs on (409), then deletes it once free",
    { timeout: 120_000 },
    async () => {
      const provider = createDockerSandboxProvider();
      const sandbox = await provider.create({
        runId: `run-${BUILD_NAME}`,
        image: BUILD_TAG,
        mounts: [],
        env: {},
        labels: { "openeuler-test": TEST_TAG },
      });
      handles.push(sandbox);

      const ref = encodeURIComponent(BUILD_TAG);
      const blocked = await harness.request(`/api/sandbox/images/${ref}`, { method: "DELETE" });
      expect(blocked.status).toBe(409);
      const blockedBody = (await blocked.json()) as {
        error: { code: string; details: { sandboxes: string[] } };
      };
      expect(blockedBody.error.code).toBe("IMAGE_IN_USE");
      expect(blockedBody.error.details.sandboxes).toEqual([sandbox.id]);

      await sandbox.destroy();
      const freed = await harness.request(`/api/sandbox/images/${ref}`, { method: "DELETE" });
      expect(freed.status).toBe(200);
      expect(await freed.json()).toEqual({ deleted: BUILD_TAG });

      const images = await catalog();
      expect(images.some((image) => `${image["repository"]}:${image["tag"]}` === BUILD_TAG)).toBe(
        false,
      );
    },
  );

  it("records ops completion events for pull and build jobs", async () => {
    const payloads = harness.db.activity
      .list({ limit: 100 })
      .filter((row) => row.type === "ops.image-pull" || row.type === "ops.image-build");
    const pull = payloads.find((row) => row.type === "ops.image-pull")?.payload;
    const build = payloads.find((row) => row.type === "ops.image-build")?.payload;
    expect(pull).toMatchObject({ ref: PULL_REF, done: true });
    expect(build).toMatchObject({ ref: BUILD_TAG, name: BUILD_NAME, done: true });
  });

  it("applies bearer auth when the daemon runs with a token", async () => {
    const { app } = createApp({
      db: harness.db,
      logger: createLogger("silent"),
      authToken: "sekret",
      sandbox: { provider: createDockerSandboxProvider() },
    });
    const rejected = await Promise.resolve(app.request("/api/sandbox/images"));
    expect(rejected.status).toBe(401);
    const ok = await Promise.resolve(
      app.request("/api/sandbox/images", { headers: { authorization: "Bearer sekret" } }),
    );
    expect(ok.status).toBe(200);
  });

  afterAll(async () => {
    for (const handle of handles) {
      await handle.destroy().catch(() => undefined);
    }
    // Containers: anything the suite labeled must be gone.
    const leftoverContainers = await docker(
      ["ps", "-aq", "--filter", `label=openeuler-test=${TEST_TAG}`],
      { timeoutMs: 30_000 },
    );
    for (const id of leftoverContainers.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)) {
      await docker(["rm", "-f", id], { timeoutMs: 30_000 });
    }
    const afterContainers = await docker(
      ["ps", "-aq", "--filter", `label=openeuler-test=${TEST_TAG}`],
      { timeoutMs: 30_000 },
    );
    if (afterContainers.stdout.trim() !== "") {
      throw new Error(`sandbox image suite left containers behind: ${afterContainers.stdout}`);
    }

    // Images: the built test image must be gone; pulled bases removed
    // best-effort (another process on the host may have adopted them).
    const builtStillThere = await docker(["image", "inspect", BUILD_TAG], { timeoutMs: 30_000 });
    if (builtStillThere.code === 0) {
      await docker(["rmi", "-f", BUILD_TAG], { timeoutMs: 60_000 });
    }
    const verify = await docker(["image", "inspect", BUILD_TAG], { timeoutMs: 30_000 });
    if (verify.code === 0) {
      throw new Error(`sandbox image suite left image behind: ${BUILD_TAG}`);
    }
    for (const base of [PULL_REF, BUILD_BASE]) {
      await docker(["rmi", base], { timeoutMs: 60_000 }).catch(() => undefined);
    }

    harness?.db.close();
    if (harness?.dir !== undefined) {
      rmSync(harness.dir, { recursive: true, force: true });
    }
  });
});
