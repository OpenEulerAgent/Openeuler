import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, Run, RunStatus, Step, StepRun } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver, type FakeDriverOptions } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import type { Executor } from "../executor.js";
import { createLogger } from "../logger.js";
import { encryptSecretValue } from "../secrets-crypto.js";

/**
 * Route-level task/diff redaction (#93 QA follow-up): the persisted
 * `runs.task` is redacted at rest on every create path (ad-hoc POST
 * /api/runs, workflow run creation, retry copy), and the live cumulative
 * diff — the one diff surface that never passes through the engine's
 * redacted-before-persist writes — is scrubbed before it is served.
 */

const SECRET_NAME = "NPM_TOKEN";
const SECRET_VALUE = "npat_rt_at_rest_113355";
const MARKER = `***${SECRET_NAME}***`;

interface ApiHarness {
  dir: string;
  db: Db;
  executor: Executor;
  worktrees: WorktreeManager;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
}

interface RunBody {
  run: Run;
}

interface RunDetailBody {
  run: Run;
  steps: StepRun[];
}

interface DiffBody {
  scope: "step" | "cumulative";
  stat: string;
  patch: string;
}

const script: AgentEvent[] = [
  { type: "session", seq: 1, sessionId: "s_1" },
  { type: "done", seq: 2, output: "done" },
];

const created: { db: Db; dir: string }[] = [];

const setup = (fakeOpts: FakeDriverOptions = {}): ApiHarness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-runs-secrets-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  execFileSync("git", ["-C", repoPath, "add", "-A"], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-C",
      repoPath,
      "-c",
      "user.email=t@openeuler.dev",
      "-c",
      "user.name=T",
      "commit",
      "-m",
      "init",
    ],
    { stdio: "pipe" },
  );

  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: repoPath,
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });

  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  db.projectSecrets.set(project.id, SECRET_NAME, encryptSecretValue(key, SECRET_VALUE));

  const worktrees = new WorktreeManager({ storeRoot: join(dir, "store") });
  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver({ events: script, output: "done", ...fakeOpts }));
  const silentLogger = createLogger("silent");
  const executor = createExecutor({
    db,
    worktrees,
    drivers,
    logger: silentLogger,
    secretsKey: key,
  });
  const { app } = createApp({
    db,
    logger: silentLogger,
    executor,
    worktrees,
    secretsKey: key,
  });

  created.push({ db, dir });
  return {
    dir,
    db,
    executor,
    worktrees,
    request: (path, init) => Promise.resolve(app.request(path, init)),
    projectId: project.id,
  };
};

afterEach(() => {
  while (created.length > 0) {
    const item = created.pop() as { db: Db; dir: string };
    item.db.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

/** Count of runs rows whose task still contains the raw secret value. */
const rawTaskRows = (h: ApiHarness): number =>
  (
    h.db.sqlite
      .prepare("SELECT count(*) AS n FROM runs WHERE task LIKE :needle")
      .get({ needle: `%${SECRET_VALUE}%` }) as { n: number }
  ).n;

const postJson = (h: ApiHarness, path: string, body: unknown): Promise<Response> =>
  h.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const pollRun = async (h: ApiHarness, runId: string, want: RunStatus): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (h.db.runs.get(runId)?.status !== want) {
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${want}; currently ${h.db.runs.get(runId)?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("task redaction at rest (#93)", () => {
  it("POST /api/runs stores + serves the task redacted (ad-hoc path)", async () => {
    const h = setup();
    const res = await postJson(h, "/api/runs", {
      projectId: h.projectId,
      prompt: `publish using ${SECRET_VALUE} please`,
    });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as RunBody;
    // The API response (and the stored row behind it) carry the marker.
    expect(run.task).toBe(`publish using ${MARKER} please`);

    await pollRun(h, run.id, "success");
    expect(rawTaskRows(h)).toBe(0);
    const detail = (await (await h.request(`/api/runs/${run.id}`)).json()) as RunDetailBody;
    expect(detail.run.task).toContain(MARKER);
    expect(detail.run.task).not.toContain(SECRET_VALUE);
  });

  it("workflow run creation stores the task redacted", async () => {
    const h = setup();
    const steps: Step[] = [
      {
        id: "s1",
        name: "implement",
        driver: "fake",
        mode: "auto",
        promptTemplate: "Task: {{task}}",
        continueSession: false,
      },
    ];
    const workflow = h.db.workflows.create({
      id: crypto.randomUUID(),
      projectId: h.projectId,
      name: "flow",
      steps,
    });

    const res = await postJson(h, `/api/workflows/${workflow.id}/runs`, {
      task: `ship it with ${SECRET_VALUE}`,
    });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as RunBody;
    expect(run.task).toBe(`ship it with ${MARKER}`);

    await pollRun(h, run.id, "success");
    expect(rawTaskRows(h)).toBe(0);
  });

  it("retry re-redacts a legacy raw task on copy", async () => {
    const h = setup();
    // A pre-redaction-at-rest row: finished, task still raw.
    const legacyId = crypto.randomUUID();
    const now = new Date().toISOString();
    h.db.runs.create({
      id: legacyId,
      projectId: h.projectId,
      status: "success",
      branch: `agentloop/${legacyId}`,
      iteration: 0,
      task: `legacy row holding ${SECRET_VALUE}`,
      createdAt: now,
      updatedAt: now,
    });

    const res = await postJson(h, `/api/runs/${legacyId}/retry`, {});
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as RunBody;
    expect(run.task).toBe(`legacy row holding ${MARKER}`);
    // The legacy row itself is untouched; the fresh copy is scrubbed.
    expect(h.db.runs.get(legacyId)?.task).toContain(SECRET_VALUE);
    expect(rawTaskRows(h)).toBe(1);

    await pollRun(h, run.id, "success");
  });
});

describe("cumulative diff redaction (#93)", () => {
  it("GET /api/runs/:id/diff?scope=cumulative redacts secret values in stat + patch", async () => {
    const h = setup({
      onStart: (opts) => {
        // The agent writes the secret into a file — its content lands in
        // the live worktree diff the cumulative scope serves.
        writeFileSync(join(opts.cwd, ".npmrc"), `token=${SECRET_VALUE}\n`);
      },
    });
    const res = await postJson(h, "/api/runs", { projectId: h.projectId, prompt: "configure npm" });
    const { run } = (await res.json()) as RunBody;
    await pollRun(h, run.id, "success");

    const diffRes = await h.request(`/api/runs/${run.id}/diff?scope=cumulative`);
    expect(diffRes.status).toBe(200);
    const body = (await diffRes.json()) as DiffBody;
    expect(body.scope).toBe("cumulative");
    expect(body.patch).toContain(MARKER);
    expect(body.patch).not.toContain(SECRET_VALUE);
    expect(body.stat).not.toContain(SECRET_VALUE);
    // The file on disk still holds the real value (only the served diff is
    // scrubbed) — the worktree is the agent's workspace, not an API surface.
    expect(h.worktrees.existing(run.id)).not.toBeNull();
  });
});
