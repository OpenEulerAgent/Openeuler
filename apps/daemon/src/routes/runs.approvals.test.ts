import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, Run, RunStatus, StepRun } from "@openeuler/core";
import { WorkflowGraphSchema } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import type { Executor } from "../executor.js";
import { createLogger } from "../logger.js";

/**
 * Approval-gate API matrix (#118): `POST /api/runs/:id/approvals/:nodeId`
 * and the awaiting block on `GET /api/runs/:id`, against a real executor +
 * graph run paused at an approval node.
 */

interface ApiHarness {
  dir: string;
  db: Db;
  executor: Executor;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
}

interface ErrorResponseBody {
  error: { code: string; message: string };
}

interface AwaitingBody {
  awaiting?: { nodeId: string; nodeName?: string; prompt: string; since: string };
}

const script: AgentEvent[] = [
  { type: "session", seq: 1, sessionId: "s_1" },
  { type: "message-delta", seq: 2, delta: "Implementing feature... " },
  { type: "done", seq: 3, output: "Feature implemented" },
];

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const created: { db: Db; dir: string }[] = [];

const setup = (): ApiHarness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-approvals-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  git(repoPath, "add", "-A");
  git(repoPath, "-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init");

  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: repoPath,
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });

  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver({ id: "fake", events: script, output: "IMPL-OUT" }));
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot: join(dir, "store") }),
    drivers,
    logger: createLogger("silent"),
  });
  const { app } = createApp({ db, logger: createLogger("silent"), executor });

  created.push({ db, dir });
  return {
    dir,
    db,
    executor,
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

/** a (agent) → gate (approval) → b (agent) → exit. */
const gateGraph = (): unknown =>
  WorkflowGraphSchema.parse({
    entryNodeId: "a",
    nodes: [
      {
        id: "a",
        type: "agent",
        name: "work",
        position: { x: 0, y: 0 },
        config: {
          driver: "fake",
          mode: "auto",
          promptTemplate: "{{task}}",
          continueSession: false,
        },
      },
      {
        id: "gate",
        type: "approval",
        name: "Human check",
        position: { x: 280, y: 0 },
        config: { prompt: "Ship these changes?" },
      },
      {
        id: "b",
        type: "agent",
        name: "after",
        position: { x: 560, y: 0 },
        config: {
          driver: "fake",
          mode: "auto",
          promptTemplate: "{{prevOutput}}",
          continueSession: false,
        },
      },
      { id: "exit", type: "exit", name: "Exit", position: { x: 840, y: 0 } },
    ],
    edges: [
      { id: "e-a-gate", source: "a", target: "gate", condition: { type: "always" } },
      { id: "e-gate-b", source: "gate", target: "b", condition: { type: "always" } },
      { id: "e-b-exit", source: "b", target: "exit", condition: { type: "always" } },
    ],
  });

/** Creates the workflow + revision and a queued run pinned to it. */
const enqueueGateRun = (h: ApiHarness): Run => {
  const workflow = h.db.workflows.create({
    id: crypto.randomUUID(),
    projectId: h.projectId,
    name: "gate flow",
    steps: [
      {
        id: "placeholder",
        name: "placeholder",
        driver: "fake",
        promptTemplate: "{{task}}",
        mode: "auto",
        continueSession: false,
      },
    ],
  });
  const revision = h.db.workflowRevisions.create(workflow.id, gateGraph());
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  return h.db.runs.create({
    id: runId,
    projectId: h.projectId,
    workflowId: workflow.id,
    workflowRevisionId: revision.id,
    status: "queued",
    branch: `agentloop/${runId}`,
    iteration: 0,
    task: "do the thing",
    createdAt: now,
    updatedAt: now,
  });
};

const postApproval = (
  h: ApiHarness,
  runId: string,
  nodeId: string,
  body: unknown,
): Promise<Response> =>
  h.request(`/api/runs/${runId}/approvals/${nodeId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const pollAwaiting = async (h: ApiHarness, runId: string, nodeId: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = h.db.runs.get(runId);
    if (run?.awaitingNodeId === nodeId) return;
    if (Date.now() > deadline) throw new Error(`run never awaited on ${nodeId}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const pollStatus = async (h: ApiHarness, runId: string, status: RunStatus): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (h.db.runs.get(runId)?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${status}; at ${h.db.runs.get(runId)?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("POST /api/runs/:id/approvals/:nodeId (#118)", () => {
  it("404s for an unknown run", async () => {
    const h = setup();
    const res = await postApproval(h, crypto.randomUUID(), "gate", { approve: true });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("RUN_NOT_FOUND");
  });

  it("404s for a node not in the run's pinned graph", async () => {
    const h = setup();
    const run = enqueueGateRun(h);
    const res = await postApproval(h, run.id, "nope", { approve: true });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("NODE_NOT_FOUND");
  });

  it("404s for runs without a graph revision (ad-hoc)", async () => {
    const h = setup();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    h.db.runs.create({
      id: runId,
      projectId: h.projectId,
      status: "success",
      branch: `agentloop/${runId}`,
      iteration: 0,
      createdAt: now,
      updatedAt: now,
    });
    const res = await postApproval(h, runId, "gate", { approve: true });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("NODE_NOT_FOUND");
  });

  it("409s before the run reaches the gate; 422s on a bad body", async () => {
    const h = setup();
    const run = enqueueGateRun(h);
    h.executor.startRun(run.id);

    const early = await postApproval(h, run.id, "gate", { approve: true });
    expect(early.status).toBe(409);
    expect(((await early.json()) as ErrorResponseBody).error.code).toBe("RUN_NOT_AWAITING");

    const bad = await h.request(`/api/runs/${run.id}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve: "yes" }),
    });
    expect(bad.status).toBe(422);

    const longNote = await h.request(`/api/runs/${run.id}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve: true, note: "x".repeat(2001) }),
    });
    expect(longNote.status).toBe(422);

    // Clean up: resolve the gate once open, then wait out the run.
    await pollAwaiting(h, run.id, "gate");
    await postApproval(h, run.id, "gate", { approve: true });
    await pollStatus(h, run.id, "success");
  });

  it("approve resolves the gate; GET detail carries awaiting {nodeId, prompt, since} and clears after", async () => {
    const h = setup();
    const run = enqueueGateRun(h);
    h.executor.startRun(run.id);
    await pollAwaiting(h, run.id, "gate");

    const detail = (await (await h.request(`/api/runs/${run.id}`)).json()) as AwaitingBody & {
      run: Run;
      steps: StepRun[];
    };
    expect(detail.awaiting).toMatchObject({
      nodeId: "gate",
      nodeName: "Human check",
      prompt: "Ship these changes?",
    });
    expect(typeof detail.awaiting?.since).toBe("string");
    const gateRow = detail.steps.find((step) => step.stepId === "gate");
    expect(gateRow?.status).toBe("awaiting_approval");

    const res = await postApproval(h, run.id, "gate", { approve: true, note: "looks good" });
    expect(res.status).toBe(200);
    await pollStatus(h, run.id, "success");

    const after = (await (await h.request(`/api/runs/${run.id}`)).json()) as AwaitingBody;
    expect(after.awaiting).toBeUndefined();

    // A second decision 409s (the gate is gone).
    const again = await postApproval(h, run.id, "gate", { approve: false });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorResponseBody).error.code).toBe("RUN_NOT_AWAITING");

    // The gate's node output is the note; the post-gate node ran.
    const rows = h.db.stepRuns.listByRun(run.id);
    expect(rows.find((step) => step.stepId === "gate")?.output).toBe("looks good");
    expect(rows.some((step) => step.stepId === "b")).toBe(true);
  });

  it("reject fails the run (no conditional outgoing) with the note in the error", async () => {
    const h = setup();
    const run = enqueueGateRun(h);
    h.executor.startRun(run.id);
    await pollAwaiting(h, run.id, "gate");

    const res = await postApproval(h, run.id, "gate", { approve: false, note: "not ready" });
    expect(res.status).toBe(200);
    await pollStatus(h, run.id, "failed");
    const failed = h.db.runs.get(run.id);
    expect(failed?.error).toContain("not ready");
    expect(h.db.runs.get(run.id)?.awaitingNodeId).toBeUndefined();
  });

  it("graceful shutdown interrupts an awaiting run; resume re-opens the gate and resolves", async () => {
    const h = setup();
    const run = enqueueGateRun(h);
    h.executor.startRun(run.id);
    await pollAwaiting(h, run.id, "gate");
    const since = h.db.runs.get(run.id)?.awaitingSince;

    await h.executor.shutdown();
    const suspended = h.db.runs.get(run.id);
    expect(suspended?.status).toBe("interrupted");
    expect(suspended?.awaitingNodeId).toBe("gate");
    expect(suspended?.awaitingSince).toBe(since);
    expect(h.db.stepRuns.listByRun(run.id).find((step) => step.stepId === "gate")?.status).toBe(
      "interrupted",
    );

    const resumed = await h.request(`/api/runs/${run.id}/resume`, { method: "POST" });
    expect(resumed.status).toBe(202);
    await pollAwaiting(h, run.id, "gate");
    expect(h.db.runs.get(run.id)?.awaitingSince).toBe(since);
    await postApproval(h, run.id, "gate", { approve: true });
    await pollStatus(h, run.id, "success");
  });
});
