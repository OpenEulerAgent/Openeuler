import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import type { DockerCliResult, DockerCliRunner, DockerStdinCliRunner } from "@openeuler/sandbox";
import { createFakeSandboxProvider } from "@openeuler/sandbox";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";
import type { SandboxJob } from "./sandbox.js";

/**
 * Sandbox image API unit tests (#100): catalog mapping, async pull/build job
 * lifecycle + dedupe, ops completion events, delete in-use/missing/success
 * paths and auth coverage — all against scripted docker runners and the fake
 * sandbox provider. Real-daemon behavior lives in sandbox.integration.test.ts.
 */

const imagesStdout = [
  JSON.stringify({
    Repository: "openeuler/worker",
    Tag: "latest",
    ID: "aaaa1111bbbb",
    Size: "12.5MB",
    CreatedAt: "2026-10-01 10:00:00 +0000 UTC",
  }),
  JSON.stringify({
    Repository: "busybox",
    Tag: "musl",
    ID: "cccc2222dddd",
    Size: "4.2MB",
    CreatedAt: "2026-09-01 10:00:00 +0000 UTC",
  }),
].join("\n");

const inspectStdout = [
  JSON.stringify({
    Id: `sha256:aaaa1111bbbb${"0".repeat(52)}`,
    Created: "2026-10-01T10:00:00.000000000Z",
    Size: 12_500_000,
  }),
  JSON.stringify({
    Id: `sha256:cccc2222dddd${"0".repeat(52)}`,
    Created: "2026-09-01T10:00:00.000000000Z",
    Size: 4_161_792,
  }),
].join("\n");

/** FIFO scripted runner; handlers may inspect args. */
class ScriptRunner {
  readonly calls: string[][] = [];
  private readonly handlers: Array<(args: readonly string[]) => DockerCliResult> = [];

  ok(stdout = ""): this {
    return this.push(() => ({ code: 0, stdout, stderr: "" }));
  }

  fail(code: number, stderr: string): this {
    return this.push(() => ({ code, stdout: "", stderr }));
  }

  push(handler: (args: readonly string[]) => DockerCliResult): this {
    this.handlers.push(handler);
    return this;
  }

  run: DockerCliRunner = async (args) => {
    this.calls.push([...args]);
    const handler = this.handlers.shift();
    if (handler === undefined) {
      throw new Error(`unexpected docker call: docker ${args.join(" ")}`);
    }
    return handler(args);
  };
}

/** Runner whose in-flight call blocks until `release()` — for dedupe tests. */
class BlockedRunner {
  readonly calls: string[][] = [];
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  block(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  release(): void {
    this.openGate?.();
    this.gate = null;
    this.openGate = null;
  }

  run: DockerCliRunner = async (args) => {
    this.calls.push([...args]);
    if (this.gate !== null) await this.gate;
    return { code: 0, stdout: "", stderr: "" };
  };
}

class ScriptStdinRunner {
  readonly calls: Array<{ args: string[]; input: string }> = [];
  private result: DockerCliResult = { code: 0, stdout: "", stderr: "" };

  resolve(result: DockerCliResult): this {
    this.result = result;
    return this;
  }

  run: DockerStdinCliRunner = async (args, input) => {
    this.calls.push({ args: [...args], input });
    return this.result;
  };
}

interface Harness {
  db: Db;
  dir: string;
  runner: ScriptRunner;
  stdinRunner: ScriptStdinRunner;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

let harness: Harness;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-sandbox-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const runner = new ScriptRunner();
  const stdinRunner = new ScriptStdinRunner();
  const { app } = createApp({
    db,
    logger: createLogger("silent"),
    sandbox: {
      provider: createFakeSandboxProvider(),
      images: { runner: runner.run, stdinRunner: stdinRunner.run },
    },
  });
  harness = {
    db,
    dir,
    runner,
    stdinRunner,
    request: (path, init) => Promise.resolve(app.request(path, init)),
  };
});

afterEach(() => {
  harness.db.close();
  rmSync(harness.dir, { recursive: true, force: true });
});

const jsonPost = (path: string, body: unknown): Promise<Response> =>
  harness.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Polls the jobs endpoint until the job is terminal (deadline-bounded). */
const waitForJob = async (
  jobId: string,
  request: (path: string, init?: RequestInit) => Promise<Response> = harness.request,
  deadlineMs = 2_000,
): Promise<SandboxJob> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const res = await request(`/api/sandbox/jobs/${jobId}`);
    expect(res.status).toBe(200);
    const job = (await res.json()) as SandboxJob;
    if (job.status !== "running") return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish in ${deadlineMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const opsEvents = (type: string): Array<Record<string, unknown>> =>
  harness.db.activity
    .list({ limit: 100 })
    .filter((row) => row.type === type)
    .map((row) => row.payload ?? {});

describe("GET /api/sandbox/images (#100)", () => {
  it("serves the catalog mapped from the scripted CLI output", async () => {
    harness.runner.ok(imagesStdout).ok(inspectStdout);
    const res = await harness.request("/api/sandbox/images");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: Array<Record<string, unknown>> };
    expect(body.images).toHaveLength(2);
    expect(body.images[0]).toMatchObject({
      repository: "openeuler/worker",
      tag: "latest",
      sizeBytes: 12_500_000,
      ours: true,
    });
    expect(body.images[1]).toMatchObject({ repository: "busybox", tag: "musl", ours: false });
  });

  it("maps a daemon-down failure to 503 SANDBOX_UNAVAILABLE", async () => {
    harness.runner.fail(
      1,
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    );
    const res = await harness.request("/api/sandbox/images");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SANDBOX_UNAVAILABLE");
  });
});

describe("POST /api/sandbox/images/pull (#100)", () => {
  it("answers 202, passes the ref verbatim to docker pull, and completes the job", async () => {
    harness.runner.ok("musl: Pull complete\n");
    const res = await jsonPost("/api/sandbox/images/pull", { ref: "busybox:musl" });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    const job = await waitForJob(jobId);
    expect(job).toMatchObject({ kind: "pull", ref: "busybox:musl", status: "done" });
    expect(job.finishedAt).toBeGreaterThanOrEqual(job.createdAt);
    expect(harness.runner.calls).toEqual([["pull", "busybox:musl"]]);
    expect(opsEvents("ops.image-pull")).toEqual([{ ref: "busybox:musl", done: true }]);
  });

  it("dedupes concurrent pulls of the same ref onto one job", async () => {
    const blocked = new BlockedRunner();
    blocked.block();
    const { app } = createApp({
      db: harness.db,
      logger: createLogger("silent"),
      sandbox: { images: { runner: blocked.run } },
    });
    const post = (body: unknown): Promise<Response> =>
      Promise.resolve(
        app.request("/api/sandbox/images/pull", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const viaApp = (path: string): Promise<Response> => Promise.resolve(app.request(path));

    const first = await post({ ref: "busybox:musl" });
    const second = await post({ ref: "busybox:musl" });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = (await first.json()) as { jobId: string };
    expect(await second.json()).toEqual(firstBody);

    blocked.release();
    const job = await waitForJob(firstBody.jobId, viaApp);
    expect(job.status).toBe("done");
    // Only ONE docker pull for both requests.
    expect(blocked.calls).toEqual([["pull", "busybox:musl"]]);
    expect(opsEvents("ops.image-pull")).toEqual([{ ref: "busybox:musl", done: true }]);
  });

  it("rejects an invalid ref with 422 before any CLI call", async () => {
    const res = await jsonPost("/api/sandbox/images/pull", { ref: "--privileged" });
    expect(res.status).toBe(422);
    expect(harness.runner.calls).toEqual([]);
    expect(opsEvents("ops.image-pull")).toEqual([]);
  });

  it("records a failed pull on the job and as an ops event", async () => {
    harness.runner.fail(1, "pull access denied for nope/nope, repository does not exist");
    const res = await jsonPost("/api/sandbox/images/pull", { ref: "nope/nope" });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    const job = await waitForJob(jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("pull access denied");
    const events = opsEvents("ops.image-pull");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ref: "nope/nope", done: false });
    expect(typeof events[0]?.["error"]).toBe("string");
  });

  it("answers 422 for a non-JSON body", async () => {
    const res = await harness.request("/api/sandbox/images/pull", {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(422);
  });
});

describe("POST /api/sandbox/images/build (#100)", () => {
  it("answers 202 with the tag and builds via stdin with an empty context", async () => {
    const dockerfile = "FROM busybox:musl\nRUN echo hi\n";
    const res = await jsonPost("/api/sandbox/images/build", {
      name: "test-img",
      dockerfileText: dockerfile,
    });
    expect(res.status).toBe(202);
    const { jobId, tag } = (await res.json()) as { jobId: string; tag: string };
    expect(tag).toBe("openeuler/test-img:latest");
    const job = await waitForJob(jobId);
    expect(job).toMatchObject({ kind: "build", ref: tag, status: "done" });
    expect(harness.stdinRunner.calls).toEqual([
      { args: ["build", "-t", "openeuler/test-img:latest", "-"], input: dockerfile },
    ]);
    expect(opsEvents("ops.image-build")).toEqual([
      { ref: "openeuler/test-img:latest", name: "test-img", done: true },
    ]);
  });

  it("synthesizes `FROM <baseRef>` when no dockerfileText is given", async () => {
    const res = await jsonPost("/api/sandbox/images/build", {
      name: "base-only",
      baseRef: "alpine:3.20",
    });
    expect(res.status).toBe(202);
    await waitForJob(((await res.json()) as { jobId: string }).jobId);
    expect(harness.stdinRunner.calls).toEqual([
      { args: ["build", "-t", "openeuler/base-only:latest", "-"], input: "FROM alpine:3.20\n" },
    ]);
  });

  it("rejects bad names, bad baseRefs and missing dockerfile input with 422", async () => {
    const badName = await jsonPost("/api/sandbox/images/build", {
      name: "Bad Name",
      dockerfileText: "FROM alpine\n",
    });
    expect(badName.status).toBe(422);

    const badBase = await jsonPost("/api/sandbox/images/build", {
      name: "ok",
      baseRef: "NOT A REF",
    });
    expect(badBase.status).toBe(422);

    const empty = await jsonPost("/api/sandbox/images/build", { name: "ok" });
    expect(empty.status).toBe(422);
    expect(harness.stdinRunner.calls).toEqual([]);
  });

  it("records a failed build on the job and as an ops event", async () => {
    harness.stdinRunner.resolve({
      code: 1,
      stdout: "",
      stderr: 'ERROR: failed to solve: process "/bin/sh -c boom" did not complete successfully',
    });
    const res = await jsonPost("/api/sandbox/images/build", {
      name: "broken",
      dockerfileText: "FROM alpine\nRUN boom",
    });
    const { jobId } = (await res.json()) as { jobId: string };
    const job = await waitForJob(jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("failed to solve");
    const events = opsEvents("ops.image-build");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ref: "openeuler/broken:latest",
      done: false,
    });
  });
});

describe("DELETE /api/sandbox/images/:ref (#100)", () => {
  const encoded = encodeURIComponent("openeuler/worker:latest");

  it("answers 409 IMAGE_IN_USE with the holder ids while a sandbox runs the image", async () => {
    const provider = createFakeSandboxProvider();
    const { app } = createApp({
      db: harness.db,
      logger: createLogger("silent"),
      sandbox: { provider, images: { runner: harness.runner.run } },
    });
    const sandbox = await provider.create({
      runId: "run-in-use",
      image: "openeuler/worker",
      mounts: [],
      env: {},
    });

    const res = await Promise.resolve(
      app.request(`/api/sandbox/images/${encoded}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe("IMAGE_IN_USE");
    expect(body.error.details).toEqual({ sandboxes: [sandbox.id] });
    // Untagged spec image matches the tagged delete ref (normalization).
    expect(harness.runner.calls).toEqual([]);
    await sandbox.destroy();
  });

  it("answers 404 IMAGE_NOT_FOUND after inspecting an unknown ref", async () => {
    harness.runner.fail(1, "Error: No such image: openeuler/ghost:latest");
    const res = await harness.request(`/api/sandbox/images/${encoded}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("IMAGE_NOT_FOUND");
  });

  it("inspects then removes and answers 200 on success", async () => {
    harness.runner.ok("{}").ok("Untagged: openeuler/worker:latest\n");
    const res = await harness.request(`/api/sandbox/images/${encoded}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: "openeuler/worker:latest" });
    expect(harness.runner.calls).toEqual([
      ["image", "inspect", "openeuler/worker:latest"],
      ["rmi", "openeuler/worker:latest"],
    ]);
  });

  it("surfaces a docker-side conflict as 409 IMAGE_IN_USE", async () => {
    harness.runner
      .ok("{}")
      .fail(
        1,
        "Error response from daemon: conflict: unable to delete (must be forced) - image is referenced in multiple repositories",
      );
    const res = await harness.request(`/api/sandbox/images/${encoded}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("IMAGE_IN_USE");
  });

  it("answers 422 for a flag-like ref", async () => {
    const res = await harness.request(`/api/sandbox/images/${encodeURIComponent("--x")}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(422);
  });

  it("answers 503 when no provider is configured", async () => {
    const { app } = createApp({ logger: createLogger("silent") });
    const res = await Promise.resolve(
      app.request(`/api/sandbox/images/${encoded}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SANDBOX_UNAVAILABLE");
  });
});

describe("GET /api/sandbox/jobs/:id (#100)", () => {
  it("answers 404 JOB_NOT_FOUND for unknown ids", async () => {
    const res = await harness.request("/api/sandbox/jobs/does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("JOB_NOT_FOUND");
  });
});

describe("auth + rate limits (#100)", () => {
  it("requires the bearer token on every sandbox route", async () => {
    const { app } = createApp({
      db: harness.db,
      logger: createLogger("silent"),
      authToken: "sekret",
      sandbox: { images: { runner: harness.runner.run } },
    });
    harness.runner.ok(imagesStdout).ok(inspectStdout);

    const rejected = await Promise.resolve(app.request("/api/sandbox/images"));
    expect(rejected.status).toBe(401);
    const rejectedPull = await Promise.resolve(
      app.request("/api/sandbox/images/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: "busybox:musl" }),
      }),
    );
    expect(rejectedPull.status).toBe(401);

    const headers = { authorization: "Bearer sekret" };
    const ok = await Promise.resolve(app.request("/api/sandbox/images", { headers }));
    expect(ok.status).toBe(200);
    const okPull = await Promise.resolve(
      app.request("/api/sandbox/images/pull", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ ref: "busybox:musl" }),
      }),
    );
    expect(okPull.status).toBe(202);
  });
});
