import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run, RunStatus, Workflow } from "@openeuler/core";
import { WorkflowGraphSchema } from "@openeuler/core";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import type { DriverRegistry, FakeDriver } from "@openeuler/drivers";
import { createFlowEngine } from "./flow-engine.js";
import type { ApprovalTimerFactory, FlowEngine, RunControl } from "./flow-engine.js";
import { WorktreeManager } from "./worktree.js";

/**
 * Approval gate tests (#118): fake drivers against a temp database/store,
 * driven through the flow engine's real dispatch path. The gate waits are
 * resolved through `engine.resolveApproval` exactly like the daemon's
 * `POST /api/runs/:id/approvals/:nodeId`; timeouts fire through an
 * injected fake timer factory (no real-minute sleeps).
 */

interface Harness {
  dir: string;
  db: Db;
  engine: FlowEngine;
  worktrees: WorktreeManager;
  projectId: string;
  registry: DriverRegistry;
  drivers: { impl: FakeDriver; rev: FakeDriver; fail: FakeDriver };
  pinGraph(graph: unknown): { workflow: Workflow; revisionId: string };
  enqueueRevisionRun(revisionId: string, task?: string): Run;
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const created: Harness[] = [];
/** In-flight executeRun promises: drained before the db closes (afterEach). */
const inFlight: Array<Promise<void>> = [];

/** Starts a run without awaiting it; the harness drains it on cleanup. */
const startRun = (h: Harness, runId: string, control: RunControl): Promise<void> => {
  const executing = h.engine.executeRun(runId, control);
  inFlight.push(executing);
  return executing;
};

const setup = (options: { approvalTimer?: ApprovalTimerFactory } = {}): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-approval-"));
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

  const impl = createFakeDriver({
    id: "impl",
    events: [{ type: "session", seq: 1, sessionId: "s-impl" }],
    output: "IMPL-OUT",
  });
  const rev = createFakeDriver({
    id: "rev",
    events: [{ type: "session", seq: 1, sessionId: "s-rev" }],
    output: "REV-OUT",
  });
  const fail = createFakeDriver({
    id: "fail",
    events: [{ type: "session", seq: 1, sessionId: "s-fail" }],
    output: "boom",
    exitCode: 1,
    // Lets the sibling branch reach its gate before this branch fails.
    delayMs: 100,
  });

  const registry = createDriverRegistry();
  registry.registerDriver(impl);
  registry.registerDriver(rev);
  registry.registerDriver(fail);

  const worktrees = new WorktreeManager({ storeRoot: join(dir, "store") });
  const engine = createFlowEngine({
    db,
    worktrees,
    drivers: registry,
    ...(options.approvalTimer === undefined ? {} : { approvalTimer: options.approvalTimer }),
  });

  const placeholderStep = {
    id: "placeholder",
    name: "placeholder",
    driver: "impl",
    mode: "auto" as const,
    promptTemplate: "{{task}}",
    continueSession: false,
  };

  const harness: Harness = {
    dir,
    db,
    engine,
    worktrees,
    projectId: project.id,
    registry,
    drivers: { impl, rev, fail },
    pinGraph(graph) {
      const workflow = db.workflows.create({
        id: crypto.randomUUID(),
        projectId: project.id,
        name: "approval-flow",
        steps: [placeholderStep],
      });
      const revision = db.workflowRevisions.create(workflow.id, graph);
      return { workflow, revisionId: revision.id };
    },
    enqueueRevisionRun(revisionId, task = "fix the docs") {
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      return db.runs.create({
        id: runId,
        projectId: project.id,
        workflowId: (db.workflowRevisions.get(revisionId) as { workflowId: string }).workflowId,
        workflowRevisionId: revisionId,
        status: "queued",
        branch: `agentloop/${runId}`,
        iteration: 0,
        task,
        createdAt: now,
        updatedAt: now,
      });
    },
  };
  created.push(harness);
  return harness;
};

afterEach(async () => {
  await Promise.allSettled(inFlight.splice(0));
  while (created.length > 0) {
    const harness = created.pop() as Harness;
    harness.db.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

/** Control with abort-listener support, mirroring the daemon executor's. */
function makeControl(): { control: RunControl; abort: () => void } {
  const listeners = new Set<() => void>();
  let requested = false;
  return {
    control: {
      isAbortRequested: () => requested,
      onHandle: undefined,
      onAbort: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    abort: () => {
      requested = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

const awaitRun = async (
  h: Harness,
  runId: string,
  predicate: (run: Run) => boolean,
): Promise<Run> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = h.db.runs.get(runId) as Run;
    if (predicate(run)) return run;
    if (Date.now() > deadline) {
      throw new Error(`predicate never held; run: ${JSON.stringify(run, null, 2)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const awaitStatus = async (h: Harness, runId: string, status: RunStatus): Promise<Run> =>
  awaitRun(h, runId, (run) => run.status === status);

const awaitAwaiting = async (h: Harness, runId: string, nodeId: string): Promise<Run> =>
  awaitRun(h, runId, (run) => run.awaitingNodeId === nodeId);

// --- graph shapes ----------------------------------------------------------

const agentNode = (id: string, driver: string): unknown => ({
  id,
  type: "agent",
  name: id,
  position: { x: 0, y: 0 },
  config: {
    driver,
    mode: "auto",
    promptTemplate: `{{task}} (node ${id})`,
    continueSession: false,
  },
});

const exitNode = (id = "exit"): unknown => ({
  id,
  type: "exit",
  name: "Exit",
  position: { x: 560, y: 100 },
});

const approvalNode = (id = "gate", timeoutMinutes?: number): unknown => ({
  id,
  type: "approval",
  name: id,
  position: { x: 280, y: 0 },
  config: {
    prompt: "Ship these changes?",
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
  },
});

/** a → gate → b → exit (a single always chain through the gate). */
const gateChainGraph = (timeoutMinutes?: number): unknown =>
  WorkflowGraphSchema.parse({
    entryNodeId: "a",
    nodes: [
      agentNode("a", "impl"),
      approvalNode("gate", timeoutMinutes),
      agentNode("b", "rev"),
      exitNode(),
    ],
    edges: [
      { id: "e-a-gate", source: "a", target: "gate", condition: { type: "always" } },
      { id: "e-gate-b", source: "gate", target: "b", condition: { type: "always" } },
      { id: "e-b-exit", source: "b", target: "exit", condition: { type: "always" } },
    ],
  });

/** a → gate with approved/rejected conditional branches (router-friendly). */
const gateRouterGraph = (timeoutMinutes?: number): unknown =>
  WorkflowGraphSchema.parse({
    entryNodeId: "a",
    nodes: [
      agentNode("a", "impl"),
      approvalNode("gate", timeoutMinutes),
      agentNode("ship", "rev"),
      agentNode("fix", "impl"),
      exitNode(),
    ],
    edges: [
      { id: "e-a-gate", source: "a", target: "gate", condition: { type: "always" } },
      {
        id: "e-approved",
        source: "gate",
        target: "ship",
        condition: { type: "outputContains", pattern: "approved" },
        order: 0,
      },
      {
        id: "e-rejected",
        source: "gate",
        target: "fix",
        condition: { type: "outputContains", pattern: "rejected" },
        order: 1,
      },
      { id: "e-ship-exit", source: "ship", target: "exit", condition: { type: "always" } },
      { id: "e-fix-exit", source: "fix", target: "exit", condition: { type: "always" } },
    ],
  });

const eventTypes = (h: Harness, runId: string): string[] =>
  h.db.events.getSince(runId).map((event) => event.type);

// --- tests -----------------------------------------------------------------

describe("approval gates (#118)", () => {
  it("approve resumes the run: awaiting state exposed, events persisted, note becomes the output", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(gateChainGraph());
    const run = h.enqueueRevisionRun(revisionId);
    const { control } = makeControl();
    void startRun(h, run.id, control);

    const awaiting = await awaitAwaiting(h, run.id, "gate");
    expect(awaiting.status).toBe("running");
    expect(awaiting.awaitingSince).toBeDefined();
    // The gate's StepRun is awaiting_approval; the upstream node is done.
    const gateRow = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "gate");
    expect(gateRow?.status).toBe("awaiting_approval");
    const aRow = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "a");
    expect(aRow?.status).toBe("success");

    const types = eventTypes(h, run.id);
    expect(types).toContain("node.awaiting");
    const awaitingEvent = h.db.events
      .getSince(run.id)
      .find((event) => event.type === "node.awaiting");
    expect(awaitingEvent).toMatchObject({ nodeId: "gate", prompt: "Ship these changes?" });

    // Resolving a different node (or a finished wait) is rejected.
    expect(h.engine.resolveApproval(run.id, "a", true)).toEqual({ outcome: "not_awaiting" });
    expect(h.engine.resolveApproval(run.id, "gate", true, "ship it")).toEqual({
      outcome: "resolved",
    });

    const finished = await awaitStatus(h, run.id, "success");
    expect(finished.awaitingNodeId).toBeUndefined();
    expect(finished.output).toBe("REV-OUT");
    expect(eventTypes(h, run.id)).toContain("node.approved");
    const approvedEvent = h.db.events
      .getSince(run.id)
      .find((event) => event.type === "node.approved");
    expect(approvedEvent).toMatchObject({ nodeId: "gate", approved: true, note: "ship it" });

    const gateDone = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "gate");
    expect(gateDone?.status).toBe("success");
    expect(gateDone?.output).toBe("ship it");
    // A second resolution reports not-awaiting (the gate is gone).
    expect(h.engine.resolveApproval(run.id, "gate", true)).toEqual({ outcome: "not_awaiting" });
    // b ran after the gate opened.
    expect(h.drivers.rev.calls.length).toBe(1);
  });

  it("approve without a note defaults the node output to 'approved'", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(gateChainGraph());
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);

    await awaitAwaiting(h, run.id, "gate");
    h.engine.resolveApproval(run.id, "gate", true);
    await awaitStatus(h, run.id, "success");

    const gateDone = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "gate");
    expect(gateDone?.output).toBe("approved");
  });

  it("reject ROUTES when conditional outgoing edges branch on the outcome", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(gateRouterGraph());
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);

    await awaitAwaiting(h, run.id, "gate");
    h.engine.resolveApproval(run.id, "gate", false, "needs more tests");

    const finished = await awaitStatus(h, run.id, "success");
    expect(finished.status).toBe("success");
    // The rejected branch (fix, impl driver) ran — not the ship branch.
    const implStarts = h.drivers.impl.calls.length; // a + fix
    expect(implStarts).toBe(2);
    const gateDone = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "gate");
    expect(gateDone?.status).toBe("success");
    expect(gateDone?.output).toBe("rejected: needs more tests");
    const approvedEvent = h.db.events.getSince(run.id).find((e) => e.type === "node.approved");
    expect(approvedEvent).toMatchObject({ approved: false, note: "needs more tests" });
    const taken = h.db.events.getSince(run.id).filter((e) => e.type === "edge.taken");
    expect(taken.some((e) => e.edgeId === "e-rejected")).toBe(true);
    expect(taken.some((e) => e.edgeId === "e-approved")).toBe(false);
  });

  it("reject FAILS the run when the gate has no conditional outgoing edges", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(gateChainGraph());
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);

    await awaitAwaiting(h, run.id, "gate");
    h.engine.resolveApproval(run.id, "gate", false, "not good enough");

    const failed = await awaitStatus(h, run.id, "failed");
    expect(failed.error).toContain("rejected");
    expect(failed.error).toContain("not good enough");
    // The node downstream of the gate never ran.
    expect(h.db.stepRuns.listByRun(run.id).some((row) => row.stepId === "b")).toBe(false);
  });

  it("routing branches on the decision sentinel, not note text", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(gateRouterGraph());
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);

    await awaitAwaiting(h, run.id, "gate");
    // "approved" inside a rejection note must not take the approved edge.
    h.engine.resolveApproval(run.id, "gate", false, "the approved patch is not ready");

    const finished = await awaitStatus(h, run.id, "success");
    expect(finished.status).toBe("success");
    expect(h.drivers.rev.calls.length).toBe(0); // ship never ran
    const taken = h.db.events.getSince(run.id).filter((e) => e.type === "edge.taken");
    expect(taken.some((e) => e.edgeId === "e-rejected")).toBe(true);
    expect(taken.some((e) => e.edgeId === "e-approved")).toBe(false);
  });

  it("a rejected gate whose conditional branches match none fails the run", async () => {
    const h = setup();
    const graph = WorkflowGraphSchema.parse({
      entryNodeId: "a",
      nodes: [agentNode("a", "impl"), approvalNode("gate"), agentNode("ship", "rev"), exitNode()],
      edges: [
        { id: "e-a-gate", source: "a", target: "gate", condition: { type: "always" } },
        {
          id: "e-approved",
          source: "gate",
          target: "ship",
          condition: { type: "outputContains", pattern: "approved" },
        },
        { id: "e-ship-exit", source: "ship", target: "exit", condition: { type: "always" } },
      ],
    });
    const { revisionId } = h.pinGraph(graph);
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);

    await awaitAwaiting(h, run.id, "gate");
    h.engine.resolveApproval(run.id, "gate", false, "no");

    const failed = await awaitStatus(h, run.id, "failed");
    expect(failed.error).toContain("no outgoing branch matched");
    expect(h.drivers.rev.calls.length).toBe(0);
  });

  it("fail-fast cancels a sibling branch waiting at a gate (no hung drain)", async () => {
    const h = setup();
    const graph = WorkflowGraphSchema.parse({
      entryNodeId: "a",
      nodes: [
        agentNode("a", "impl"),
        agentNode("bad", "fail"),
        agentNode("good", "rev"),
        approvalNode("gate"),
        exitNode(),
      ],
      edges: [
        { id: "e-a-bad", source: "a", target: "bad", condition: { type: "always" } },
        { id: "e-a-good", source: "a", target: "good", condition: { type: "always" } },
        { id: "e-bad-exit", source: "bad", target: "exit", condition: { type: "always" } },
        { id: "e-good-gate", source: "good", target: "gate", condition: { type: "always" } },
        { id: "e-gate-exit", source: "gate", target: "exit", condition: { type: "always" } },
      ],
    });
    const { revisionId } = h.pinGraph(graph);
    const run = h.enqueueRevisionRun(revisionId);
    const { control, abort } = makeControl();
    void startRun(h, run.id, control);

    await awaitAwaiting(h, run.id, "gate");
    const failed = await awaitStatus(h, run.id, "failed");
    expect(failed.error).toContain("bad");
    const gateDone = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "gate");
    expect(gateDone?.status).toBe("aborted");
    expect(h.db.runs.get(run.id)?.awaitingNodeId).toBeUndefined();
    expect(eventTypes(h, run.id)).not.toContain("node.approved");
    // Keep the cleanup path deterministic even if the assertions above fail.
    abort();
  });

  it("timeout rejects the gate with note 'timed out' (fake clock)", async () => {
    const timers: Array<{ delayMs: number; fire: () => void; cancelled: boolean }> = [];
    const h = setup({
      approvalTimer: (delayMs, fire) => {
        const timer = { delayMs, fire, cancelled: false };
        timers.push(timer);
        return {
          cancel: () => {
            timer.cancelled = true;
          },
        };
      },
    });
    const { revisionId } = h.pinGraph(gateRouterGraph(5));
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);

    await awaitAwaiting(h, run.id, "gate");
    expect(timers.length).toBe(1);
    const timer = timers[0] as { delayMs: number; fire: () => void };
    expect(timer.delayMs).toBe(5 * 60_000);

    timer.fire();
    // Timeout = rejection: routed down the rejected branch, run succeeds.
    const finished = await awaitStatus(h, run.id, "success");
    expect(finished.status).toBe("success");
    const gateDone = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "gate");
    expect(gateDone?.output).toBe("rejected: timed out");
    const approvedEvent = h.db.events.getSince(run.id).find((e) => e.type === "node.approved");
    expect(approvedEvent).toMatchObject({ approved: false, note: "timed out" });
    expect(h.db.runs.get(run.id)?.awaitingNodeId).toBeUndefined();
  });

  it("a resolved gate cancels its pending timeout timer", async () => {
    const timers: Array<{ cancelled: boolean }> = [];
    const h = setup({
      approvalTimer: (_delayMs, fire) => {
        const timer = { cancelled: false };
        timers.push(timer);
        return {
          cancel: () => {
            timer.cancelled = true;
            // A cancelled timer firing anyway must be a no-op.
            fire();
          },
        };
      },
    });
    const { revisionId } = h.pinGraph(gateRouterGraph(5));
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);

    await awaitAwaiting(h, run.id, "gate");
    h.engine.resolveApproval(run.id, "gate", true);
    await awaitStatus(h, run.id, "success");
    expect((timers[0] as { cancelled: boolean }).cancelled).toBe(true);
  });

  it("abort while awaiting settles the node + run aborted", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(gateChainGraph());
    const run = h.enqueueRevisionRun(revisionId);
    const { control, abort } = makeControl();
    void startRun(h, run.id, control);

    await awaitAwaiting(h, run.id, "gate");
    abort();
    // The engine's drain settles the node aborted; the abort itself marks
    // the row — mirror the executor by marking before awaiting the drain.
    h.db.runs.updateStatus(run.id, "aborted");
    await awaitStatus(h, run.id, "aborted");

    const gateDone = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "gate");
    expect(gateDone?.status).toBe("aborted");
    expect(h.db.runs.get(run.id)?.awaitingNodeId).toBeUndefined();
    // The gate never emitted a decision event.
    expect(eventTypes(h, run.id)).not.toContain("node.approved");
    // The post-gate node never ran.
    expect(h.db.stepRuns.listByRun(run.id).some((row) => row.stepId === "b")).toBe(false);
  });

  it("a resumed timed gate subtracts time already spent (expired rejects immediately)", async () => {
    const timers: Array<{ delayMs: number }> = [];
    const h = setup();
    const { revisionId } = h.pinGraph(gateChainGraph(5));
    const run = h.enqueueRevisionRun(revisionId);
    const { control, abort } = makeControl();
    const first = h.engine.executeRun(run.id, control);
    await awaitAwaiting(h, run.id, "gate");

    // Simulate a restart after the timeout window already elapsed.
    h.db.runs.update(run.id, { status: "interrupted" });
    for (const row of h.db.stepRuns.listByRun(run.id)) {
      if (!["success", "failed", "aborted", "interrupted"].includes(row.status)) {
        h.db.stepRuns.update(row.id, { status: "interrupted" });
      }
    }
    abort();
    await first;
    const gateRowId = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "gate")?.id;
    if (gateRowId !== undefined) h.db.stepRuns.update(gateRowId, { status: "interrupted" });
    h.db.runs.update(run.id, {
      status: "interrupted",
      awaitingNodeId: "gate",
      awaitingSince: new Date(Date.now() - 6 * 60_000).toISOString(),
    });
    h.db.runs.updateStatus(run.id, "queued");

    const restarted = createFlowEngine({
      db: h.db,
      worktrees: h.worktrees,
      drivers: h.registry,
      approvalTimer: (delayMs) => {
        timers.push({ delayMs });
        return { cancel: () => undefined };
      },
    });
    const resumed = restarted.executeRun(run.id, makeControl().control);
    inFlight.push(resumed);

    const failed = await awaitStatus(h, run.id, "failed");
    expect(failed.error).toContain("rejected");
    expect(timers).toHaveLength(0); // expired — no fresh window
    const approvedEvent = h.db.events.getSince(run.id).find((e) => e.type === "node.approved");
    expect(approvedEvent).toMatchObject({ approved: false, note: "timed out" });
  });

  it("graceful shutdown suspends the gate interrupted and resume re-enters the same wait", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(gateChainGraph());
    const run = h.enqueueRevisionRun(revisionId);
    const { control, abort } = makeControl();
    const executing = startRun(h, run.id, control);
    await awaitAwaiting(h, run.id, "gate");
    const awaitingSince = h.db.runs.get(run.id)?.awaitingSince;

    // Mirror executor.shutdown: the row terminalizes interrupted BEFORE the
    // abort listener wakes the gate.
    h.db.runs.updateStatus(run.id, "interrupted");
    abort();
    await executing;
    const suspended = await awaitStatus(h, run.id, "interrupted");
    expect(suspended.awaitingNodeId).toBe("gate");
    expect(suspended.awaitingSince).toBe(awaitingSince);
    const gateRow = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "gate");
    expect(gateRow?.status).toBe("interrupted");
    expect(eventTypes(h, run.id)).not.toContain("node.approved");

    h.db.runs.updateStatus(run.id, "queued");
    const restarted = createFlowEngine({ db: h.db, worktrees: h.worktrees, drivers: h.registry });
    const resumed = restarted.executeRun(run.id, makeControl().control);
    inFlight.push(resumed);
    await awaitAwaiting(h, run.id, "gate");
    expect(h.db.runs.get(run.id)?.awaitingSince).toBe(awaitingSince);
    expect(restarted.resolveApproval(run.id, "gate", true, "ok")).toEqual({
      outcome: "resolved",
    });
    expect((await awaitStatus(h, run.id, "success")).output).toBe("REV-OUT");
  });

  it("daemon restart mid-await: resume re-enters the wait WITHOUT re-executing, then resolves", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(gateChainGraph());
    const run = h.enqueueRevisionRun(revisionId);
    const { control, abort } = makeControl();
    const first = h.engine.executeRun(run.id, control);
    await awaitAwaiting(h, run.id, "gate");
    const awaitingSince = h.db.runs.get(run.id)?.awaitingSince;

    // Simulate the boot sweep: run interrupted, non-terminal StepRuns
    // interrupted. The in-memory gate is gone with the dead process — the
    // abort listener stands in for the process dying under the wait.
    const sweep = (): void => {
      h.db.runs.update(run.id, { status: "interrupted" });
      for (const row of h.db.stepRuns.listByRun(run.id)) {
        if (!["success", "failed", "aborted", "interrupted"].includes(row.status)) {
          h.db.stepRuns.update(row.id, { status: "interrupted" });
        }
      }
    };
    sweep();
    abort();
    await first;
    // A resolution against the dead engine's gate is refused.
    expect(h.engine.resolveApproval(run.id, "gate", true)).toEqual({ outcome: "not_awaiting" });
    // The abort path settles/clears like a live abort; a real crash leaves
    // the row awaiting with the gate unreachable. Restore the exact
    // post-sweep state the resume path must reconstruct from.
    const gateRowId = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "gate")?.id;
    if (gateRowId !== undefined) {
      h.db.stepRuns.update(gateRowId, { status: "interrupted" });
    }
    h.db.runs.update(run.id, {
      status: "interrupted",
      awaitingNodeId: "gate",
      awaitingSince,
    });

    // "Restart": a fresh engine over the same db; the run is resumed.
    h.db.runs.updateStatus(run.id, "queued");
    const restarted = createFlowEngine({ db: h.db, worktrees: h.worktrees, drivers: h.registry });
    const resumed = restarted.executeRun(run.id, makeControl().control);
    inFlight.push(resumed);

    // Re-enters awaiting: awaitingNodeId restored (kept across the sweep),
    // no duplicate node.awaiting event, upstream nodes not re-run.
    await awaitAwaiting(h, run.id, "gate");
    const awaitingEvents = h.db.events.getSince(run.id).filter((e) => e.type === "node.awaiting");
    expect(awaitingEvents).toHaveLength(1);
    expect(h.drivers.impl.calls.length).toBe(1);
    const resumedRun = h.db.runs.get(run.id);
    expect(resumedRun?.awaitingSince).toBe(awaitingSince);

    // The restarted engine's gate resolves normally.
    expect(restarted.resolveApproval(run.id, "gate", true, "ok")).toEqual({ outcome: "resolved" });
    const finished = await awaitStatus(h, run.id, "success");
    expect(finished.output).toBe("REV-OUT");
    expect(h.drivers.rev.calls.length).toBe(1);
  });

  it("an approval node feeding a join delivers like an agent node", async () => {
    const h = setup();
    // a routes (conditional, matches its own IMPL-OUT) into the gate, with
    // an always fallback to b; both branches feed an any-join → exit.
    const graph = WorkflowGraphSchema.parse({
      entryNodeId: "a",
      nodes: [
        agentNode("a", "impl"),
        agentNode("b", "rev"),
        approvalNode("gate"),
        {
          id: "join",
          type: "join",
          name: "Join",
          position: { x: 0, y: 200 },
          config: { mode: "any" },
        },
        exitNode(),
      ],
      edges: [
        {
          id: "e-a-gate",
          source: "a",
          target: "gate",
          condition: { type: "outputContains", pattern: "IMPL" },
          order: 0,
        },
        { id: "e-a-b", source: "a", target: "b", condition: { type: "always" } },
        { id: "e-b-join", source: "b", target: "join", condition: { type: "always" } },
        { id: "e-gate-join", source: "gate", target: "join", condition: { type: "always" } },
        { id: "e-join-exit", source: "join", target: "exit", condition: { type: "always" } },
      ],
    });
    const { revisionId } = h.pinGraph(graph);
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);

    // The conditional branch matched: the gate (not b) is awaited on.
    await awaitAwaiting(h, run.id, "gate");
    h.engine.resolveApproval(run.id, "gate", true, "go");
    const finished = await awaitStatus(h, run.id, "success");
    expect(finished.status).toBe("success");
    // The join executed (joins keep no StepRun row — their execution is
    // event-only) and the gate's delivery arrived.
    const joinCompleted = h.db.events
      .getSince(run.id)
      .find((e) => e.type === "node.completed" && e.nodeId === "join");
    expect(joinCompleted).toBeDefined();
    const taken = h.db.events.getSince(run.id).filter((e) => e.type === "edge.taken");
    expect(taken.some((e) => e.edgeId === "e-gate-join")).toBe(true);
  });
});
