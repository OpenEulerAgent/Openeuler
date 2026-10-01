import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BreadcrumbEntry,
  PersistedEvent,
  Project,
  Run,
  RunStatus,
  Workflow,
} from "@openeuler/core";
import { WorkflowGraphSchema } from "@openeuler/core";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import type { AgentHandle, DriverRegistry, FakeDriver } from "@openeuler/drivers";
import { createFlowEngine } from "./flow-engine.js";
import type { FlowEngine } from "./flow-engine.js";
import { WorktreeManager } from "./worktree.js";

/**
 * Integration tests for the serial DAG graph engine (#45): fake drivers
 * against a temp database/store, driven through the flow engine's dispatch
 * (`executeRun` on a revision-pinned run) so the real entry path is covered.
 */

interface Harness {
  dir: string;
  db: Db;
  engine: FlowEngine;
  worktrees: WorktreeManager;
  storeRoot: string;
  projectId: string;
  registry: DriverRegistry;
  drivers: { impl: FakeDriver; rev: FakeDriver; ship: FakeDriver; boom: FakeDriver };
  /** Creates a workflow row + its first graph revision from raw graph JSON. */
  pinGraph(graph: unknown): { workflow: Workflow; revisionId: string };
  enqueueRevisionRun(revisionId: string, task?: string): Run;
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const created: Harness[] = [];

const setup = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-graph-"));
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
    events: [
      { type: "session", seq: 1, sessionId: "s-impl" },
      { type: "message-delta", seq: 2, delta: "implementing" },
    ],
    output: "IMPL-OUT",
  });
  const rev = createFakeDriver({
    id: "rev",
    events: [{ type: "session", seq: 1, sessionId: "s-rev" }],
    output: "REV-OUT",
  });
  const ship = createFakeDriver({
    id: "ship",
    events: [{ type: "session", seq: 1, sessionId: "s-ship" }],
    output: "SHIP-OUT",
  });
  const boom = createFakeDriver({
    id: "boom",
    events: [{ type: "session", seq: 1, sessionId: "s-boom" }],
    output: "PARTIAL",
    exitCode: 7,
  });

  const registry = createDriverRegistry();
  for (const driver of [impl, rev, ship, boom]) registry.registerDriver(driver);

  const storeRoot = join(dir, "store");
  const worktrees = new WorktreeManager({ storeRoot });
  const engine = createFlowEngine({ db, worktrees, drivers: registry });

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
    storeRoot,
    projectId: project.id,
    registry,
    drivers: { impl, rev, ship, boom },
    pinGraph(graph) {
      const workflow = db.workflows.create({
        id: crypto.randomUUID(),
        projectId: project.id,
        name: "graph-flow",
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

afterEach(() => {
  while (created.length > 0) {
    const harness = created.pop() as Harness;
    harness.db.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

const noAbort = {
  isAbortRequested: (): boolean => false,
  onHandle: undefined,
};

const awaitStatus = async (h: Harness, runId: string, status: RunStatus): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (h.db.runs.get(runId)?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${status}; currently ${h.db.runs.get(runId)?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// --- graph construction helpers -------------------------------------------

const agentNode = (
  id: string,
  driver: string,
  overrides: Partial<{
    name: string;
    promptTemplate: string;
    continueSession: boolean;
    y: number;
  }> = {},
): unknown => ({
  id,
  type: "agent",
  name: overrides.name ?? id,
  position: { x: 0, y: overrides.y ?? 0 },
  config: {
    driver,
    mode: "auto",
    promptTemplate: overrides.promptTemplate ?? "{{task}}",
    continueSession: overrides.continueSession ?? false,
  },
});

const exitNode = (id = "exit"): unknown => ({
  id,
  type: "exit",
  name: "Exit",
  position: { x: 560, y: 100 },
});

/** A→B→exit chain with per-node prompt templates. */
const chainGraph = (templates: Record<string, string>): unknown =>
  WorkflowGraphSchema.parse({
    entryNodeId: "a",
    nodes: [
      agentNode("a", "impl", { promptTemplate: templates.a ?? "{{task}}" }),
      agentNode("b", "rev", { promptTemplate: templates.b ?? "{{prevOutput}}" }),
      exitNode(),
    ],
    edges: [
      { id: "e-ab", source: "a", target: "b", condition: { type: "always" } },
      { id: "e-bexit", source: "b", target: "exit", condition: { type: "always" } },
    ],
  });

const eventTypes = (h: Harness, runId: string): string[] =>
  h.db.events.getSince(runId).map((event) => event.type);

/** All persisted events of one type, narrowed to that variant. */
const eventsOf = <T extends PersistedEvent["type"]>(
  h: Harness,
  runId: string,
  type: T,
): Array<Extract<PersistedEvent, { type: T }>> =>
  h.db.events
    .getSince(runId)
    .filter((event): event is Extract<PersistedEvent, { type: T }> => event.type === type);

const takenEdges = (h: Harness, runId: string): string[] =>
  eventsOf(h, runId, "edge.taken").map((event) => event.edgeId);

/** Replays node.completed + edge.taken events into breadcrumb entries (seq order). */
const replayBreadcrumb = (h: Harness, runId: string): BreadcrumbEntry[] =>
  h.db.events.getSince(runId).flatMap((event): BreadcrumbEntry[] => {
    if (event.type === "node.completed") {
      return [{ kind: "node" as const, nodeId: event.nodeId, iteration: event.iteration }];
    }
    if (event.type === "edge.taken") {
      return [{ kind: "edge" as const, edgeId: event.edgeId, iteration: event.iteration }];
    }
    return [];
  });

// ---------------------------------------------------------------------------

describe("graph engine (linear chain)", () => {
  it("runs a chain start to exit: node events instead of step events, chained prompts, per-node StepRuns", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(chainGraph({ a: "A[{{task}}]", b: "B[{{prevOutput}}]" }));
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    expect(h.drivers.impl.calls[0]?.prompt).toBe("A[fix the docs]");
    expect(h.drivers.impl.calls[0]?.cwd).toBe(join(h.storeRoot, run.id));
    expect(h.drivers.rev.calls[0]?.prompt).toBe("B[IMPL-OUT]");

    // StepRun.stepId = nodeId; one row per node, iteration 1 (per-node count).
    const rows = [...h.db.stepRuns.listByRun(run.id)].sort((a, b) =>
      a.stepId.localeCompare(b.stepId),
    );
    expect(rows.map((row) => [row.stepId, row.iteration, row.status, row.output])).toEqual([
      ["a", 1, "success", "IMPL-OUT"],
      ["b", 1, "success", "REV-OUT"],
    ]);

    // Events: run.status wraps node.*/driver events; edge.taken records each
    // traversal; NO step.*/loop.* events on graph runs.
    expect(eventTypes(h, run.id)).toEqual([
      "run.status",
      "node.queued",
      "node.started",
      "started",
      "session",
      "message-delta",
      "node.completed",
      "edge.taken",
      "node.queued",
      "node.started",
      "started",
      "session",
      "node.completed",
      "edge.taken",
      "run.status",
    ]);
    expect(
      h.db.events
        .getSince(run.id)
        .filter((event) => event.type.startsWith("step.") || event.type.startsWith("loop.")),
    ).toEqual([]);

    const completed = eventsOf(h, run.id, "node.completed");
    expect(completed[0]).toMatchObject({
      nodeId: "a",
      nodeName: "a",
      iteration: 1,
      status: "success",
      output: "IMPL-OUT",
      durationMs: expect.any(Number),
    });

    // Routing events carry the deciding condition + endpoints.
    expect(eventsOf(h, run.id, "edge.taken")[0]).toMatchObject({
      edgeId: "e-ab",
      source: "a",
      target: "b",
      matchedCondition: "always",
      iteration: 1,
    });

    expect(h.db.runs.get(run.id)).toMatchObject({
      status: "success",
      output: "REV-OUT",
      iteration: 0,
      workflowRevisionId: revisionId,
    });

    // The persisted breadcrumb is exactly what the events replay.
    expect(h.db.runs.get(run.id)?.breadcrumb).toEqual([
      { kind: "node", nodeId: "a", iteration: 1 },
      { kind: "edge", edgeId: "e-ab", iteration: 1 },
      { kind: "node", nodeId: "b", iteration: 1 },
      { kind: "edge", edgeId: "e-bexit", iteration: 1 },
    ]);
    expect(replayBreadcrumb(h, run.id)).toEqual(h.db.runs.get(run.id)?.breadcrumb);
  });

  it("ends successfully at a dead-end node with no outgoing edges (no exit node needed)", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "solo",
        nodes: [agentNode("solo", "impl")],
        edges: [],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    expect(h.drivers.impl.calls).toHaveLength(1);
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "IMPL-OUT" });
    expect(h.db.runs.get(run.id)?.breadcrumb).toEqual([
      { kind: "node", nodeId: "solo", iteration: 1 },
    ]);
  });
});

describe("graph engine (router if/else)", () => {
  const routerGraph = (triageDriver: string): unknown => ({
    entryNodeId: "triage",
    nodes: [
      agentNode("triage", triageDriver),
      agentNode("fix", "rev", { promptTemplate: "fix {{prevOutput}}", y: -120 }),
      agentNode("escalate", "ship", { promptTemplate: "escalate {{prevOutput}}", y: 120 }),
      exitNode(),
    ],
    edges: [
      {
        id: "e-bug",
        source: "triage",
        target: "fix",
        condition: { type: "outputContains", pattern: "bug" },
        order: 0,
      },
      { id: "e-else", source: "triage", target: "escalate", condition: { type: "always" } },
      { id: "e-fix-exit", source: "fix", target: "exit", condition: { type: "always" } },
      { id: "e-esc-exit", source: "escalate", target: "exit", condition: { type: "always" } },
    ],
  });

  it("takes the TRUE conditional path when the condition matches", async () => {
    const h = setup();
    const bug = createFakeDriver({
      id: "bug",
      events: [{ type: "session", seq: 1, sessionId: "s-bug" }],
      output: "confirmed bug in parser",
    });
    h.registry.registerDriver(bug);
    const { revisionId } = h.pinGraph(routerGraph("bug"));
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    expect(takenEdges(h, run.id)).toEqual(["e-bug", "e-fix-exit"]);
    expect(h.drivers.ship.calls).toHaveLength(0);
    expect(h.drivers.rev.calls[0]?.prompt).toBe("fix confirmed bug in parser");
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "REV-OUT" });
    expect(eventsOf(h, run.id, "edge.taken")[0]).toMatchObject({
      edgeId: "e-bug",
      matchedCondition: 'outputContains "bug"',
    });
  });

  it("takes the always fallback when no conditional edge matches (FALSE path)", async () => {
    const h = setup();
    const question = createFakeDriver({
      id: "question",
      events: [{ type: "session", seq: 1, sessionId: "s-q" }],
      output: "works as intended",
    });
    h.registry.registerDriver(question);
    const { revisionId } = h.pinGraph(routerGraph("question"));
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    expect(takenEdges(h, run.id)).toEqual(["e-else", "e-esc-exit"]);
    expect(h.drivers.rev.calls).toHaveLength(0);
    expect(h.drivers.ship.calls[0]?.prompt).toBe("escalate works as intended");
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "SHIP-OUT" });
  });

  it("honors router order: first matching conditional wins, later ones never evaluate", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "pick",
        nodes: [
          agentNode("pick", "impl"),
          agentNode("first", "rev", { promptTemplate: "first {{prevOutput}}", y: -120 }),
          agentNode("second", "ship", { promptTemplate: "second {{prevOutput}}", y: 120 }),
          exitNode(),
        ],
        edges: [
          {
            id: "e-first",
            source: "pick",
            target: "first",
            condition: { type: "outputContains", pattern: "IMPL" },
            order: 1,
          },
          {
            id: "e-second",
            source: "pick",
            target: "second",
            condition: { type: "outputNotContains", pattern: "zzz" },
            order: 2,
          },
          { id: "e-f-exit", source: "first", target: "exit", condition: { type: "always" } },
          { id: "e-s-exit", source: "second", target: "exit", condition: { type: "always" } },
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // Both conditions match "IMPL-OUT" ("contains IMPL", "notContains zzz");
    // order 1 wins.
    expect(takenEdges(h, run.id)).toEqual(["e-first", "e-f-exit"]);
    expect(h.drivers.ship.calls).toHaveLength(0);
  });

  it("negates the match result on inverted edges (invert flag)", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "gate",
        nodes: [
          agentNode("gate", "impl"),
          agentNode("retry", "rev", { promptTemplate: "retry {{prevOutput}}", y: -120 }),
          agentNode("done", "ship", { promptTemplate: "done {{prevOutput}}", y: 120 }),
          exitNode(),
        ],
        edges: [
          {
            id: "e-retry",
            source: "gate",
            target: "retry",
            condition: { type: "outputMatches", regex: "status: green" },
            invert: true,
            order: 0,
          },
          { id: "e-done", source: "gate", target: "done", condition: { type: "always" } },
          { id: "e-r-exit", source: "retry", target: "exit", condition: { type: "always" } },
          { id: "e-d-exit", source: "done", target: "exit", condition: { type: "always" } },
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // "IMPL-OUT" does not match /status: green/, so the inverted edge MATCHES.
    expect(takenEdges(h, run.id)).toEqual(["e-retry", "e-r-exit"]);
    expect(eventsOf(h, run.id, "edge.taken")[0]).toMatchObject({
      matchedCondition: "outputMatches /status: green/ (inverted)",
    });
  });
});

describe("graph engine (loops + cycle guards)", () => {
  /** fix self-loops while its output lacks DONE, then exits via the fallback. */
  const loopGraph = (driver: string, maxIterations: number, fallbackToExit = true): unknown =>
    WorkflowGraphSchema.parse({
      entryNodeId: "fix",
      nodes: [
        agentNode("fix", driver, { promptTemplate: "fix {{task}} (pass {{iterations}})" }),
        ...(fallbackToExit ? [exitNode()] : []),
      ],
      edges: [
        {
          id: "e-loop",
          source: "fix",
          target: "fix",
          condition: { type: "outputNotContains", pattern: "DONE" },
          order: 0,
          maxIterations,
        },
        ...(fallbackToExit
          ? [{ id: "e-exit", source: "fix", target: "exit", condition: { type: "always" } }]
          : []),
      ],
    });

  it("exits on the condition at iteration 3: exactly 3 executions, loop edge taken twice, per-node {{iterations}}", async () => {
    const h = setup();
    const cycler = createFakeDriver({
      id: "cycler",
      events: [{ type: "session", seq: 1, sessionId: "s-cycler" }],
      outputs: ["WIP-1", "WIP-2", "DONE"],
    });
    h.registry.registerDriver(cycler);
    const { revisionId } = h.pinGraph(loopGraph("cycler", 5));
    const run = h.enqueueRevisionRun(revisionId, "get to green");

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    expect(cycler.calls.map((call) => call.prompt)).toEqual([
      "fix get to green (pass 1)",
      "fix get to green (pass 2)",
      "fix get to green (pass 3)",
    ]);
    expect(takenEdges(h, run.id)).toEqual(["e-loop", "e-loop", "e-exit"]);

    // Per-node execution numbers on the StepRun rows and the live run counter
    // (0-based final pass).
    expect(h.db.stepRuns.listByRun(run.id).map((row) => [row.iteration, row.status])).toEqual([
      [1, "success"],
      [2, "success"],
      [3, "success"],
    ]);
    expect(h.db.runs.get(run.id)).toMatchObject({
      status: "success",
      output: "DONE",
      iteration: 2,
    });

    // node.completed carries each execution's output.
    expect(
      eventsOf(h, run.id, "node.completed").map((event) => [event.iteration, event.output]),
    ).toEqual([
      [1, "WIP-1"],
      [2, "WIP-2"],
      [3, "DONE"],
    ]);

    // Events fully describe execution: replay reconstructs the breadcrumb.
    expect(replayBreadcrumb(h, run.id)).toEqual([
      { kind: "node", nodeId: "fix", iteration: 1 },
      { kind: "edge", edgeId: "e-loop", iteration: 1 },
      { kind: "node", nodeId: "fix", iteration: 2 },
      { kind: "edge", edgeId: "e-loop", iteration: 2 },
      { kind: "node", nodeId: "fix", iteration: 3 },
      { kind: "edge", edgeId: "e-exit", iteration: 3 },
    ]);
    expect(replayBreadcrumb(h, run.id)).toEqual(h.db.runs.get(run.id)?.breadcrumb);
  });

  it("re-enters via a back-edge to an EARLIER node: prevOutput flows across the jump", async () => {
    const h = setup();
    const cycler = createFakeDriver({
      id: "cycler",
      events: [{ type: "session", seq: 1, sessionId: "s-cycler" }],
      outputs: ["WIP", "DONE"],
    });
    h.registry.registerDriver(cycler);
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "build",
        nodes: [
          agentNode("build", "impl", { promptTemplate: "build[{{prevOutput}}]#{{iterations}}" }),
          agentNode("verify", "cycler", {
            promptTemplate: "verify[{{prevOutput}}]#{{iterations}}",
            y: 120,
          }),
          exitNode(),
        ],
        edges: [
          { id: "e-bv", source: "build", target: "verify", condition: { type: "always" } },
          {
            id: "e-back",
            source: "verify",
            target: "build",
            condition: { type: "outputNotContains", pattern: "DONE" },
            order: 0,
            maxIterations: 3,
          },
          { id: "e-exit", source: "verify", target: "exit", condition: { type: "always" } },
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // build runs twice (its own 1-based counter), verify runs twice; after
    // the back-edge jump build receives verify's previous output.
    expect(h.drivers.impl.calls.map((call) => call.prompt)).toEqual(["build[]#1", "build[WIP]#2"]);
    expect(cycler.calls.map((call) => call.prompt)).toEqual([
      "verify[IMPL-OUT]#1",
      "verify[IMPL-OUT]#2",
    ]);
    expect(takenEdges(h, run.id)).toEqual(["e-bv", "e-back", "e-bv", "e-exit"]);
    expect(
      h.db.stepRuns
        .listByRun(run.id)
        .map((row) => `${row.stepId}#${row.iteration}`)
        .sort(),
    ).toEqual(["build#1", "build#2", "verify#1", "verify#2"]);
  });

  it("takes the always fallback when the per-edge cap is reached (run continues to success)", async () => {
    const h = setup();
    const stuck = createFakeDriver({
      id: "stuck",
      events: [{ type: "session", seq: 1, sessionId: "s-stuck" }],
      output: "still WIP",
    });
    h.registry.registerDriver(stuck);
    const { revisionId } = h.pinGraph(loopGraph("stuck", 3));
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // The edge may be TAKEN at most min(3, 25) = 3 times: 4 executions of
    // the node, then the guard blocks the 4th take and the always fallback
    // leads to the exit.
    expect(stuck.calls).toHaveLength(4);
    expect(takenEdges(h, run.id)).toEqual(["e-loop", "e-loop", "e-loop", "e-exit"]);

    const cap = eventsOf(h, run.id, "edge.cap-reached");
    expect(cap).toHaveLength(1);
    expect(cap[0]).toMatchObject({
      edgeId: "e-loop",
      source: "fix",
      target: "fix",
      taken: 3,
      maxIterations: 3,
    });
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "still WIP" });
    expect(h.db.stepRuns.listByRun(run.id)).toHaveLength(4);
  });

  it("fails the run at the hard cap when there is no fallback edge", async () => {
    const h = setup();
    const forever = createFakeDriver({
      id: "forever",
      events: [{ type: "session", seq: 1, sessionId: "s-forever" }],
      output: "AGAIN",
    });
    h.registry.registerDriver(forever);
    // maxIterations 100 is clamped to the hard cap 25; no fallback edge.
    const { revisionId } = h.pinGraph(loopGraph("forever", 100, false));
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "failed");

    expect(forever.calls).toHaveLength(26);
    const cap = eventsOf(h, run.id, "edge.cap-reached");
    expect(cap).toHaveLength(1);
    expect(cap[0]).toMatchObject({
      edgeId: "e-loop",
      taken: 25,
      maxIterations: 25,
    });

    const failed = h.db.runs.get(run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain('edge "e-loop"');
    expect(failed?.error).toContain("maxIterations is 25");
    expect(failed?.error).toContain("configured 100");
    expect(failed?.error).toContain("no always fallback edge");
    // Completed StepRuns stay inspectable; every execution recorded.
    expect(h.db.stepRuns.listByRun(run.id)).toHaveLength(26);
    expect(h.db.stepRuns.listByRun(run.id).every((row) => row.status === "success")).toBe(true);
  });
});

describe("graph engine (template variables across nodes)", () => {
  it("resolves {{output:<nodeId>}} from NON-adjacent upstream nodes (most recent output)", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "a",
        nodes: [
          agentNode("a", "impl"),
          agentNode("b", "rev", { promptTemplate: "B sees {{output:a}}" }),
          agentNode("c", "ship", { promptTemplate: "C sees {{output:a}} and {{output:b}}" }),
          exitNode(),
        ],
        edges: [
          { id: "e-ab", source: "a", target: "b", condition: { type: "always" } },
          { id: "e-bc", source: "b", target: "c", condition: { type: "always" } },
          { id: "e-cexit", source: "c", target: "exit", condition: { type: "always" } },
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    expect(h.drivers.rev.calls[0]?.prompt).toBe("B sees IMPL-OUT");
    expect(h.drivers.ship.calls[0]?.prompt).toBe("C sees IMPL-OUT and REV-OUT");
  });

  it("fails the node with an actionable message when a referenced node never ran on this path", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        // Diamond: entry routes to `late` unless it says GO; `summary`
        // references {{output:early}} which only runs on the GO path.
        entryNodeId: "gate",
        nodes: [
          agentNode("gate", "impl"),
          agentNode("early", "rev", { promptTemplate: "early", y: -120 }),
          agentNode("late", "ship", { promptTemplate: "late", y: 120 }),
          agentNode("summary", "impl", { promptTemplate: "summary of {{output:early}}" }),
          exitNode(),
        ],
        edges: [
          {
            id: "e-go",
            source: "gate",
            target: "early",
            condition: { type: "outputContains", pattern: "GO" },
            order: 0,
          },
          { id: "e-late", source: "gate", target: "late", condition: { type: "always" } },
          { id: "e-es", source: "early", target: "summary", condition: { type: "always" } },
          { id: "e-ls", source: "late", target: "summary", condition: { type: "always" } },
          { id: "e-sexit", source: "summary", target: "exit", condition: { type: "always" } },
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "failed");

    // "IMPL-OUT" lacks GO → the fallback routed to `late`; `early` never ran
    // so its output is missing at render time: node failure with attribution.
    const failed = h.db.runs.get(run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain('node "summary" (summary) failed');
    expect(failed?.error).toContain("{{output:early}}");

    const completed = eventsOf(h, run.id, "node.completed");
    expect(completed[completed.length - 1]).toMatchObject({
      nodeId: "summary",
      status: "failed",
      output: "",
    });
    // The path up to the failure stays inspectable.
    const rows = h.db.stepRuns.listByRun(run.id);
    expect(rows.map((row) => row.stepId).sort()).toEqual(["gate", "late", "summary"]);
  });
});

describe("graph engine (sessions)", () => {
  it("continueSession nodes reuse their own session across re-entries (like #16 same-step reuse)", async () => {
    const h = setup();
    const looper = createFakeDriver({
      id: "looper",
      events: [{ type: "session", seq: 1, sessionId: "s-looper" }],
      outputs: ["WIP", "WIP", "DONE"],
    });
    h.registry.registerDriver(looper);
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "setup",
        nodes: [
          agentNode("setup", "impl", { promptTemplate: "setup {{task}}" }),
          agentNode("polish", "looper", {
            promptTemplate: "polish ({{iterations}})",
            continueSession: true,
          }),
          exitNode(),
        ],
        edges: [
          { id: "e-sp", source: "setup", target: "polish", condition: { type: "always" } },
          {
            id: "e-loop",
            source: "polish",
            target: "polish",
            condition: { type: "outputNotContains", pattern: "DONE" },
            order: 0,
            maxIterations: 5,
          },
          { id: "e-exit", source: "polish", target: "exit", condition: { type: "always" } },
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // First entry continues the routing source's (setup's) session; every
    // re-entry reuses the node's OWN previous session.
    expect(looper.calls.map((call) => call.sessionId)).toEqual(["s-impl", "s-looper", "s-looper"]);
    const polishRows = h.db.stepRuns
      .listByRun(run.id)
      .filter((row) => row.stepId === "polish")
      .sort((a, b) => a.iteration - b.iteration);
    expect(polishRows.map((row) => [row.iteration, row.sessionId])).toEqual([
      [1, "s-looper"],
      [2, "s-looper"],
      [3, "s-looper"],
    ]);
  });
});

describe("graph engine (failure + abort)", () => {
  it("fails mid-graph with node attribution; prior StepRuns stay readable, later nodes never start", async () => {
    const h = setup();
    // Chain of 3 where node 2 of 3 (b) fails with a non-zero exit code.
    const { revisionId: failingRevision } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "a",
        nodes: [
          agentNode("a", "impl", { promptTemplate: "A[{{task}}]" }),
          agentNode("b", "boom", { promptTemplate: "B[{{prevOutput}}]" }),
          agentNode("c", "ship", { promptTemplate: "C[{{prevOutput}}]" }),
          exitNode(),
        ],
        edges: [
          { id: "e-ab", source: "a", target: "b", condition: { type: "always" } },
          { id: "e-bc", source: "b", target: "c", condition: { type: "always" } },
          { id: "e-cexit", source: "c", target: "exit", condition: { type: "always" } },
        ],
      }),
    );
    const run = h.enqueueRevisionRun(failingRevision);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "failed");

    const failed = h.db.runs.get(run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain('node "b" (b) failed: agent exited with code 7');
    expect(failed?.output).toBe("PARTIAL");

    const byNode = new Map(h.db.stepRuns.listByRun(run.id).map((row) => [row.stepId, row]));
    expect(byNode.get("a")?.status).toBe("success");
    expect(byNode.get("a")?.output).toBe("IMPL-OUT");
    expect(byNode.get("b")?.status).toBe("failed");
    expect(byNode.has("c")).toBe(false);
    expect(h.drivers.ship.calls).toHaveLength(0);

    // The breadcrumb records the path up to the failure.
    expect(h.db.runs.get(run.id)?.breadcrumb).toEqual([
      { kind: "node", nodeId: "a", iteration: 1 },
      { kind: "edge", edgeId: "e-ab", iteration: 1 },
      { kind: "node", nodeId: "b", iteration: 1 },
    ]);
  });

  it("aborts mid-node: run aborted, earlier nodes stay successful, one terminal run.status", async () => {
    const h = setup();
    const slow = createFakeDriver({
      id: "slow",
      events: [
        { type: "session", seq: 1, sessionId: "s-slow" },
        { type: "message-delta", seq: 2, delta: "half " },
        { type: "message-delta", seq: 3, delta: "done" },
      ],
      delayMs: 40,
    });
    h.registry.registerDriver(slow);
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "a",
        nodes: [
          agentNode("a", "impl"),
          agentNode("b", "slow", { promptTemplate: "B[{{prevOutput}}]" }),
          exitNode(),
        ],
        edges: [
          { id: "e-ab", source: "a", target: "b", condition: { type: "always" } },
          { id: "e-bexit", source: "b", target: "exit", condition: { type: "always" } },
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    let abortRequested = false;
    let handleCount = 0;
    const control = {
      isAbortRequested: (): boolean => abortRequested,
      onHandle: (handle: AgentHandle | undefined): void => {
        if (handle === undefined) return;
        handleCount += 1;
        if (handleCount === 2) {
          setTimeout(() => {
            abortRequested = true;
            void handle.abort();
          }, 5);
        }
      },
    };

    await h.engine.executeRun(run.id, control);
    await awaitStatus(h, run.id, "aborted");

    const byNode = new Map(h.db.stepRuns.listByRun(run.id).map((row) => [row.stepId, row]));
    expect(byNode.get("a")?.status).toBe("success");
    expect(byNode.get("b")?.status).toBe("aborted");
    expect(takenEdges(h, run.id)).toEqual(["e-ab"]);
    const statusEvents = eventsOf(h, run.id, "run.status").map((event) => event.status);
    expect(statusEvents).toEqual(["running", "aborted"]);
  });
});

describe("graph engine (resume after interruption — #19 interplay)", () => {
  const resumeGraph = (): unknown =>
    WorkflowGraphSchema.parse({
      entryNodeId: "a",
      nodes: [
        agentNode("a", "impl", { promptTemplate: "A[{{task}}]" }),
        agentNode("b", "rev", { promptTemplate: "B[{{prevOutput}}]" }),
        agentNode("c", "ship", { promptTemplate: "C[{{prevOutput}}]" }),
        exitNode(),
      ],
      edges: [
        { id: "e-ab", source: "a", target: "b", condition: { type: "always" } },
        { id: "e-bc", source: "b", target: "c", condition: { type: "always" } },
        { id: "e-cexit", source: "c", target: "exit", condition: { type: "always" } },
      ],
    });

  it("resumes an interrupted revision-pinned run: restarts the node with its sessionId, no re-runs", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(resumeGraph());
    const run = h.enqueueRevisionRun(revisionId);

    // Simulate the post-sweep state: a succeeded, b interrupted mid-flight
    // with its session recorded, the breadcrumb carrying a's completion.
    await h.worktrees.create(run.id, h.db.projects.get(h.projectId) as Project);
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "a",
      iteration: 1,
      status: "success",
      sessionId: "s-impl",
      output: "IMPL-OUT",
    });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "b",
      iteration: 1,
      status: "interrupted",
      sessionId: "s-rev-partial",
      output: "part",
    });
    h.db.runs.update(run.id, {
      status: "interrupted",
      breadcrumb: [{ kind: "node", nodeId: "a", iteration: 1 }],
    });
    h.db.runs.updateStatus(run.id, "queued");

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // a never re-ran; b restarted with ITS recorded session and a's output
    // as prevOutput; c chained normally.
    expect(h.drivers.impl.calls).toHaveLength(0);
    expect(h.drivers.rev.calls).toHaveLength(1);
    expect(h.drivers.rev.calls[0]?.sessionId).toBe("s-rev-partial");
    expect(h.drivers.rev.calls[0]?.prompt).toBe("B[IMPL-OUT]");
    expect(h.drivers.ship.calls[0]?.prompt).toBe("C[REV-OUT]");

    // One StepRun row per (node, iteration): b's interrupted row was reused.
    expect(
      h.db.stepRuns
        .listByRun(run.id)
        .sort((a, b) => a.stepId.localeCompare(b.stepId))
        .map((row) => `${row.stepId}#${row.iteration}:${row.status}`),
    ).toEqual(["a#1:success", "b#1:success", "c#1:success"]);
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "SHIP-OUT" });
    // The breadcrumb continues from the reconstructed state.
    expect(h.db.runs.get(run.id)?.breadcrumb).toEqual([
      { kind: "node", nodeId: "a", iteration: 1 },
      { kind: "node", nodeId: "b", iteration: 1 },
      { kind: "edge", edgeId: "e-bc", iteration: 1 },
      { kind: "node", nodeId: "c", iteration: 1 },
      { kind: "edge", edgeId: "e-cexit", iteration: 1 },
    ]);
  });

  it("resumes from a persisted edge traversal without re-emitting it (crash between edge and node start)", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(resumeGraph());
    const run = h.enqueueRevisionRun(revisionId);

    await h.worktrees.create(run.id, h.db.projects.get(h.projectId) as Project);
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "a",
      iteration: 1,
      status: "success",
      sessionId: "s-impl",
      output: "IMPL-OUT",
    });
    // The a→b edge was persisted (breadcrumb + event) but b never started.
    h.db.events.append(run.id, {
      type: "edge.taken",
      edgeId: "e-ab",
      source: "a",
      target: "b",
      matchedCondition: "always",
      iteration: 1,
    });
    h.db.runs.update(run.id, {
      status: "interrupted",
      breadcrumb: [
        { kind: "node", nodeId: "a", iteration: 1 },
        { kind: "edge", edgeId: "e-ab", iteration: 1 },
      ],
    });
    h.db.runs.updateStatus(run.id, "queued");

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    expect(h.drivers.impl.calls).toHaveLength(0);
    expect(h.drivers.rev.calls[0]?.prompt).toBe("B[IMPL-OUT]");
    // Exactly one a→b traversal across both lifetimes.
    expect(takenEdges(h, run.id)).toEqual(["e-ab", "e-bc", "e-cexit"]);
  });

  it("resumes a loop mid-flight: reconstructs per-node execution counts and guard state", async () => {
    const h = setup();
    const cycler = createFakeDriver({
      id: "cycler",
      events: [{ type: "session", seq: 1, sessionId: "s-cycler" }],
      outputs: ["WIP", "WIP", "DONE"],
    });
    h.registry.registerDriver(cycler);
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "fix",
        nodes: [
          agentNode("fix", "cycler", {
            promptTemplate: "fix #{{iterations}}",
            continueSession: true,
          }),
          exitNode(),
        ],
        edges: [
          {
            id: "e-loop",
            source: "fix",
            target: "fix",
            condition: { type: "outputNotContains", pattern: "DONE" },
            order: 0,
            maxIterations: 5,
          },
          { id: "e-exit", source: "fix", target: "exit", condition: { type: "always" } },
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    // Two completed passes (takes: 2), third interrupted mid-flight.
    await h.worktrees.create(run.id, h.db.projects.get(h.projectId) as Project);
    for (const iteration of [1, 2]) {
      h.db.stepRuns.create({
        id: crypto.randomUUID(),
        runId: run.id,
        stepId: "fix",
        iteration,
        status: "success",
        sessionId: "s-cycler",
        output: "WIP",
      });
    }
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "fix",
      iteration: 3,
      status: "interrupted",
      sessionId: "s-cycler",
      output: "part",
    });
    h.db.runs.update(run.id, {
      status: "interrupted",
      breadcrumb: [
        { kind: "node", nodeId: "fix", iteration: 1 },
        { kind: "edge", edgeId: "e-loop", iteration: 1 },
        { kind: "node", nodeId: "fix", iteration: 2 },
        { kind: "edge", edgeId: "e-loop", iteration: 2 },
      ],
    });
    h.db.runs.updateStatus(run.id, "queued");

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // Execution 3 restarts (its own session, its own number), then DONE
    // routes to the exit. The fake driver cycles outputs by CALL count, so
    // the restarted run replays WIP, WIP, DONE from call 1: executions 3
    // and 4 loop once more, execution 5 sees DONE and exits.
    expect(cycler.calls.map((call) => call.prompt)).toEqual(["fix #3", "fix #4", "fix #5"]);
    expect(cycler.calls.every((call) => call.sessionId === "s-cycler")).toBe(true);
    expect(takenEdges(h, run.id)).toEqual(["e-loop", "e-loop", "e-exit"]);
    expect(h.db.stepRuns.listByRun(run.id).map((row) => `${row.iteration}:${row.status}`)).toEqual([
      "1:success",
      "2:success",
      "3:success",
      "4:success",
      "5:success",
    ]);
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "DONE" });
  });

  it("finalizes a fully completed graph run on resume without re-running anything", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(resumeGraph());
    const run = h.enqueueRevisionRun(revisionId);

    await h.worktrees.create(run.id, h.db.projects.get(h.projectId) as Project);
    for (const [stepId, output] of [
      ["a", "IMPL-OUT"],
      ["b", "REV-OUT"],
      ["c", "SHIP-OUT"],
    ] as const) {
      h.db.stepRuns.create({
        id: crypto.randomUUID(),
        runId: run.id,
        stepId,
        iteration: 1,
        status: "success",
        output,
      });
    }
    h.db.runs.update(run.id, {
      status: "interrupted",
      breadcrumb: [
        { kind: "node", nodeId: "a", iteration: 1 },
        { kind: "edge", edgeId: "e-ab", iteration: 1 },
        { kind: "node", nodeId: "b", iteration: 1 },
        { kind: "edge", edgeId: "e-bc", iteration: 1 },
        { kind: "node", nodeId: "c", iteration: 1 },
      ],
    });
    h.db.runs.updateStatus(run.id, "queued");

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // Routing out of c never persisted: re-derived deterministically, the
    // c→exit traversal is emitted exactly once, no node re-runs.
    expect(h.drivers.impl.calls).toHaveLength(0);
    expect(h.drivers.rev.calls).toHaveLength(0);
    expect(h.drivers.ship.calls).toHaveLength(0);
    expect(takenEdges(h, run.id)).toEqual(["e-cexit"]);
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "SHIP-OUT" });
  });
});
