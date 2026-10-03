import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createFakeSandboxProvider } from "@openeuler/sandbox";
import { createApp } from "../app.js";
import { createExecutor, UNDECLARED_PORT_HINT } from "../executor.js";
import type { Executor, RunPortView } from "../executor.js";
import { createLogger } from "../logger.js";

/**
 * #107: port declaration + detection through the API — run creation
 * accepts `ports` (validated), the run detail carries the merged port
 * views (`{container, host?, declared, hint?}`), and detected-but-
 * undeclared ports surface the declare-to-preview hint (documented v0.2
 * cut: only declared ports are published).
 */

interface PortDetailBody {
  run: Run;
  ports?: RunPortView[];
  sandbox?: { id: string; image: string; status: string };
}

interface Harness {
  dir: string;
  db: Db;
  executor: Executor;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
  storeRoot: string;
}

const created: Harness[] = [];

const setup = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-runs-ports-"));
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
  const drivers = createDriverRegistry();
  drivers.registerDriver(
    createFakeDriver({ events: [{ type: "done", seq: 1, output: "ok" }], output: "ok" }),
  );
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot }),
    drivers,
    logger: createLogger("silent"),
  });
  const { app } = createApp({ db, logger: createLogger("silent"), executor });
  const harness: Harness = {
    dir,
    db,
    executor,
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

describe("POST /api/runs ports validation (#107)", () => {
  it("accepts 1..3 unique ports 1..65535 and echoes them on the run row", async () => {
    const h = setup();
    const res = await postRun(h, {
      projectId: h.projectId,
      prompt: "serve it",
      ports: [3000, 8080, 65535],
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { run: Run };
    expect(body.run.ports).toEqual([3000, 8080, 65535]);
    expect(h.db.runs.get(body.run.id)?.ports).toEqual([3000, 8080, 65535]);
  });

  it("422s on >3 ports, duplicates, and out-of-range values with details", async () => {
    const h = setup();
    for (const ports of [[3000, 4000, 5000, 6000], [3000, 3000], [0], [65536], [3000.5]]) {
      const res = await postRun(h, { projectId: h.projectId, prompt: "x", ports });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("422s on non-integer and non-array shapes", async () => {
    const h = setup();
    const bad = await postRun(h, { projectId: h.projectId, prompt: "x", ports: "3000" });
    expect(bad.status).toBe(422);
  });
});

describe("GET /api/runs/:id ports views (#107)", () => {
  it("declared ports render declared:true without host once the sandbox is gone", async () => {
    const h = setup();
    const res = await postRun(h, { projectId: h.projectId, prompt: "serve it", ports: [3000] });
    const { run } = (await res.json()) as { run: Run };
    const detail = (await (await h.request(`/api/runs/${run.id}`)).json()) as PortDetailBody;
    expect(detail.ports).toEqual([{ container: 3000, declared: true }]);
  });

  it("detected-but-undeclared ports carry the declare-to-preview hint (unit hint path)", async () => {
    const h = setup();
    const res = await postRun(h, { projectId: h.projectId, prompt: "serve it" });
    const { run } = (await res.json()) as { run: Run };
    // Detection ran inside the engine (sandboxed runs only); simulate the
    // recorded outcome the executor persists as it detects.
    h.db.runs.update(run.id, { detectedPorts: [5173] });

    const detail = (await (await h.request(`/api/runs/${run.id}`)).json()) as PortDetailBody;
    expect(detail.ports).toEqual([
      { container: 5173, declared: false, hint: UNDECLARED_PORT_HINT },
    ]);
  });

  it("declared order wins, detected extras follow, capped at 3; absent when none", async () => {
    const h = setup();
    const res = await postRun(h, {
      projectId: h.projectId,
      prompt: "serve it",
      ports: [8080, 3000],
    });
    const { run } = (await res.json()) as { run: Run };
    h.db.runs.update(run.id, { detectedPorts: [3000, 5000, 6000] });

    const detail = (await (await h.request(`/api/runs/${run.id}`)).json()) as PortDetailBody;
    expect(detail.ports).toEqual([
      { container: 8080, declared: true },
      { container: 3000, declared: true },
      { container: 5000, declared: false, hint: UNDECLARED_PORT_HINT },
    ]);

    // No declared and no detected ports: the field is omitted entirely.
    const bare = await postRun(h, { projectId: h.projectId, prompt: "plain" });
    const { run: bareRun } = (await bare.json()) as { run: Run };
    const bareDetail = (await (
      await h.request(`/api/runs/${bareRun.id}`)
    ).json()) as PortDetailBody;
    expect(bareDetail.ports).toBeUndefined();
  });

  it("live sandboxed runs map declared ports to host ports in the detail", async () => {
    const h = setup();
    const provider = createFakeSandboxProvider();
    h.db.projects.setSandboxPolicy(h.projectId, {
      executionMode: "sandbox",
      image: "busybox:1.36",
    });

    // Keep the run in flight long enough to observe the live detail.
    const drivers = createDriverRegistry();
    drivers.registerDriver(
      createFakeDriver({
        events: [
          { type: "message-delta", seq: 1, delta: "booting" },
          { type: "message-delta", seq: 2, delta: "up" },
        ],
        delayMs: 150,
        output: "Server listening on port 8000",
      }),
    );
    const executor = createExecutor({
      db: h.db,
      worktrees: new WorktreeManager({ storeRoot: h.storeRoot }),
      drivers,
      logger: createLogger("silent"),
      sandbox: { provider, isDockerAvailable: async () => true },
    });
    // Swap the harness onto an app wired to the long-running executor.
    const { app } = createApp({ db: h.db, logger: createLogger("silent"), executor });
    h.executor = executor;
    h.request = (path, init) => Promise.resolve(app.request(path, init));

    const res = await postRun(h, { projectId: h.projectId, prompt: "serve it", ports: [8000] });
    const { run } = (await res.json()) as { run: Run };

    const deadline = Date.now() + 5_000;
    let ports: RunPortView[] | undefined;
    for (;;) {
      const detail = (await (await h.request(`/api/runs/${run.id}`)).json()) as PortDetailBody;
      ports = detail.ports;
      if (detail.sandbox !== undefined && ports !== undefined) break;
      if (Date.now() > deadline) throw new Error("sandbox detail never became live");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Fake provider: first declared port maps to the first ephemeral port.
    expect(ports).toEqual([{ container: 8000, host: 32768, declared: true }]);

    // Settle, then the host mapping disappears with the sandbox while the
    // detected port (same number) stays recorded.
    let status = "";
    const settleDeadline = Date.now() + 5_000;
    while (Date.now() < settleDeadline) {
      const detail = (await (await h.request(`/api/runs/${run.id}`)).json()) as PortDetailBody;
      status = detail.run.status;
      if (status === "success") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status).toBe("success");
    expect(h.db.runs.get(run.id)?.detectedPorts).toEqual([8000]);
    const final = (await (await h.request(`/api/runs/${run.id}`)).json()) as PortDetailBody;
    expect(final.ports).toEqual([{ container: 8000, declared: true }]);
    expect(final.sandbox).toBeUndefined();
  });
});

describe("POST /api/workflows/:id/runs ports (#107)", () => {
  it("accepts declared ports on workflow runs and rejects invalid lists", async () => {
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

    const ok = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "run it", ports: [3000, 5000] }),
    });
    expect(ok.status).toBe(202);
    const body = (await ok.json()) as { run: Run };
    expect(body.run.ports).toEqual([3000, 5000]);

    const bad = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "run it", ports: [1, 2, 3, 4] }),
    });
    expect(bad.status).toBe(422);
  });
});

describe("POST /api/runs/:id/retry ports (#107)", () => {
  it("copies declared ports to the retried run", async () => {
    const h = setup();
    const res = await postRun(h, { projectId: h.projectId, prompt: "serve it", ports: [3000] });
    const { run } = (await res.json()) as { run: Run };
    // Terminalize directly (retry refuses queued/running rows).
    h.db.runs.update(run.id, { status: "failed" });

    const retry = await h.request(`/api/runs/${run.id}/retry`, { method: "POST" });
    expect(retry.status).toBe(202);
    const body = (await retry.json()) as { run: Run };
    expect(body.run.ports).toEqual([3000]);
    expect(body.run.detectedPorts).toBeUndefined();
  });
});
