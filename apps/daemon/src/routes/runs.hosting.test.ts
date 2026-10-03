import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run, RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createFakeSandboxProvider } from "@openeuler/sandbox";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import type { Executor, RunHostingView } from "../executor.js";
import { createLogger } from "../logger.js";

/**
 * #110 hosting through the API: run creation accepts `hosting` on BOTH run
 * APIs (validated 422s otherwise), the run detail carries the hosting view
 * `{until, ports, extendable}` with live host mappings while the sandbox
 * lives, and the stop/extend endpoints answer 200/409/422 as specified.
 */

interface HostingDetailBody {
  run: Run;
  hosting?: RunHostingView | null;
  sandbox?: { id: string; image: string; status: string };
}

interface Harness {
  dir: string;
  db: Db;
  executor: Executor;
  provider: ReturnType<typeof createFakeSandboxProvider>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
  storeRoot: string;
}

const created: Harness[] = [];

const setup = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-runs-hosting-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  execFileSync("git", ["add", "-A"], { cwd: repoPath, stdio: "pipe" });
  execFileSync(
    "git",
    ["-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init"],
    { cwd: repoPath, stdio: "pipe" },
  );
  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: repoPath,
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  const storeRoot = join(dir, "store");
  const provider = createFakeSandboxProvider();
  const drivers = createDriverRegistry();
  drivers.registerDriver(
    createFakeDriver({ events: [{ type: "done", seq: 1, output: "up" }], output: "up" }),
  );
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot }),
    drivers,
    logger: createLogger("silent"),
    sandbox: { provider, isDockerAvailable: async () => true },
  });
  const { app } = createApp({ db, logger: createLogger("silent"), executor });
  const harness: Harness = {
    dir,
    db,
    executor,
    provider,
    storeRoot,
    request: (path, init) => Promise.resolve(app.request(path, init)),
    projectId: project.id,
  };
  created.push(harness);
  return harness;
};

afterEach(() => {
  while (created.length > 0) {
    const harness = created.pop() as Harness;
    harness.db.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

const postRun = (h: Harness, body: Record<string, unknown>): Promise<Response> =>
  h.request("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const jsonBody = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const waitForStatus = async (h: Harness, runId: string, status: RunStatus): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (h.db.runs.get(runId)?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${status}: currently ${h.db.runs.get(runId)?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const waitForIdle = async (h: Harness): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (h.executor.activeRunIds().length > 0) {
    if (Date.now() > deadline) throw new Error("executor never went idle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Drives one sandboxed hosted run to success and waits out the executor. */
const hostViaApi = async (
  h: Harness,
  hosting: Record<string, unknown> = { enabled: true },
): Promise<string> => {
  h.db.projects.setSandboxPolicy(h.projectId, {
    executionMode: "sandbox",
    image: "busybox:1.36",
  });
  const res = await postRun(h, {
    projectId: h.projectId,
    prompt: "serve it",
    ports: [8000],
    hosting,
  });
  expect(res.status).toBe(202);
  const { run } = (await res.json()) as { run: Run };
  await waitForStatus(h, run.id, "success");
  await waitForIdle(h);
  return run.id;
};

describe("run creation hosting option (#110)", () => {
  it("persists hosting on the run row (POST /api/runs)", async () => {
    const h = setup();
    const res = await postRun(h, {
      projectId: h.projectId,
      prompt: "serve it",
      ports: [3000],
      hosting: { enabled: true, keepAliveMinutes: 15 },
    });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as { run: Run };
    expect(run.hosting).toEqual({ enabled: true, keepAliveMinutes: 15 });
    expect(h.db.runs.get(run.id)?.hosting).toEqual({ enabled: true, keepAliveMinutes: 15 });
    expect(run.hostedUntil).toBeUndefined();
  });

  it("persists hosting on workflow runs (POST /api/workflows/:id/runs)", async () => {
    const h = setup();
    const workflow = h.db.workflows.create({
      id: crypto.randomUUID(),
      projectId: h.projectId,
      name: "w",
      steps: [
        {
          id: "s1",
          name: "do",
          driver: "fake",
          mode: "auto",
          promptTemplate: "{{task}}",
          continueSession: false,
        },
      ],
    });
    const res = await h.request(
      `/api/workflows/${workflow.id}/runs`,
      jsonBody({ task: "run it", ports: [3000], hosting: { enabled: true } }),
    );
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as { run: Run };
    expect(run.hosting).toEqual({ enabled: true });
  });

  it("422s on invalid hosting shapes with details", async () => {
    const h = setup();
    for (const hosting of [
      { keepAliveMinutes: 30 }, // no enabled
      { enabled: "yes" },
      { enabled: true, keepAliveMinutes: 4 },
      { enabled: true, keepAliveMinutes: 1441 },
      { enabled: true, keepAliveMinutes: 12.5 },
      { enabled: true, keepAliveMinutes: "60" },
      { enabled: true, extra: 1 },
    ]) {
      const res = await postRun(h, { projectId: h.projectId, prompt: "x", hosting });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("GET /api/runs/:id hosting view (#110)", () => {
  it("carries until + live host mappings while the sandbox is hosted", async () => {
    const h = setup();
    const runId = await hostViaApi(h, { enabled: true, keepAliveMinutes: 45 });

    const detail = (await (await h.request(`/api/runs/${runId}`)).json()) as HostingDetailBody;
    // The run stays success; hosting is the extra view.
    expect(detail.run.status).toBe("success");
    expect(detail.hosting).not.toBeNull();
    expect(Date.parse(detail.hosting?.until ?? "")).toBeGreaterThan(Date.now() + 44 * 60_000);
    // Fake provider maps the first declared port to the first ephemeral port.
    expect(detail.hosting?.ports).toEqual([{ container: 8000, host: 32768 }]);
    expect(detail.hosting?.extendable).toBe(true);
  });

  it("is null for runs that are not hosted (never hosted, or hosting ended)", async () => {
    const h = setup();
    const runId = await hostViaApi(h);
    const stop = await h.request(`/api/runs/${runId}/hosting/stop`, { method: "POST" });
    expect(stop.status).toBe(200);
    const detail = (await (await h.request(`/api/runs/${runId}`)).json()) as HostingDetailBody;
    expect(detail.hosting).toBeNull();
  });
});

describe("POST /api/runs/:id/hosting/stop (#110)", () => {
  it("stops hosting: destroys the sandbox, clears hostedUntil, run stays success", async () => {
    const h = setup();
    const runId = await hostViaApi(h);

    const res = await h.request(`/api/runs/${runId}/hosting/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: Run };
    expect(body.run.status).toBe("success");
    expect(body.run.hostedUntil).toBeUndefined();
    expect(await h.provider.list({ run: runId })).toEqual([]);
  });

  it("409s when the run is not hosted, 404s on unknown runs", async () => {
    const h = setup();
    const res = await postRun(h, { projectId: h.projectId, prompt: "plain" });
    const { run } = (await res.json()) as { run: Run };
    await waitForStatus(h, run.id, "success");
    await waitForIdle(h);

    const notHosted = await h.request(`/api/runs/${run.id}/hosting/stop`, { method: "POST" });
    expect(notHosted.status).toBe(409);
    expect(((await notHosted.json()) as { error: { code: string } }).error.code).toBe(
      "RUN_NOT_HOSTED",
    );

    const unknown = await h.request("/api/runs/no-such-run/hosting/stop", { method: "POST" });
    expect(unknown.status).toBe(404);
  });
});

describe("POST /api/runs/:id/hosting/extend (#110)", () => {
  it("bumps hostedUntil by the requested minutes and returns the hosting view", async () => {
    const h = setup();
    const runId = await hostViaApi(h, { enabled: true, keepAliveMinutes: 10 });
    const before = Date.parse(h.db.runs.get(runId)?.hostedUntil ?? "");

    const res = await h.request(`/api/runs/${runId}/hosting/extend`, jsonBody({ minutes: 30 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosting: RunHostingView };
    expect(Date.parse(body.hosting.until)).toBeGreaterThan(before + 29 * 60_000);
    expect(h.db.runs.get(runId)?.hostedUntil).toBe(body.hosting.until);
  });

  it("409s when not hosted; 422s on invalid minutes", async () => {
    const h = setup();
    const hosted = await hostViaApi(h);
    // Invalid bodies validate BEFORE the hosted check.
    for (const minutes of [0, -5, 1.5, 5000, "30"]) {
      const res = await h.request(
        `/api/runs/${hosted}/hosting/extend`,
        jsonBody({ minutes }),
      );
      expect(res.status).toBe(422);
    }

    const plain = await postRun(h, { projectId: h.projectId, prompt: "plain" });
    const { run } = (await plain.json()) as { run: Run };
    await waitForStatus(h, run.id, "success");
    const notHosted = await h.request(
      `/api/runs/${run.id}/hosting/extend`,
      jsonBody({ minutes: 30 }),
    );
    expect(notHosted.status).toBe(409);
    expect(((await notHosted.json()) as { error: { code: string } }).error.code).toBe(
      "RUN_NOT_HOSTED",
    );
  });
});

describe("POST /api/runs/:id/retry hosting (#110)", () => {
  it("copies the hosting request (not hostedUntil) to the retried run", async () => {
    const h = setup();
    const runId = await hostViaApi(h, { enabled: true, keepAliveMinutes: 20 });

    const retry = await h.request(`/api/runs/${runId}/retry`, { method: "POST" });
    expect(retry.status).toBe(202);
    const body = (await retry.json()) as { run: Run };
    expect(body.run.hosting).toEqual({ enabled: true, keepAliveMinutes: 20 });
    expect(body.run.hostedUntil).toBeUndefined();
  });
});
