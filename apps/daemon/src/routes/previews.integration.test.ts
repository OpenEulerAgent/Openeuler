import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import {
  createDockerAvailabilityProbe,
  createDockerSandboxProvider,
  docker,
} from "@openeuler/sandbox";
import type { SandboxProvider } from "@openeuler/sandbox";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import type { Executor, RunPortView } from "../executor.js";
import { createLogger } from "../logger.js";

/**
 * Real-docker e2e of the preview proxy (#108), following the #102/#107
 * integration patterns: a sandboxed run (busybox) whose driver onStart boots
 * `busybox httpd` inside the container (file + CGI echo under /www), while
 * the proxy round-trips GET/POST through the REAL published port. Also pins
 * the 404 passthrough, the published-but-not-listening 502, the
 * stopped-container 502, and the post-terminal 410. Auto-skips without a
 * docker daemon (`DOCKER_E2E=0` or a failed probe).
 */

const BUSYBOX = "busybox:1.36";

const dockerLive =
  process.env.DOCKER_E2E === "0"
    ? false
    : await createDockerAvailabilityProbe().check({ force: true });

interface Harness {
  dir: string;
  db: Db;
  executor: Executor;
  provider: SandboxProvider;
  projectId: string;
  runId: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

let harness: Harness | null = null;

const setup = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-previews-e2e-"));
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
  db.projects.setSandboxPolicy(project.id, {
    executionMode: "sandbox",
    image: BUSYBOX,
  });

  const drivers = createDriverRegistry();
  drivers.registerDriver(
    createFakeDriver({
      // One slow event keeps the run (and its sandbox) alive while the
      // test drives the proxy.
      events: [{ type: "message-delta", seq: 1, delta: "serving" }],
      delayMs: 120_000,
      output: "Server listening on port 3000",
      onStart: async (opts) => {
        if (opts.exec === undefined) throw new Error("expected exec seam");
        await opts.exec.run([
          "sh",
          "-c",
          [
            "mkdir -p /www/cgi-bin",
            "echo 'hello preview' > /www/index.html",
            // CGI echo: method + query + body back as text/plain. The CGI
            // itself must emit CRLF header endings (busybox echo emits bare
            // LF, which undici rightly rejects as a malformed response).
            'printf \'#!/bin/sh\\nprintf "Content-type: text/plain\\\\r\\\\n\\\\r\\\\n"\\nprintf "method=%%s\\\\r\\\\n" "$REQUEST_METHOD"\\nprintf "query=%%s\\\\r\\\\n" "$QUERY_STRING"\\ncat\\n\' > /www/cgi-bin/echo',
            "chmod +x /www/cgi-bin/echo",
            // Daemonizes: the exec returns while httpd keeps serving.
            "httpd -p 3000 -h /www",
          ].join(" && "),
        ]);
      },
    }),
  );
  const provider = createDockerSandboxProvider();
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot: join(dir, "store") }),
    drivers,
    logger: createLogger("silent"),
    sandbox: { provider, isDockerAvailable: async () => true },
  });

  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.runs.create({
    id: runId,
    projectId: project.id,
    status: "queued",
    branch: `agentloop/${runId}`,
    iteration: 0,
    task: "serve it",
    // 3000 = httpd; 3001 = published but nothing listens (502 path).
    ports: [3000, 3001],
    createdAt: now,
    updatedAt: now,
  });
  db.stepRuns.create({
    id: crypto.randomUUID(),
    runId,
    stepId: "adhoc",
    iteration: 1,
    status: "queued",
    output: "",
  });

  const { app } = createApp({ db, logger: createLogger("silent"), executor });
  return {
    dir,
    db,
    executor,
    provider,
    projectId: project.id,
    runId,
    request: (path, init) => Promise.resolve(app.request(path, init)),
  };
};

const waitForStatus = async (h: Harness, status: RunStatus): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (h.db.runs.get(h.runId)?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${status}: currently ${h.db.runs.get(h.runId)?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const waitForIdle = async (h: Harness): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (h.executor.activeRunIds().length > 0) {
    if (Date.now() > deadline) throw new Error("executor never went idle");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Container names still alive for one of this suite's run ids. */
const containersFor = async (runId: string): Promise<string[]> => {
  const result = await docker(["ps", "-aq", "--filter", `label=run=${runId}`], {
    timeoutMs: 30_000,
  });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

/** Polls GET /previews/:runId?port=3000 until it answers non-502 (httpd boot). */
const waitUntilServing = async (h: Harness): Promise<void> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = await h.request(`/previews/${h.runId}?port=3000`);
    if (res.status === 200) return;
    if (Date.now() > deadline) throw new Error(`httpd never came up (last: ${res.status})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe.skipIf(!dockerLive)("preview proxy e2e (real sandbox, #108)", () => {
  beforeAll(async () => {
    const present = await docker(["image", "inspect", BUSYBOX], { timeoutMs: 30_000 });
    if (present.code !== 0) {
      const pull = await docker(["pull", BUSYBOX], { timeoutMs: 300_000 });
      if (pull.code !== 0) throw new Error(`failed to pull ${BUSYBOX}: ${pull.stderr}`);
    }
  }, 360_000);

  it("round-trips GET/POST through the container's published port, 404/502/410 matrix", async () => {
    const h = setup();
    harness = h;
    h.executor.startRun(h.runId);

    // Wait until the sandbox is live with published host ports.
    const deadline = Date.now() + 60_000;
    let ports: RunPortView[] | undefined;
    for (;;) {
      const info = await h.executor.sandboxInfo(h.runId);
      ports = info?.ports;
      if (ports?.some((p) => p.host !== undefined && p.container === 3000)) break;
      if (Date.now() > deadline) throw new Error("sandbox never published port 3000");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const host3000 = ports?.find((p) => p.container === 3000)?.host;
    expect(host3000).toBeGreaterThan(0);
    await waitUntilServing(h);

    // GET round-trip through the REAL container port (query form).
    const index = await h.request(`/previews/${h.runId}?port=3000`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("hello preview");
    expect(index.headers.get("content-type")).toContain("text/html");

    // GET path form (canonical) + subresource.
    const path = await h.request(`/previews/${h.runId}/3000/index.html`);
    expect(path.status).toBe(200);
    expect(await path.text()).toContain("hello preview");

    // POST round-trip via CGI: method + body passthrough inside the container.
    const post = await h.request(`/previews/${h.runId}/3000/cgi-bin/echo?x=1`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "ping=1",
    });
    expect(post.status).toBe(200);
    const postBody = await post.text();
    expect(postBody).toContain("method=POST");
    expect(postBody).toContain("query=x=1");
    expect(postBody).toContain("ping=1");

    // Upstream 404 passes through untouched.
    const missing = await h.request(`/previews/${h.runId}/3000/nope`);
    expect(missing.status).toBe(404);

    // Published but nothing listens on 3001 → 502 with the actionable hint.
    const refused = await h.request(`/previews/${h.runId}/3001/`);
    expect(refused.status).toBe(502);
    const refusedBody = (await refused.json()) as {
      error: { code: string; details: { containerPort: number; hint: string } };
    };
    expect(refusedBody.error.code).toBe("PREVIEW_UPSTREAM_UNAVAILABLE");
    expect(refusedBody.error.details.containerPort).toBe(3001);
    expect(refusedBody.error.details.hint).toContain("/api/runs/");

    // Undeclared port → 403 with the declare hint (real run row).
    const undeclared = await h.request(`/previews/${h.runId}?port=5000`);
    expect(undeclared.status).toBe(403);
    expect(((await undeclared.json()) as { error: { code: string } }).error.code).toBe(
      "PREVIEW_PORT_NOT_DECLARED",
    );

    // Sandbox down: stop the container out-of-band; the cached mapping now
    // refuses connections → 502 (sandbox-down path).
    const info = await h.executor.sandboxInfo(h.runId);
    expect(info?.id).toBeTruthy();
    await docker(["stop", info!.id], { timeoutMs: 30_000 });
    const down = await h.request(`/previews/${h.runId}?port=3000`);
    expect(down.status).toBe(502);
    expect(((await down.json()) as { error: { code: string } }).error.code).toBe(
      "PREVIEW_UPSTREAM_UNAVAILABLE",
    );

    // Terminal: abort the run, sandbox goes away → 410 PREVIEW_GONE.
    await h.executor.abortRun(h.runId);
    await waitForStatus(h, "aborted");
    await waitForIdle(h);
    const gone = await h.request(`/previews/${h.runId}?port=3000`);
    expect(gone.status).toBe(410);
    expect(((await gone.json()) as { error: { code: string } }).error.code).toBe("PREVIEW_GONE");

    // Nothing leaks.
    expect(await containersFor(h.runId)).toEqual([]);
  }, 180_000);
});

afterAll(async () => {
  if (harness === null) return;
  await harness.executor.shutdown().catch(() => {});
  const leftovers = await containersFor(harness.runId).catch(() => [] as string[]);
  if (leftovers.length > 0) {
    await docker(["rm", "-f", ...leftovers], { timeoutMs: 30_000 }).catch(() => {});
  }
  harness.db.close();
  rmSync(harness.dir, { recursive: true, force: true });
  harness = null;
});
