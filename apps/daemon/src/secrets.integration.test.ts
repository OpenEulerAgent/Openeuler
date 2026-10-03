import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import pino from "pino";
import { createExecutor } from "./executor.js";
import type { Executor } from "./executor.js";
import { encryptSecretValue } from "./secrets-crypto.js";

/**
 * End-to-end secrets flow (#93): a project secret reaches the driver env in
 * plaintext, while every persisted surface (events, StepRun output, run
 * output, activity payload) only ever sees `***NAME***`.
 */

const SECRET_NAME = "NPM_TOKEN";
const SECRET_VALUE = "npat_rt_echo_me_778899";
const MARKER = `***${SECRET_NAME}***`;

const script: AgentEvent[] = [
  { type: "session", seq: 1, sessionId: "s_1" },
  { type: "message-delta", seq: 2, delta: `publishing with ${SECRET_VALUE}` },
  { type: "tool-call", seq: 3, tool: "write", input: { file: ".npmrc", content: SECRET_VALUE } },
  { type: "tool-output", seq: 4, output: `wrote token ${SECRET_VALUE} to .npmrc` },
  { type: "done", seq: 5, output: `done; token was ${SECRET_VALUE}` },
];

interface Harness {
  dir: string;
  db: Db;
  executor: Executor;
  driver: ReturnType<typeof createFakeDriver>;
  projectId: string;
  key: Buffer;
  logLines: string[];
  enqueue(task: string): string;
}

const created: Harness[] = [];

const setup = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-secrets-e2e-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repoPath, stdio: "pipe" });
  };
  git("add", "-A");
  git("-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init");
  mkdirSync(join(dir, "store"), { recursive: true });
  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: repoPath,
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });

  const key = crypto.getRandomValues(new Uint8Array(32)) as Buffer;
  db.projectSecrets.set(project.id, SECRET_NAME, encryptSecretValue(key, SECRET_VALUE));

  const logLines: string[] = [];
  const logger = pino({ level: "info" }, { write: (line: string) => logLines.push(line) });
  const driver = createFakeDriver({
    events: script,
    output: `final output mentions ${SECRET_VALUE}`,
  });
  const drivers = createDriverRegistry();
  drivers.registerDriver(driver);
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot: join(dir, "store") }),
    drivers,
    logger,
    secretsKey: key,
  });

  const harness: Harness = {
    dir,
    db,
    executor,
    driver,
    projectId: project.id,
    key,
    logLines,
    enqueue(task) {
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.runs.create({
        id: runId,
        projectId: project.id,
        status: "queued",
        branch: `agentloop/${runId}`,
        iteration: 0,
        task,
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
      return runId;
    },
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

const waitForStatus = async (h: Harness, runId: string, status: RunStatus): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (h.db.runs.get(runId)?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${status}: currently ${h.db.runs.get(runId)?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("secrets end-to-end (executor + engine redaction)", () => {
  it("driver receives the real value; all persisted output is redacted", async () => {
    const h = setup();
    const runId = h.enqueue(`publish with ${SECRET_NAME} please`);

    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 1. The driver got the plaintext value via env.
    expect(h.driver.calls).toHaveLength(1);
    expect(h.driver.calls[0]?.env).toMatchObject({ [SECRET_NAME]: SECRET_VALUE });

    // 2. The event stream shows the marker and never the raw value.
    const events = h.db.events.getSince(runId);
    expect(events.length).toBeGreaterThan(0);
    const eventJson = JSON.stringify(
      events.map((event) => ({ ...event, seq: undefined })),
      null,
      0,
    );
    expect(eventJson).toContain(MARKER);
    expect(eventJson).not.toContain(SECRET_VALUE);

    // 3. StepRun output + the run row carry the marker only.
    const stepRun = h.db.stepRuns.listByRun(runId)[0];
    expect(stepRun?.output).toContain(MARKER);
    expect(stepRun?.output).not.toContain(SECRET_VALUE);
    const run = h.db.runs.get(runId);
    expect(run?.output).toContain(MARKER);
    expect(run?.output).not.toContain(SECRET_VALUE);

    // 4. Activity feed payloads stay clean.
    const activityJson = JSON.stringify(
      h.db.activity.list({ limit: 100 }).map((row) => row.payload ?? {}),
    );
    expect(activityJson).not.toContain(SECRET_VALUE);

    // 5. Structured engine logs (run-tagged lines) are redacted too.
    const logDump = h.logLines.join("\n");
    expect(logDump).not.toContain(SECRET_VALUE);
  });

  it("raw value is nowhere in the events table (raw SQL grep)", async () => {
    const h = setup();
    const runId = h.enqueue("grep me");
    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");

    const hits = h.db.sqlite
      .prepare("SELECT count(*) AS n FROM events WHERE payload LIKE :needle")
      .get({ needle: `%${SECRET_VALUE}%` }) as { n: number };
    expect(hits.n).toBe(0);

    const stepRunHits = h.db.sqlite
      .prepare("SELECT count(*) AS n FROM step_runs WHERE output LIKE :needle")
      .get({ needle: `%${SECRET_VALUE}%` }) as { n: number };
    expect(stepRunHits.n).toBe(0);

    const runHits = h.db.sqlite
      .prepare("SELECT count(*) AS n FROM runs WHERE output LIKE :needle OR error LIKE :needle")
      .get({ needle: `%${SECRET_VALUE}%` }) as { n: number };
    expect(runHits.n).toBe(0);
  });

  it("a value rotated between runs is honored by the next run (fresh load per run)", async () => {
    const h = setup();
    const first = h.enqueue("first run");
    h.executor.startRun(first);
    await waitForStatus(h, first, "success");
    expect(h.driver.calls[0]?.env?.[SECRET_NAME]).toBe(SECRET_VALUE);

    const rotated = "npat_rt_rotated_445566";
    h.db.projectSecrets.set(h.projectId, SECRET_NAME, encryptSecretValue(h.key, rotated));

    const second = h.enqueue("second run");
    h.executor.startRun(second);
    await waitForStatus(h, second, "success");
    // The driver received the NEW plaintext…
    expect(h.driver.calls.at(-1)?.env?.[SECRET_NAME]).toBe(rotated);
    // …while the stale value — no longer a configured secret — passes
    // through the second run unredacted (the fake driver's script is
    // static), proving the redaction list is loaded fresh per run.
    const secondRun = h.db.runs.get(second);
    expect(secondRun?.output).toContain(SECRET_VALUE);
    expect(secondRun?.output).not.toContain(MARKER);
  });

  it("fail-closed: an undecryptable secret (wrong master key) fails the run", async () => {
    const h = setup();
    const wrongKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    h.db.projectSecrets.set(h.projectId, SECRET_NAME, encryptSecretValue(wrongKey, "unreachable"));
    const runId = h.enqueue("doomed run");
    h.executor.startRun(runId);
    await waitForStatus(h, runId, "failed");
    const run = h.db.runs.get(runId);
    expect(run?.error).toContain("failed to load project secrets");
    // The run never started a driver.
    expect(h.driver.calls).toHaveLength(0);
  });

  it("runs without any secrets configured behave exactly as before", async () => {
    const h = setup();
    h.db.projectSecrets.delete(h.projectId, SECRET_NAME);
    const runId = h.enqueue("plain run");
    h.executor.startRun(runId);
    await waitForStatus(h, runId, "success");
    expect(h.driver.calls[0]?.env).toBeUndefined();
    // The fake driver still echoed the (now unconfigured) value verbatim —
    // nothing to redact, output passes through untouched.
    expect(h.db.runs.get(runId)?.output).toContain(SECRET_VALUE);
  });
});
