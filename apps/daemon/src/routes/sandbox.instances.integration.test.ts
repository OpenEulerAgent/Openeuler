import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Db } from "@openeuler/db";
import {
  createDockerAvailabilityProbe,
  createDockerSandboxProvider,
  type SandboxHandle,
} from "@openeuler/sandbox";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";
import type { SandboxInstancesBody } from "./sandbox.js";

/**
 * `GET /api/sandbox/instances` + stop/destroy against a REAL docker daemon
 * (#112), gated to auto-skip when docker is unavailable (same pattern as
 * sandbox.integration.test.ts): a labeled sleeper container appears with
 * live stats and the run join, stop keeps it listed as stopped, destroy
 * removes it — and the suite leaves nothing behind.
 */

const dockerLive =
  process.env.DOCKER_E2E === "0"
    ? false
    : await createDockerAvailabilityProbe().check({ force: true });

interface Harness {
  db: Db;
  dir: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

let harness: Harness;

const handles: SandboxHandle[] = [];

const instances = async (): Promise<SandboxInstancesBody> => {
  const res = await harness.request("/api/sandbox/instances");
  expect(res.status).toBe(200);
  return (await res.json()) as SandboxInstancesBody;
};

/**
 * `docker stats --no-stream` on a container created a moment ago can hiccup
 * on a loaded host (the daemon then omits `usage` for that snapshot) — poll
 * a few seconds until the row carries live numbers.
 */
const instanceWithUsage = async (
  id: string,
  deadlineMs = 20_000,
): Promise<SandboxInstancesBody["instances"][number]> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const body = await instances();
    const row = body.instances.find((instance) => instance.id === id);
    if (row !== undefined && row.usage?.memMb !== undefined) return row;
    if (Date.now() > deadline) {
      throw new Error(`sandbox ${id} never reported live usage: ${JSON.stringify(row)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

describe.skipIf(!dockerLive)("sandbox instances integration (real daemon, #112)", () => {
  const runId = `run-it-${randomBytes(4).toString("hex")}`;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-instances-it-"));
    const db = createDatabase({ path: join(dir, "test.db") });
    const projectId = db.projects.create({
      id: `proj-it-${randomBytes(3).toString("hex")}`,
      path: "/tmp/demo",
      name: "demo",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    }).id;
    db.runs.create({
      id: runId,
      projectId,
      status: "running",
      branch: `agentloop/${runId}`,
      iteration: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
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

  it(
    "lists a real sleeper container with live stats and the run join",
    { timeout: 120_000 },
    async () => {
      const provider = createDockerSandboxProvider();
      const sandbox = await provider.create({
        // The sleeper: the provider's exec-driven idle keeper (`tail -f
        // /dev/null` by default) — exactly what a run sandbox runs.
        runId,
        image: "busybox:musl",
        mounts: [],
        env: {},
        labels: { run: runId },
      });
      handles.push(sandbox);

      const row = await instanceWithUsage(sandbox.id);
      expect(row).toMatchObject({
        runId,
        image: "busybox:musl",
        status: "running",
        run: { id: runId, status: "running", project: { name: "demo" } },
      });
      expect(row.startedAt).toBeGreaterThan(0);
      // Live stats snapshot: numbers may be near-zero on an idle sleeper,
      // but they are present and well-formed.
      expect(row.usage?.memMb).toEqual(expect.any(Number));
      expect(row.usage?.cpuPercent).toEqual(expect.any(Number));
    },
  );

  it(
    "stops the container gracefully (kept, listed stopped), then destroy removes it",
    { timeout: 120_000 },
    async () => {
      const sandbox = handles[0];
      if (sandbox === undefined) throw new Error("first test did not leave a sandbox");

      const stop = await harness.request(`/api/sandbox/instances/${sandbox.id}/stop`, {
        method: "POST",
      });
      expect(stop.status).toBe(200);
      await expect(stop.json()).resolves.toEqual({ stopped: sandbox.id });

      const afterStop = await instances();
      const stopped = afterStop.instances.find((instance) => instance.id === sandbox.id);
      // By-id stop cannot set the provider's handle-level "stopped" marker —
      // docker ps reports the state as "exited" (kept, inspectable).
      expect(stopped).toMatchObject({ status: "exited" });

      const destroy = await harness.request(`/api/sandbox/instances/${sandbox.id}`, {
        method: "DELETE",
      });
      expect(destroy.status).toBe(200);
      await expect(destroy.json()).resolves.toEqual({ deleted: sandbox.id });

      const afterDestroy = await instances();
      expect(afterDestroy.instances.some((instance) => instance.id === sandbox.id)).toBe(false);

      handles.length = 0; // destroyed through the API already
    },
  );

  afterAll(async () => {
    for (const handle of handles) {
      await handle.destroy().catch(() => undefined);
    }
    const leftover = await createDockerSandboxProvider().list({ run: runId });
    if (leftover.length > 0) {
      throw new Error(
        `sandbox instances suite left containers behind: ${leftover.map((s) => s.id).join(", ")}`,
      );
    }
    harness?.db.close();
    if (harness?.dir !== undefined) {
      rmSync(harness.dir, { recursive: true, force: true });
    }
  });
});
