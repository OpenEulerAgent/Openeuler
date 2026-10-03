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
import type {
  AgentDriver,
  AgentExit,
  AgentHandle,
  AgentStartOpts,
  DriverRegistry,
  FakeDriver,
} from "@openeuler/drivers";
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

  it("flips the taken path when the router order is swapped (reorder changes first-match)", async () => {
    // The same two mutually-matching conditionals as the test above, but
    // with their `order` values swapped: the SECOND edge now wins. This is
    // the engine-level counterpart of the editor's reorder (#48) — moving a
    // conditional edge up/down renumbers its siblings the same way.
    const build = (firstOrder: number, secondOrder: number) =>
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
            order: firstOrder,
          },
          {
            id: "e-second",
            source: "pick",
            target: "second",
            condition: { type: "outputNotContains", pattern: "zzz" },
            order: secondOrder,
          },
          { id: "e-f-exit", source: "first", target: "exit", condition: { type: "always" } },
          { id: "e-s-exit", source: "second", target: "exit", condition: { type: "always" } },
        ],
      });

    const h = setup();
    const { revisionId: original } = h.pinGraph(build(1, 2));
    const runOriginal = h.enqueueRevisionRun(original);
    await h.engine.executeRun(runOriginal.id, noAbort);
    await awaitStatus(h, runOriginal.id, "success");
    expect(takenEdges(h, runOriginal.id)).toEqual(["e-first", "e-f-exit"]);

    const { revisionId: swapped } = h.pinGraph(build(2, 1));
    const runSwapped = h.enqueueRevisionRun(swapped);
    await h.engine.executeRun(runSwapped.id, noAbort);
    await awaitStatus(h, runSwapped.id, "success");
    expect(takenEdges(h, runSwapped.id)).toEqual(["e-second", "e-s-exit"]);
    expect(h.drivers.rev.calls).toHaveLength(1); // only the original run entered "first"
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
        // Router: entry sends to `early` only when it says GO, else to
        // `late`; both paths merge at a mode-any join, so `summary` runs on
        // every path but references {{output:early}}, which only exists on
        // the GO path.
        entryNodeId: "gate",
        nodes: [
          agentNode("gate", "impl"),
          agentNode("early", "rev", { promptTemplate: "early", y: -120 }),
          agentNode("late", "ship", { promptTemplate: "late", y: 120 }),
          {
            id: "j",
            type: "join",
            name: "merge",
            position: { x: 560, y: 0 },
            config: { mode: "any" },
          },
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
          { id: "e-ej", source: "early", target: "j", condition: { type: "always" } },
          { id: "e-lj", source: "late", target: "j", condition: { type: "always" } },
          { id: "e-js", source: "j", target: "summary", condition: { type: "always" } },
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

// ---------------------------------------------------------------------------
// #115: parallel fan-out + join/merge.
//

/** A fan-out diamond graph a→(b, c)→j→d→exit with per-node drivers. */
const diamondGraph = (options: {
  joinMode?: "all" | "any";
  bDriver?: string;
  cDriver?: string;
  dTemplate?: string;
}): unknown => ({
  entryNodeId: "a",
  nodes: [
    agentNode("a", "impl"),
    agentNode("b", options.bDriver ?? "d-b", { y: -120 }),
    agentNode("c", options.cDriver ?? "d-c", { y: 120 }),
    {
      id: "j",
      type: "join",
      name: "merge",
      position: { x: 560, y: 0 },
      ...(options.joinMode === undefined ? {} : { config: { mode: options.joinMode } }),
    },
    agentNode("d", "d-d", { promptTemplate: options.dTemplate ?? "D[{{prevOutput}}]" }),
    exitNode(),
  ],
  edges: [
    { id: "e-ab", source: "a", target: "b", condition: { type: "always" } },
    { id: "e-ac", source: "a", target: "c", condition: { type: "always" } },
    { id: "e-bj", source: "b", target: "j", condition: { type: "always" } },
    { id: "e-cj", source: "c", target: "j", condition: { type: "always" } },
    { id: "e-jd", source: "j", target: "d", condition: { type: "always" } },
    { id: "e-dexit", source: "d", target: "exit", condition: { type: "always" } },
  ],
});

describe("graph engine (parallel fan-out + join, #115)", () => {
  it("runs a diamond: both branches in parallel, join-all sees both outputs, downstream renders them", async () => {
    const h = setup();
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-b",
        events: [{ type: "session", seq: 1, sessionId: "s-b" }],
        output: "B-OUT",
      }),
    );
    const cSlow = createFakeDriver({
      id: "d-c",
      events: [{ type: "session", seq: 1, sessionId: "s-c" }],
      output: "C-OUT",
      delayMs: 25,
    });
    h.registry.registerDriver(cSlow);
    h.registry.registerDriver(createFakeDriver({ id: "d-d", events: [], output: "D-OUT" }));
    const { revisionId } = h.pinGraph(
      diamondGraph({
        dTemplate: "D[{{output:b}}|{{output:c}}|{{output:j}}]",
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // Both branch drivers ran (in parallel), each with a's output chained.
    expect(h.drivers.impl.calls).toHaveLength(1);
    const prompts = (id: string): string[] =>
      h.registry.getDriver(id) === undefined
        ? []
        : (h.registry.getDriver(id) as unknown as FakeDriver).calls.map((call) => call.prompt);
    void prompts;

    // Branch nodes carry the fan-out branch edgeId on their node.* events;
    // the fan-out itself emits no edge.taken (branches reported via
    // node.queued edgeIds) — but b→j / c→j / j→d DO (single always each).
    const queued = eventsOf(h, run.id, "node.queued");
    expect(queued.find((event) => event.nodeId === "b")).toMatchObject({ edgeId: "e-ab" });
    expect(queued.find((event) => event.nodeId === "c")).toMatchObject({ edgeId: "e-ac" });
    expect(queued.find((event) => event.nodeId === "j")?.edgeId).toBeUndefined();
    expect(eventsOf(h, run.id, "node.started").find((event) => event.nodeId === "c")).toMatchObject(
      { edgeId: "e-ac" },
    );
    expect(
      eventsOf(h, run.id, "node.completed").find((event) => event.nodeId === "b"),
    ).toMatchObject({ edgeId: "e-ab" });
    expect(takenEdges(h, run.id)).toEqual(["e-bj", "e-cj", "e-jd", "e-dexit"]);

    // The join executed instantly (no driver, no StepRun row) with the
    // branch outputs map — keyed by branch source node, edges-array order.
    const joinCompleted = eventsOf(h, run.id, "node.completed").find(
      (event) => event.nodeId === "j",
    );
    expect(joinCompleted).toMatchObject({
      status: "success",
      output: '{"b":"B-OUT","c":"C-OUT"}',
      durationMs: 0,
      iteration: 1,
    });
    expect(h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "j")).toBeUndefined();

    // Downstream renders branch outputs directly and the join's map.
    const dDriver = h.registry.getDriver("d-d") as unknown as FakeDriver;
    expect(dDriver.calls[0]?.prompt).toBe('D[B-OUT|C-OUT|{"b":"B-OUT","c":"C-OUT"}]');

    // Rows: one per agent node, all success; a, b, c, d.
    expect(
      h.db.stepRuns
        .listByRun(run.id)
        .sort((x, y) => x.stepId.localeCompare(y.stepId))
        .map((row) => [row.stepId, row.iteration, row.status]),
    ).toEqual([
      ["a", 1, "success"],
      ["b", 1, "success"],
      ["c", 1, "success"],
      ["d", 1, "success"],
    ]);

    // Breadcrumb: completions + taken edges + the join trigger, replayable.
    expect(h.db.runs.get(run.id)?.breadcrumb).toEqual([
      { kind: "node", nodeId: "a", iteration: 1 },
      { kind: "node", nodeId: "b", iteration: 1 },
      { kind: "edge", edgeId: "e-bj", iteration: 1 },
      { kind: "node", nodeId: "c", iteration: 1 },
      { kind: "edge", edgeId: "e-cj", iteration: 1 },
      { kind: "node", nodeId: "j", iteration: 1 },
      { kind: "edge", edgeId: "e-jd", iteration: 1 },
      { kind: "node", nodeId: "d", iteration: 1 },
      { kind: "edge", edgeId: "e-dexit", iteration: 1 },
    ]);
    expect(replayBreadcrumb(h, run.id)).toEqual(h.db.runs.get(run.id)?.breadcrumb);
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "D-OUT" });
  });

  it("fail-fast on a mode-all join: branch failure fails the run, the sibling in flight is cancelled", async () => {
    const h = setup();
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-boom",
        events: [{ type: "session", seq: 1, sessionId: "s-boom" }],
        output: "PARTIAL-B",
        exitCode: 3,
      }),
    );
    const slowC = createFakeDriver({
      id: "d-slow",
      events: [{ type: "session", seq: 1, sessionId: "s-c" }],
      output: "C-OUT",
      delayMs: 120,
    });
    h.registry.registerDriver(slowC);
    h.registry.registerDriver(createFakeDriver({ id: "d-d", output: "D-OUT" }));
    const { revisionId } = h.pinGraph(
      diamondGraph({ bDriver: "d-boom", cDriver: "d-slow", joinMode: "all" }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "failed");

    const failed = h.db.runs.get(run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain('node "b" (b) failed: agent exited with code 3');
    // The sibling branch was cancelled mid-flight (aborted, not failed).
    const byNode = new Map(h.db.stepRuns.listByRun(run.id).map((row) => [row.stepId, row]));
    expect(byNode.get("a")?.status).toBe("success");
    expect(byNode.get("b")?.status).toBe("failed");
    expect(byNode.get("c")?.status).toBe("aborted");
    expect(byNode.has("d")).toBe(false);
    // The join never executed.
    expect(eventsOf(h, run.id, "node.completed").find((e) => e.nodeId === "j")).toBeUndefined();
  });

  it("mode-any join: a branch failure is tolerated when another branch succeeds; the join sees the winner", async () => {
    const h = setup();
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-boom",
        events: [{ type: "session", seq: 1, sessionId: "s-boom" }],
        output: "",
        exitCode: 9,
      }),
    );
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-slow",
        events: [{ type: "session", seq: 1, sessionId: "s-c" }],
        output: "C-OUT",
        delayMs: 40,
      }),
    );
    const dDriver = createFakeDriver({ id: "d-d", output: "D-OUT" });
    h.registry.registerDriver(dDriver);
    const { revisionId } = h.pinGraph(
      diamondGraph({ bDriver: "d-boom", cDriver: "d-slow", joinMode: "any" }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // b failed but the run succeeded; the join triggered on c's arrival
    // with only the arrived branch in its outputs map.
    const joinCompleted = eventsOf(h, run.id, "node.completed").find(
      (event) => event.nodeId === "j",
    );
    expect(joinCompleted).toMatchObject({ status: "success", output: '{"c":"C-OUT"}' });
    expect(dDriver.calls).toHaveLength(1);
    const byNode = new Map(h.db.stepRuns.listByRun(run.id).map((row) => [row.stepId, row]));
    expect(byNode.get("b")?.status).toBe("failed");
    expect(byNode.get("c")?.status).toBe("success");
    expect(byNode.get("d")?.status).toBe("success");
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "D-OUT" });
  });

  it("mode-any join: when EVERY branch fails the run fails with join attribution", async () => {
    const h = setup();
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-boom1",
        output: "",
        exitCode: 4,
      }),
    );
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-boom2",
        output: "",
        exitCode: 5,
      }),
    );
    h.registry.registerDriver(createFakeDriver({ id: "d-d", output: "D-OUT" }));
    const { revisionId } = h.pinGraph(
      diamondGraph({ bDriver: "d-boom1", cDriver: "d-boom2", joinMode: "any" }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "failed");

    const failed = h.db.runs.get(run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain('join node "j" (mode any) never triggered');
    expect(failed?.error).toContain("source failed");
    // The join and downstream never executed.
    expect(eventsOf(h, run.id, "node.completed").find((e) => e.nodeId === "j")).toBeUndefined();
    expect(h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "d")).toBeUndefined();
  });

  it("a failure in a SERIAL prefix of an any-join is NOT tolerated (no sibling alternate path)", async () => {
    const h = setup();
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-prefix-boom",
        output: "",
        exitCode: 2,
      }),
    );
    // s (fails) → a →(b, c)→ j(any) → d: s precedes the fan-out entirely.
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "s",
        nodes: [
          agentNode("s", "d-prefix-boom"),
          agentNode("a", "impl"),
          agentNode("b", "d-b", { y: -120 }),
          agentNode("c", "d-c", { y: 120 }),
          {
            id: "j",
            type: "join",
            name: "merge",
            position: { x: 560, y: 0 },
            config: { mode: "any" },
          },
          agentNode("d", "d-d"),
          exitNode(),
        ],
        edges: [
          { id: "e-sa", source: "s", target: "a", condition: { type: "always" } },
          { id: "e-ab", source: "a", target: "b", condition: { type: "always" } },
          { id: "e-ac", source: "a", target: "c", condition: { type: "always" } },
          { id: "e-bj", source: "b", target: "j", condition: { type: "always" } },
          { id: "e-cj", source: "c", target: "j", condition: { type: "always" } },
          { id: "e-jd", source: "j", target: "d", condition: { type: "always" } },
          { id: "e-dexit", source: "d", target: "exit", condition: { type: "always" } },
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "failed");

    // s's failure starves every branch of the join: fail-fast, attribution
    // on the node (not the join).
    expect(h.db.runs.get(run.id)?.error).toContain('node "s" (s) failed');
    expect(h.db.runs.get(run.id)?.error).not.toContain("never triggered");
    expect(h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "b")).toBeUndefined();
  });

  it("inner concurrency cap: fan-out of 5 runs at most 3 node executions at once (default)", async () => {
    const h = setup();
    const delays = [50, 40, 30, 20, 10];
    for (const [index, delay] of delays.entries()) {
      h.registry.registerDriver(
        createFakeDriver({
          id: `fan-${index}`,
          events: [{ type: "session", seq: 1, sessionId: `s-${index}` }],
          output: `OUT-${index}`,
          delayMs: delay,
        }),
      );
    }
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "fanout",
        nodes: [
          agentNode("fanout", "impl"),
          ...delays.map((_, index) => agentNode(`n${index}`, `fan-${index}`, { y: index * 100 })),
          exitNode(),
        ],
        edges: [
          ...delays.map(
            (_, index) =>
              ({
                id: `e-f-${index}`,
                source: "fanout",
                target: `n${index}`,
                condition: { type: "always" },
              }) as const,
          ),
          ...delays.map(
            (_, index) =>
              ({
                id: `e-${index}-exit`,
                source: `n${index}`,
                target: "exit",
                condition: { type: "always" },
              }) as const,
          ),
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // All five queued up front (scheduling time), but at most 3 running.
    const events = h.db.events.getSince(run.id);
    let live = 0;
    let maxLive = 0;
    for (const event of events) {
      if (event.type === "node.started" && event.nodeId.startsWith("n")) live += 1;
      if (event.type === "node.completed" && event.nodeId.startsWith("n")) live -= 1;
      maxLive = Math.max(maxLive, live);
    }
    expect(maxLive).toBe(3);
    expect(live).toBe(0);
    expect(eventsOf(h, run.id, "node.queued").filter((e) => e.nodeId.startsWith("n"))).toHaveLength(
      5,
    );
  });

  it("inner concurrency cap is configurable (graphInnerConcurrency: 2)", async () => {
    const h = setup();
    for (const index of [0, 1, 2, 3, 4]) {
      h.registry.registerDriver(
        createFakeDriver({
          id: `fan-${index}`,
          events: [{ type: "session", seq: 1, sessionId: `s-${index}` }],
          output: `OUT-${index}`,
          delayMs: 30 - index * 5,
        }),
      );
    }
    const cappedEngine = createFlowEngine({
      db: h.db,
      worktrees: h.worktrees,
      drivers: h.registry,
      graphInnerConcurrency: 2,
    });
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "fanout",
        nodes: [
          agentNode("fanout", "impl"),
          ...[0, 1, 2, 3, 4].map((index) =>
            agentNode(`m${index}`, `fan-${index}`, { y: index * 100 }),
          ),
          exitNode(),
        ],
        edges: [
          ...[0, 1, 2, 3, 4].map(
            (index) =>
              ({
                id: `e-f-${index}`,
                source: "fanout",
                target: `m${index}`,
                condition: { type: "always" },
              }) as const,
          ),
          ...[0, 1, 2, 3, 4].map(
            (index) =>
              ({
                id: `e-${index}-exit`,
                source: `m${index}`,
                target: "exit",
                condition: { type: "always" },
              }) as const,
          ),
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await cappedEngine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    const events = h.db.events.getSince(run.id);
    let live = 0;
    let maxLive = 0;
    for (const event of events) {
      if (event.type === "node.started" && event.nodeId.startsWith("m")) live += 1;
      if (event.type === "node.completed" && event.nodeId.startsWith("m")) live -= 1;
      maxLive = Math.max(maxLive, live);
    }
    expect(maxLive).toBe(2);
  });

  it("abort mid-branch cancels every in-flight sibling", async () => {
    const h = setup();
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-bslow",
        events: [{ type: "session", seq: 1, sessionId: "s-b" }],
        output: "B-OUT",
        delayMs: 200,
      }),
    );
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-cslow",
        events: [{ type: "session", seq: 1, sessionId: "s-c" }],
        output: "C-OUT",
        delayMs: 200,
      }),
    );
    const { revisionId } = h.pinGraph(diamondGraph({ bDriver: "d-bslow", cDriver: "d-cslow" }));
    const run = h.enqueueRevisionRun(revisionId);

    let abortRequested = false;
    let handleCount = 0;
    const control = {
      isAbortRequested: (): boolean => abortRequested,
      onHandle: (handle: AgentHandle | undefined): void => {
        if (handle === undefined) return;
        handleCount += 1;
        // The second branch handle arriving = both branches are in flight.
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

    // BOTH branches settled aborted (the aborted one + its cancelled
    // sibling), the join never executed, one terminal run.status.
    const byNode = new Map(h.db.stepRuns.listByRun(run.id).map((row) => [row.stepId, row]));
    expect(byNode.get("a")?.status).toBe("success");
    expect(byNode.get("b")?.status).toBe("aborted");
    expect(byNode.get("c")?.status).toBe("aborted");
    expect(byNode.has("d")).toBe(false);
    expect(eventsOf(h, run.id, "node.completed").find((e) => e.nodeId === "j")).toBeUndefined();
    expect(eventsOf(h, run.id, "run.status").map((event) => event.status)).toEqual([
      "running",
      "aborted",
    ]);
  });

  it("resumes mid-diamond: completed branches are kept, the in-flight branch re-runs, the join then triggers", async () => {
    const h = setup();
    const bDriver = createFakeDriver({
      id: "d-b",
      events: [{ type: "session", seq: 1, sessionId: "s-b" }],
      output: "B-OUT",
    });
    const cDriver = createFakeDriver({
      id: "d-c",
      events: [{ type: "session", seq: 1, sessionId: "s-c" }],
      output: "C-OUT",
    });
    const dDriver = createFakeDriver({ id: "d-d", output: "D-OUT" });
    h.registry.registerDriver(bDriver);
    h.registry.registerDriver(cDriver);
    h.registry.registerDriver(dDriver);
    const { revisionId } = h.pinGraph(diamondGraph({}));
    const run = h.enqueueRevisionRun(revisionId);

    // Simulate the crash state: a + b completed (b's edge into the join
    // taken), c interrupted mid-flight with its session recorded.
    await h.worktrees.create(run.id, h.db.projects.get(h.projectId) as Project);
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "a",
      iteration: 1,
      status: "success",
      sessionId: "s-a",
      output: "A-OUT",
    });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "b",
      iteration: 1,
      status: "success",
      sessionId: "s-b",
      output: "B-OUT",
    });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "c",
      iteration: 1,
      status: "interrupted",
      sessionId: "s-c-partial",
      output: "part",
    });
    h.db.runs.update(run.id, {
      status: "interrupted",
      breadcrumb: [
        { kind: "node", nodeId: "a", iteration: 1 },
        { kind: "node", nodeId: "b", iteration: 1 },
        { kind: "edge", edgeId: "e-bj", iteration: 1 },
      ],
    });
    h.db.runs.updateStatus(run.id, "queued");

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // a and b never re-ran; c restarted in its own recorded session; the
    // join triggered once both arrivals were recorded; d chained normally.
    expect(h.drivers.impl.calls).toHaveLength(0);
    expect(bDriver.calls).toHaveLength(0);
    expect(cDriver.calls).toHaveLength(1);
    expect(cDriver.calls[0]?.sessionId).toBe("s-c-partial");
    expect(dDriver.calls[0]?.prompt).toBe("D[" + JSON.stringify({ b: "B-OUT", c: "C-OUT" }) + "]");

    // Branch attribution survives the resume even without pre-crash
    // node.queued events: the graph shape recovers the fan-out branch
    // edge for the restarted execution's node.* events.
    expect(eventsOf(h, run.id, "node.started").find((event) => event.nodeId === "c")).toMatchObject(
      { edgeId: "e-ac" },
    );
    expect(
      eventsOf(h, run.id, "node.completed").find((event) => event.nodeId === "c"),
    ).toMatchObject({ edgeId: "e-ac" });
    // The restarted execution adopted its pre-crash row: with no pre-crash
    // node.queued announcement either, none is emitted at all.
    expect(eventsOf(h, run.id, "node.queued").filter((event) => event.nodeId === "c")).toHaveLength(
      0,
    );

    const joinCompleted = eventsOf(h, run.id, "node.completed").find(
      (event) => event.nodeId === "j",
    );
    expect(joinCompleted).toMatchObject({ output: '{"b":"B-OUT","c":"C-OUT"}' });
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "D-OUT" });
    expect(h.db.runs.get(run.id)?.breadcrumb).toEqual([
      { kind: "node", nodeId: "a", iteration: 1 },
      { kind: "node", nodeId: "b", iteration: 1 },
      { kind: "edge", edgeId: "e-bj", iteration: 1 },
      { kind: "node", nodeId: "c", iteration: 1 },
      { kind: "edge", edgeId: "e-cj", iteration: 1 },
      { kind: "node", nodeId: "j", iteration: 1 },
      { kind: "edge", edgeId: "e-jd", iteration: 1 },
      { kind: "node", nodeId: "d", iteration: 1 },
      { kind: "edge", edgeId: "e-dexit", iteration: 1 },
    ]);
  });

  it("mode-any trigger cancels the losing sibling still in flight", async () => {
    const h = setup();
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-fast",
        events: [{ type: "session", seq: 1, sessionId: "s-fast" }],
        output: "FAST-OUT",
        delayMs: 5,
      }),
    );
    const slowLoser = createFakeDriver({
      id: "d-slow-loser",
      events: [{ type: "session", seq: 1, sessionId: "s-loser" }],
      output: "SLOW-OUT",
      delayMs: 150,
    });
    h.registry.registerDriver(slowLoser);
    const dDriver = createFakeDriver({ id: "d-d", output: "D-OUT" });
    h.registry.registerDriver(dDriver);
    const { revisionId } = h.pinGraph(
      diamondGraph({ bDriver: "d-slow-loser", cDriver: "d-fast", joinMode: "any" }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // c won the race; b was cancelled at trigger time (row aborted) and its
    // output is not part of the join map.
    const byNode = new Map(h.db.stepRuns.listByRun(run.id).map((row) => [row.stepId, row]));
    expect(byNode.get("b")?.status).toBe("aborted");
    expect(byNode.get("c")?.status).toBe("success");
    const joinCompleted = eventsOf(h, run.id, "node.completed").find(
      (event) => event.nodeId === "j",
    );
    expect(joinCompleted).toMatchObject({ output: '{"c":"FAST-OUT"}' });
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "D-OUT" });
  });

  it("a guarded parallel loop re-enters the fan-out: join triggers once per round", async () => {
    const h = setup();
    // a →(b, c)→ j → d; d loops back to a while its output lacks DONE
    // (maxIterations 2), else exits.
    const aDriver = createFakeDriver({
      id: "loop-a",
      events: [{ type: "session", seq: 1, sessionId: "s-a" }],
      outputs: ["A-1", "A-2", "A-3"],
    });
    const bDriver = createFakeDriver({
      id: "loop-b",
      events: [{ type: "session", seq: 1, sessionId: "s-b" }],
      outputs: ["B-1", "B-2", "B-3"],
    });
    const cDriver = createFakeDriver({
      id: "loop-c",
      events: [{ type: "session", seq: 1, sessionId: "s-c" }],
      outputs: ["C-1", "C-2", "DONE"],
    });
    const dDriver = createFakeDriver({
      id: "loop-d",
      events: [{ type: "session", seq: 1, sessionId: "s-d" }],
      outputs: ["D-1", "D-2", "DONE"],
    });
    h.registry.registerDriver(aDriver);
    h.registry.registerDriver(bDriver);
    h.registry.registerDriver(cDriver);
    h.registry.registerDriver(dDriver);
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "a",
        nodes: [
          agentNode("a", "loop-a", { promptTemplate: "a#{{iterations}}" }),
          agentNode("b", "loop-b", { promptTemplate: "b[{{output:a}}]", y: -120 }),
          agentNode("c", "loop-c", { promptTemplate: "c[{{output:a}}]", y: 120 }),
          { id: "j", type: "join", name: "merge", position: { x: 560, y: 0 } },
          agentNode("d", "loop-d", { promptTemplate: "d[{{output:b}}+{{output:c}}]" }),
          exitNode(),
        ],
        edges: [
          { id: "e-ab", source: "a", target: "b", condition: { type: "always" } },
          { id: "e-ac", source: "a", target: "c", condition: { type: "always" } },
          { id: "e-bj", source: "b", target: "j", condition: { type: "always" } },
          { id: "e-cj", source: "c", target: "j", condition: { type: "always" } },
          { id: "e-jd", source: "j", target: "d", condition: { type: "always" } },
          {
            id: "e-loop",
            source: "d",
            target: "a",
            condition: { type: "outputNotContains", pattern: "DONE" },
            order: 0,
            maxIterations: 2,
          },
          { id: "e-exit", source: "d", target: "exit", condition: { type: "always" } },
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // Three rounds: fan-out → join each time, join iterations 1..3; the
    // final d output DONE routes to the exit. Join outputs track the most
    // recent branch outputs per round.
    const joinCompleted = eventsOf(h, run.id, "node.completed").filter(
      (event) => event.nodeId === "j",
    );
    expect(joinCompleted.map((event) => [event.iteration, event.output])).toEqual([
      [1, '{"b":"B-1","c":"C-1"}'],
      [2, '{"b":"B-2","c":"C-2"}'],
      [3, '{"b":"B-3","c":"DONE"}'],
    ]);
    expect(dDriver.calls.map((call) => call.prompt)).toEqual([
      "d[B-1+C-1]",
      "d[B-2+C-2]",
      "d[B-3+DONE]",
    ]);
    // Branch arrival order WITHIN a round is scheduler-dependent (the two
    // branches' diff captures race); the per-round set and the routing
    // sequence between rounds are the contract.
    const edges = takenEdges(h, run.id);
    expect(edges.filter((id) => id !== "e-bj" && id !== "e-cj")).toEqual([
      "e-jd",
      "e-loop",
      "e-jd",
      "e-loop",
      "e-jd",
      "e-exit",
    ]);
    expect(edges.filter((id) => id === "e-bj")).toHaveLength(3);
    expect(edges.filter((id) => id === "e-cj")).toHaveLength(3);
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "DONE" });
  });

  it("resumes an any-join diamond with an UN-PERSISTED trigger: the interrupted loser settles aborted, downstream executes exactly once", async () => {
    const h = setup();
    const bDriver = createFakeDriver({
      id: "d-b",
      events: [{ type: "session", seq: 1, sessionId: "s-b" }],
      output: "B-OUT",
    });
    const cDriver = createFakeDriver({
      id: "d-c",
      events: [{ type: "session", seq: 1, sessionId: "s-c" }],
      output: "C-OUT",
    });
    const dDriver = createFakeDriver({ id: "d-d", output: "D-OUT" });
    h.registry.registerDriver(bDriver);
    h.registry.registerDriver(cDriver);
    h.registry.registerDriver(dDriver);
    const { revisionId } = h.pinGraph(diamondGraph({ joinMode: "any" }));
    const run = h.enqueueRevisionRun(revisionId);

    // Crash between b's delivery into the join and the join execution: the
    // edge entry persisted, the join's own execution (and its sibling
    // cancellation) did not; c was still in flight.
    await h.worktrees.create(run.id, h.db.projects.get(h.projectId) as Project);
    h.db.events.append(run.id, {
      type: "node.queued",
      nodeId: "c",
      nodeName: "c",
      iteration: 1,
      edgeId: "e-ac",
    });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "a",
      iteration: 1,
      status: "success",
      sessionId: "s-a",
      output: "A-OUT",
    });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "b",
      iteration: 1,
      status: "success",
      sessionId: "s-b",
      output: "B-OUT",
    });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "c",
      iteration: 1,
      status: "interrupted",
      sessionId: "s-c-partial",
      output: "part",
    });
    h.db.runs.update(run.id, {
      status: "interrupted",
      breadcrumb: [
        { kind: "node", nodeId: "a", iteration: 1 },
        { kind: "node", nodeId: "b", iteration: 1 },
        { kind: "edge", edgeId: "e-bj", iteration: 1 },
      ],
    });
    h.db.runs.updateStatus(run.id, "queued");

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // The losing sibling never re-ran (round 1 already consumed by the
    // pending trigger — its execution would be stale); the join fired
    // exactly once and the downstream saw only the winner's map.
    expect(cDriver.calls).toHaveLength(0);
    expect(bDriver.calls).toHaveLength(0);
    expect(h.drivers.impl.calls).toHaveLength(0);
    expect(dDriver.calls).toHaveLength(1);
    expect(dDriver.calls[0]?.prompt).toBe('D[{"b":"B-OUT"}]');

    const joinCompleted = eventsOf(h, run.id, "node.completed").filter(
      (event) => event.nodeId === "j",
    );
    expect(joinCompleted).toHaveLength(1);
    expect(joinCompleted[0]).toMatchObject({ status: "success", output: '{"b":"B-OUT"}' });

    const rows = h.db.stepRuns.listByRun(run.id);
    expect(rows.filter((row) => row.stepId === "c").map((row) => [row.status, row.output])).toEqual(
      [["aborted", ""]],
    );
    // Downstream exactly once.
    expect(rows.filter((row) => row.stepId === "d")).toHaveLength(1);
    expect(rows.find((row) => row.stepId === "d")).toMatchObject({ status: "success" });
    // The loser's settlement mirrors an in-flight cancel: node.completed
    // aborted with its branch attribution, no duplicate node.queued.
    const cCompleted = eventsOf(h, run.id, "node.completed").filter(
      (event) => event.nodeId === "c",
    );
    expect(cCompleted).toHaveLength(1);
    expect(cCompleted[0]).toMatchObject({ status: "aborted", output: "", edgeId: "e-ac" });
    expect(eventsOf(h, run.id, "node.queued").filter((event) => event.nodeId === "c")).toHaveLength(
      1,
    );
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "D-OUT" });
  });

  it("resumes an any-join AFTER its trigger persisted: the loser settles aborted instead of re-triggering the join (single trigger per round)", async () => {
    const h = setup();
    const cDriver = createFakeDriver({
      id: "d-c",
      events: [{ type: "session", seq: 1, sessionId: "s-c" }],
      output: "C-OUT",
    });
    const dDriver = createFakeDriver({ id: "d-d", output: "D-OUT" });
    h.registry.registerDriver(cDriver);
    h.registry.registerDriver(dDriver);
    const { revisionId } = h.pinGraph(diamondGraph({ joinMode: "any" }));
    const run = h.enqueueRevisionRun(revisionId);

    // Crash after the any-join triggered on b's arrival (its execution
    // persisted, d scheduled) but before the cancelled loser c or the
    // downstream d settled.
    await h.worktrees.create(run.id, h.db.projects.get(h.projectId) as Project);
    for (const [stepId, output] of [
      ["a", "A-OUT"],
      ["b", "B-OUT"],
    ] as const) {
      h.db.stepRuns.create({
        id: crypto.randomUUID(),
        runId: run.id,
        stepId,
        iteration: 1,
        status: "success",
        sessionId: `s-${stepId}`,
        output,
      });
    }
    for (const stepId of ["c", "d"] as const) {
      h.db.stepRuns.create({
        id: crypto.randomUUID(),
        runId: run.id,
        stepId,
        iteration: 1,
        status: "interrupted",
        sessionId: `s-${stepId}-partial`,
        output: "part",
      });
    }
    h.db.runs.update(run.id, {
      status: "interrupted",
      breadcrumb: [
        { kind: "node", nodeId: "a", iteration: 1 },
        { kind: "node", nodeId: "b", iteration: 1 },
        { kind: "edge", edgeId: "e-bj", iteration: 1 },
        { kind: "node", nodeId: "j", iteration: 1 },
        { kind: "edge", edgeId: "e-jd", iteration: 1 },
      ],
    });
    h.db.runs.updateStatus(run.id, "queued");

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // c's interrupted execution was a round-1 loser (the join already
    // triggered on b's round-1 arrival): it settles aborted, its stale
    // delivery never re-triggers the join, and the downstream d simply
    // restarts — once.
    expect(cDriver.calls).toHaveLength(0);
    expect(dDriver.calls).toHaveLength(1);
    expect(dDriver.calls[0]?.prompt).toBe('D[{"b":"B-OUT"}]');
    expect(eventsOf(h, run.id, "node.completed").filter((event) => event.nodeId === "j")).toEqual(
      [],
    );
    expect(takenEdges(h, run.id)).toEqual(["e-dexit"]);
    const byNode = new Map(h.db.stepRuns.listByRun(run.id).map((row) => [row.stepId, row]));
    expect(byNode.get("c")?.status).toBe("aborted");
    expect(byNode.get("c")?.output).toBe("");
    expect(byNode.get("d")?.status).toBe("success");
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "D-OUT" });
  });

  it("a cancelled sibling whose driver ignores abort and exits naturally settles aborted and does not re-trigger the join", async () => {
    const h = setup();
    // The zombie: abort() is a no-op and the run keeps going, exiting 0 on
    // its own AFTER the join already triggered on the fast sibling.
    const zombieCalls: AgentStartOpts[] = [];
    const zombie: AgentDriver = {
      id: "d-zombie",
      start(opts) {
        zombieCalls.push(opts);
        let resolveExit!: (exit: AgentExit) => void;
        const exited = new Promise<AgentExit>((resolve) => {
          resolveExit = resolve;
        });
        const events = (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 80));
          yield { type: "session", seq: 1, sessionId: "s-zombie" } as const;
        })();
        setTimeout(() => resolveExit({ code: 0, reason: "exit", output: "ZOMBIE-OUT" }), 80);
        return { events, exited, abort: async () => {} };
      },
    };
    h.registry.registerDriver(zombie);
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-fast",
        events: [{ type: "session", seq: 1, sessionId: "s-fast" }],
        output: "FAST-OUT",
        delayMs: 5,
      }),
    );
    const dDriver = createFakeDriver({ id: "d-d", output: "D-OUT" });
    h.registry.registerDriver(dDriver);
    const { revisionId } = h.pinGraph(
      diamondGraph({ bDriver: "d-zombie", cDriver: "d-fast", joinMode: "any" }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // c won the race; b was cancelled at trigger time but finished by
    // itself — the superseded result settles aborted and never delivers,
    // so the join triggers exactly once and d executes exactly once.
    expect(zombieCalls).toHaveLength(1);
    const byNode = new Map(h.db.stepRuns.listByRun(run.id).map((row) => [row.stepId, row]));
    expect(byNode.get("b")?.status).toBe("aborted");
    expect(byNode.get("c")?.status).toBe("success");
    const joinCompleted = eventsOf(h, run.id, "node.completed").filter(
      (event) => event.nodeId === "j",
    );
    expect(joinCompleted).toHaveLength(1);
    expect(joinCompleted[0]).toMatchObject({ iteration: 1, output: '{"c":"FAST-OUT"}' });
    expect(dDriver.calls).toHaveLength(1);
    expect(h.db.stepRuns.listByRun(run.id).filter((row) => row.stepId === "d")).toHaveLength(1);
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "D-OUT" });
  });

  it("a winning any-join settles cap-blocked never-started siblings aborted (never swept to success)", async () => {
    const h = setup();
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-win",
        events: [{ type: "session", seq: 1, sessionId: "s-win" }],
        output: "WIN-OUT",
        delayMs: 5,
      }),
    );
    for (const id of ["d-slow1", "d-slow2"]) {
      h.registry.registerDriver(
        createFakeDriver({
          id,
          events: [{ type: "session", seq: 1, sessionId: `s-${id}` }],
          output: `${id}-OUT`,
          delayMs: 80,
        }),
      );
    }
    const neverCalls: AgentStartOpts[] = [];
    h.registry.registerDriver({
      id: "d-never",
      start(opts) {
        neverCalls.push(opts);
        throw new Error("cap-blocked sibling must never start");
      },
    });
    const xDriver = createFakeDriver({ id: "d-x", output: "X-OUT" });
    h.registry.registerDriver(xDriver);
    // Fan-out of FOUR behind the default inner concurrency cap of 3: the
    // fourth branch stays QUEUED (never started) when the fast winner
    // triggers the any-join.
    const { revisionId } = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "a",
        nodes: [
          agentNode("a", "impl"),
          agentNode("b", "d-win", { y: -180 }),
          agentNode("c", "d-slow1", { y: -60 }),
          agentNode("e", "d-slow2", { y: 60 }),
          agentNode("f", "d-never", { y: 180 }),
          {
            id: "j",
            type: "join",
            name: "merge",
            position: { x: 560, y: 0 },
            config: { mode: "any" },
          },
          agentNode("x", "d-x"),
          exitNode(),
        ],
        edges: [
          { id: "e-ab", source: "a", target: "b", condition: { type: "always" } },
          { id: "e-ac", source: "a", target: "c", condition: { type: "always" } },
          { id: "e-ae", source: "a", target: "e", condition: { type: "always" } },
          { id: "e-af", source: "a", target: "f", condition: { type: "always" } },
          { id: "e-bj", source: "b", target: "j", condition: { type: "always" } },
          { id: "e-cj", source: "c", target: "j", condition: { type: "always" } },
          { id: "e-ej", source: "e", target: "j", condition: { type: "always" } },
          { id: "e-fj", source: "f", target: "j", condition: { type: "always" } },
          { id: "e-jx", source: "j", target: "x", condition: { type: "always" } },
          { id: "e-xexit", source: "x", target: "exit", condition: { type: "always" } },
        ],
      }),
    );
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // The cap-blocked loser never started — its queued row settles
    // `aborted` with empty output (NOT swept to the run's success), with
    // a terminal node.completed mirroring the in-flight cancels; the
    // in-flight losers settle aborted as before.
    expect(neverCalls).toHaveLength(0);
    const rows = h.db.stepRuns.listByRun(run.id);
    expect(rows.filter((row) => row.stepId === "f").map((row) => [row.status, row.output])).toEqual(
      [["aborted", ""]],
    );
    expect(rows.find((row) => row.stepId === "f")).toMatchObject({ status: "aborted" });
    const fCompleted = eventsOf(h, run.id, "node.completed").filter(
      (event) => event.nodeId === "f",
    );
    expect(fCompleted).toHaveLength(1);
    expect(fCompleted[0]).toMatchObject({ status: "aborted", output: "", edgeId: "e-af" });
    const byNode = new Map(rows.map((row) => [row.stepId, row]));
    expect(byNode.get("c")?.status).toBe("aborted");
    expect(byNode.get("e")?.status).toBe("aborted");
    expect(byNode.get("b")?.status).toBe("success");
    expect(byNode.get("x")?.status).toBe("success");
    expect(xDriver.calls).toHaveLength(1);
    const joinCompleted = eventsOf(h, run.id, "node.completed").filter(
      (event) => event.nodeId === "j",
    );
    expect(joinCompleted).toHaveLength(1);
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "X-OUT" });
  });

  it("resumes mid-diamond without re-emitting node.queued for adopted restarts, keeping branch edge attribution", async () => {
    const h = setup();
    const bDriver = createFakeDriver({
      id: "d-b",
      events: [{ type: "session", seq: 1, sessionId: "s-b" }],
      output: "B-OUT",
    });
    const cDriver = createFakeDriver({
      id: "d-c",
      events: [{ type: "session", seq: 1, sessionId: "s-c" }],
      output: "C-OUT",
    });
    const dDriver = createFakeDriver({ id: "d-d", output: "D-OUT" });
    h.registry.registerDriver(bDriver);
    h.registry.registerDriver(cDriver);
    h.registry.registerDriver(dDriver);
    const { revisionId } = h.pinGraph(diamondGraph({}));
    const run = h.enqueueRevisionRun(revisionId);

    // Crash mid-diamond (mode all): a + b completed, b's arrival persisted,
    // c interrupted mid-flight — with the pre-crash node.queued events in
    // the log (as a real crash would have).
    await h.worktrees.create(run.id, h.db.projects.get(h.projectId) as Project);
    h.db.events.append(run.id, {
      type: "node.queued",
      nodeId: "b",
      nodeName: "b",
      iteration: 1,
      edgeId: "e-ab",
    });
    h.db.events.append(run.id, {
      type: "node.queued",
      nodeId: "c",
      nodeName: "c",
      iteration: 1,
      edgeId: "e-ac",
    });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "a",
      iteration: 1,
      status: "success",
      sessionId: "s-a",
      output: "A-OUT",
    });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "b",
      iteration: 1,
      status: "success",
      sessionId: "s-b",
      output: "B-OUT",
    });
    h.db.stepRuns.create({
      id: crypto.randomUUID(),
      runId: run.id,
      stepId: "c",
      iteration: 1,
      status: "interrupted",
      sessionId: "s-c-partial",
      output: "part",
    });
    h.db.runs.update(run.id, {
      status: "interrupted",
      breadcrumb: [
        { kind: "node", nodeId: "a", iteration: 1 },
        { kind: "node", nodeId: "b", iteration: 1 },
        { kind: "edge", edgeId: "e-bj", iteration: 1 },
      ],
    });
    h.db.runs.updateStatus(run.id, "queued");

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // Exactly one node.queued per (node, iteration) across BOTH lifetimes:
    // the restart ADOPTS the pre-crash row instead of re-announcing it.
    const queued = eventsOf(h, run.id, "node.queued");
    expect(queued.filter((event) => event.nodeId === "c")).toHaveLength(1);
    expect(queued.filter((event) => event.nodeId === "b")).toHaveLength(1);
    expect(queued.filter((event) => event.nodeId === "d")).toHaveLength(1);

    // Post-resume node.* events keep the branch attribution from the
    // pre-crash node.queued events; the join-scheduled d (chain edge)
    // stays unattributed.
    expect(eventsOf(h, run.id, "node.started").find((event) => event.nodeId === "c")).toMatchObject(
      { edgeId: "e-ac" },
    );
    expect(
      eventsOf(h, run.id, "node.completed").find((event) => event.nodeId === "c"),
    ).toMatchObject({ edgeId: "e-ac" });
    expect(
      eventsOf(h, run.id, "node.started").find((event) => event.nodeId === "d")?.edgeId,
    ).toBeUndefined();
    expect(cDriver.calls[0]?.sessionId).toBe("s-c-partial");
    expect(dDriver.calls[0]?.prompt).toBe('D[{"b":"B-OUT","c":"C-OUT"}]');
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "D-OUT" });
  });

  it("nested any-join with an inner loop: the outer join triggers exactly once per round (round identity is stable across inner loops)", async () => {
    const h = setup();
    h.registry.registerDriver(
      createFakeDriver({
        id: "d-b",
        events: [{ type: "session", seq: 1, sessionId: "s-b" }],
        output: "B-OUT",
        // Slow enough that z's branch chain (inner loop included) ALWAYS
        // wins j1 first — b's late delivery is the suppressed loser. The
        // chain is ~6 quick nodes; 1.5s leaves generous headroom under
        // parallel test load (150ms was flaky-raced on slow machines).
        delayMs: 1500,
      }),
    );
    h.registry.registerDriver(createFakeDriver({ id: "d-f", events: [], output: "F-OUT" }));
    h.registry.registerDriver(createFakeDriver({ id: "d-x", events: [], output: "X-OUT" }));
    h.registry.registerDriver(createFakeDriver({ id: "d-y", events: [], output: "Y-OUT" }));
    const zCycler = createFakeDriver({
      id: "d-z",
      events: [],
      outputs: ["LOOP", "DONE"],
    });
    h.registry.registerDriver(zCycler);
    const dDriver = createFakeDriver({ id: "d-d", events: [], output: "D-OUT" });
    h.registry.registerDriver(dDriver);

    // a fans out to (b, f). f fans out to (x, y) → j2(any) → z, which
    // loops back to f once (conditional contains LOOP) before finishing.
    // j1(any) merges (b, z) → d → exit. b is SLOW: z's branch chain wins
    // j1 first; b's later delivery must NOT re-trigger it — even though
    // z's chain went through an inner loop (execution numbers diverge from
    // the outer fan-out round; the round token must not).
    const { revisionId } = h.pinGraph({
      entryNodeId: "a",
      nodes: [
        agentNode("a", "impl"),
        agentNode("b", "d-b", { y: -160 }),
        agentNode("f", "d-f", { y: 160 }),
        agentNode("x", "d-x", { y: 80 }),
        agentNode("y", "d-y", { y: 240 }),
        {
          id: "j2",
          type: "join",
          name: "inner",
          position: { x: 560, y: 160 },
          config: { mode: "any" },
        },
        agentNode("z", "d-z", { y: 160, continueSession: true }),
        {
          id: "j1",
          type: "join",
          name: "outer",
          position: { x: 760, y: 0 },
          config: { mode: "any" },
        },
        agentNode("d", "d-d"),
        exitNode(),
      ],
      edges: [
        { id: "e-ab", source: "a", target: "b", condition: { type: "always" } },
        { id: "e-af", source: "a", target: "f", condition: { type: "always" } },
        { id: "e-fx", source: "f", target: "x", condition: { type: "always" } },
        { id: "e-fy", source: "f", target: "y", condition: { type: "always" } },
        { id: "e-xj2", source: "x", target: "j2", condition: { type: "always" } },
        { id: "e-yj2", source: "y", target: "j2", condition: { type: "always" } },
        { id: "e-j2z", source: "j2", target: "z", condition: { type: "always" } },
        {
          id: "e-zf",
          source: "z",
          target: "f",
          condition: { type: "outputContains", pattern: "LOOP" },
          maxIterations: 1,
        },
        { id: "e-zj1", source: "z", target: "j1", condition: { type: "always" } },
        { id: "e-bj1", source: "b", target: "j1", condition: { type: "always" } },
        { id: "e-j1d", source: "j1", target: "d", condition: { type: "always" } },
        { id: "e-dexit", source: "d", target: "exit", condition: { type: "always" } },
      ],
    });
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // The outer join completed ONCE (z's chain triggered it; b's late
    // delivery from the same round was suppressed), so d ran exactly once.
    const outerCompleted = eventsOf(h, run.id, "node.completed").filter(
      (event) => event.nodeId === "j1",
    );
    expect(outerCompleted).toHaveLength(1);
    expect(dDriver.calls).toHaveLength(1);
    expect(h.db.stepRuns.listByRun(run.id).filter((row) => row.stepId === "d")).toHaveLength(1);
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "D-OUT" });
    // The inner loop really ran (z twice, f twice) — execution numbers
    // diverged from the round, which is exactly what this test pins.
    expect(zCycler.calls).toHaveLength(2);
    expect(h.db.stepRuns.listByRun(run.id).filter((row) => row.stepId === "f")).toHaveLength(2);
  });

  it("legacy resume (round-less events): a triggered any-join still supersedes its interrupted sibling", async () => {
    const h = setup();
    const bDriver = createFakeDriver({
      id: "d-b",
      events: [],
      outputs: ["RETRY", "B-OUT"],
    });
    h.registry.registerDriver(bDriver);
    const cDriver = createFakeDriver({ id: "d-c", events: [], output: "C-OUT" });
    h.registry.registerDriver(cDriver);
    const dDriver = createFakeDriver({ id: "d-d", events: [], output: "D-OUT" });
    h.registry.registerDriver(dDriver);

    // b has a conditional self-loop (RETRY) before its always delivery to
    // the any-join j. Pre-crash: a done, b#1 RETRY looped, b#2 B-OUT
    // delivered and TRIGGERED j (join node entry persisted), j→d edge
    // persisted, c interrupted mid-flight, d never started.
    const { revisionId } = h.pinGraph({
      entryNodeId: "a",
      nodes: [
        agentNode("a", "impl"),
        agentNode("b", "d-b", { y: -120 }),
        agentNode("c", "d-c", { y: 120 }),
        {
          id: "j",
          type: "join",
          name: "merge",
          position: { x: 560, y: 0 },
          config: { mode: "any" },
        },
        agentNode("d", "d-d"),
        exitNode(),
      ],
      edges: [
        { id: "e-ab", source: "a", target: "b", condition: { type: "always" } },
        { id: "e-ac", source: "a", target: "c", condition: { type: "always" } },
        {
          id: "e-bb",
          source: "b",
          target: "b",
          condition: { type: "outputContains", pattern: "RETRY" },
          maxIterations: 2,
        },
        { id: "e-bj", source: "b", target: "j", condition: { type: "always" } },
        { id: "e-cj", source: "c", target: "j", condition: { type: "always" } },
        { id: "e-jd", source: "j", target: "d", condition: { type: "always" } },
        { id: "e-dexit", source: "d", target: "exit", condition: { type: "always" } },
      ],
    });
    const run = h.enqueueRevisionRun(revisionId);

    await h.worktrees.create(run.id, h.db.projects.get(h.projectId) as Project);
    for (const [stepId, iteration, status, output] of [
      ["a", 1, "success", "IMPL-OUT"],
      ["b", 1, "success", "RETRY"],
      ["b", 2, "success", "B-OUT"],
      ["c", 1, "interrupted", "part"],
    ] as const) {
      h.db.stepRuns.create({
        id: crypto.randomUUID(),
        runId: run.id,
        stepId,
        iteration,
        status,
        output,
      });
    }
    h.db.runs.update(run.id, {
      status: "interrupted",
      breadcrumb: [
        { kind: "node", nodeId: "a", iteration: 1 },
        { kind: "node", nodeId: "b", iteration: 1 },
        { kind: "edge", edgeId: "e-bb", iteration: 1 },
        { kind: "node", nodeId: "b", iteration: 2 },
        { kind: "edge", edgeId: "e-bj", iteration: 2 },
        { kind: "node", nodeId: "j", iteration: 1 },
        { kind: "edge", edgeId: "e-jd", iteration: 1 },
      ],
    });
    h.db.runs.updateStatus(run.id, "queued");

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // c is a round-1 loser of an already-triggered join: settled aborted,
    // never re-run, its would-be delivery never re-triggers the join, and
    // d executes exactly once.
    expect(cDriver.calls).toHaveLength(0);
    expect(dDriver.calls).toHaveLength(1);
    expect(
      eventsOf(h, run.id, "node.completed").filter((event) => event.nodeId === "j"),
    ).toHaveLength(0);
    expect(h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "c")).toMatchObject({
      status: "aborted",
    });
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "D-OUT" });
  });
});

// ---------------------------------------------------------------------------
// Sub-workflow nodes (#117): inline child runs.
//

describe("graph engine (sub-workflow nodes, #117)", () => {
  /** An agent → subworkflow(target) → exit graph. */
  const parentGraph = (targetWorkflowId: string, revision: "latest" | number = "latest") =>
    WorkflowGraphSchema.parse({
      entryNodeId: "a",
      nodes: [
        agentNode("a", "impl", { promptTemplate: "A[{{task}}]" }),
        {
          id: "sub",
          type: "subworkflow",
          name: "spawn",
          position: { x: 280, y: 0 },
          config: { workflowId: targetWorkflowId, revision },
        },
        exitNode(),
      ],
      edges: [
        { id: "e-asub", source: "a", target: "sub", condition: { type: "always" } },
        { id: "e-subexit", source: "sub", target: "exit", condition: { type: "always" } },
      ],
    });

  /** A 2-step agent chain ending in `secondDriver`. */
  const twoStepChildGraph = (firstDriver = "impl", secondDriver = "rev") =>
    WorkflowGraphSchema.parse({
      entryNodeId: "c1",
      nodes: [
        agentNode("c1", firstDriver, { promptTemplate: "C1[{{task}}]" }),
        agentNode("c2", secondDriver, { promptTemplate: "C2[{{prevOutput}}]" }),
        exitNode(),
      ],
      edges: [
        { id: "e-c1c2", source: "c1", target: "c2", condition: { type: "always" } },
        { id: "e-c2exit", source: "c2", target: "exit", condition: { type: "always" } },
      ],
    });

  it("waits for a 2-step child run: child output becomes the node + run output, childRunId links parent↔child", async () => {
    const h = setup();
    const child = h.pinGraph(twoStepChildGraph());
    const callsBefore = h.drivers.impl.calls.length;
    const { revisionId } = h.pinGraph(parentGraph(child.workflow.id));
    const run = h.enqueueRevisionRun(revisionId, "fix the docs");

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "success");

    // Child run: own row (parentRunId, same project, pinned revision), own
    // StepRuns, own event log — all terminal success.
    const children = h.db.runs.listByParentRun(run.id);
    expect(children).toHaveLength(1);
    const childRun = children[0] as Run;
    expect(childRun).toMatchObject({
      projectId: run.projectId,
      workflowId: child.workflow.id,
      workflowRevisionId: child.revisionId,
      parentRunId: run.id,
      status: "success",
      output: "REV-OUT",
    });
    const childSteps = h.db.stepRuns.listByRun(childRun.id);
    expect(
      childSteps
        .map((row) => [row.stepId, row.status])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["c1", "success"],
      ["c2", "success"],
    ]);
    expect(eventTypes(h, childRun.id)).toContain("node.started");
    expect(h.db.events.count(childRun.id)).toBeGreaterThan(0);
    // The child's first node rendered the parent task ({{task}}).
    expect(h.drivers.impl.calls[callsBefore]?.prompt).toContain("fix the docs");

    // Parent: the subworkflow node's output IS the child's final output, and
    // node.completed carries childRunId for the UI link.
    const subCompleted = eventsOf(h, run.id, "node.completed").find(
      (event) => event.nodeId === "sub",
    );
    expect(subCompleted).toMatchObject({
      status: "success",
      output: "REV-OUT",
      childRunId: childRun.id,
    });
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "REV-OUT" });
    expect(h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "sub")).toMatchObject({
      status: "success",
      output: "REV-OUT",
    });
  });

  it("resolves 'latest' at spawn time and an exact pinned revision when configured", async () => {
    const h = setup();
    // Child revision 1 ends in `impl`, revision 2 (later) ends in `ship`.
    const child = h.pinGraph(twoStepChildGraph("impl", "impl"));
    const childRev2 = h.db.workflowRevisions.create(
      child.workflow.id,
      twoStepChildGraph("impl", "ship"),
    );
    expect(childRev2.number).toBe(2);

    const pinned = h.pinGraph(parentGraph(child.workflow.id, 1));
    const pinnedRun = h.enqueueRevisionRun(pinned.revisionId);
    await h.engine.executeRun(pinnedRun.id, noAbort);
    await awaitStatus(h, pinnedRun.id, "success");
    const pinnedChild = h.db.runs.listByParentRun(pinnedRun.id)[0] as Run;
    expect(pinnedChild.workflowRevisionId).toBe(child.revisionId);
    expect(pinnedChild.output).toBe("IMPL-OUT");

    const latest = h.pinGraph(parentGraph(child.workflow.id, "latest"));
    const latestRun = h.enqueueRevisionRun(latest.revisionId);
    await h.engine.executeRun(latestRun.id, noAbort);
    await awaitStatus(h, latestRun.id, "success");
    const latestChild = h.db.runs.listByParentRun(latestRun.id)[0] as Run;
    expect(latestChild.workflowRevisionId).toBe(childRev2.id);
    expect(latestChild.output).toBe("SHIP-OUT");
  });

  it("child failure fails the parent node with child attribution", async () => {
    const h = setup();
    const child = h.pinGraph(twoStepChildGraph("impl", "boom"));
    const { revisionId } = h.pinGraph(parentGraph(child.workflow.id));
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "failed");

    const childRun = h.db.runs.listByParentRun(run.id)[0] as Run;
    expect(childRun.status).toBe("failed");
    expect(childRun.error).toContain("agent exited with code 7");

    const parent = h.db.runs.get(run.id);
    expect(parent?.status).toBe("failed");
    expect(parent?.error).toContain('node "spawn" (sub) failed');
    expect(parent?.error).toContain(`child run ${childRun.id} failed`);
    expect(h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "sub")?.status).toBe(
      "failed",
    );
  });

  it("an unresolvable workflow reference fails the node with a clear error", async () => {
    const h = setup();
    const { revisionId } = h.pinGraph(parentGraph("no-such-workflow"));
    const run = h.enqueueRevisionRun(revisionId);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "failed");

    const parent = h.db.runs.get(run.id);
    expect(parent?.error).toContain('unknown workflow "no-such-workflow"');
    // No child row was created for the unresolvable reference.
    expect(h.db.runs.listByParentRun(run.id)).toHaveLength(0);
  });

  it("depth cap: a 4-deep chain stops with a clear nesting error and no runaway runs", async () => {
    const h = setup();
    // w1 → w2 → w3 → w4 → w1 closes the cycle: w4's spawn would sit at
    // nesting depth 4 (one past the cap of 3), so the chain must terminate
    // with the clear cap error instead of recursing forever.
    const selfReferencing = (target: string) =>
      WorkflowGraphSchema.parse({
        entryNodeId: "a",
        nodes: [
          agentNode("a", "impl", { promptTemplate: "A[{{task}}]" }),
          {
            id: "sub",
            type: "subworkflow",
            name: "spawn",
            position: { x: 280, y: 0 },
            config: { workflowId: target, revision: "latest" },
          },
          exitNode(),
        ],
        edges: [
          { id: "e-asub", source: "a", target: "sub", condition: { type: "always" } },
          { id: "e-subexit", source: "sub", target: "exit", condition: { type: "always" } },
        ],
      });

    const placeholder = {
      id: "placeholder",
      name: "placeholder",
      driver: "impl",
      mode: "auto" as const,
      promptTemplate: "{{task}}",
      continueSession: false,
    };
    const mkWorkflow = (name: string) =>
      h.db.workflows.create({
        id: crypto.randomUUID(),
        projectId: h.projectId,
        name,
        steps: [placeholder],
      });
    const wf1 = mkWorkflow("w1");
    const wf2 = mkWorkflow("w2");
    const wf3 = mkWorkflow("w3");
    const wf4 = mkWorkflow("w4");
    const leaf = mkWorkflow("leaf");
    h.db.workflowRevisions.create(leaf.id, twoStepChildGraph());
    const rev4 = h.db.workflowRevisions.create(wf4.id, selfReferencing(wf1.id));
    h.db.workflowRevisions.create(wf3.id, selfReferencing(wf4.id));
    h.db.workflowRevisions.create(wf2.id, selfReferencing(wf3.id));
    const rev1 = h.db.workflowRevisions.create(wf1.id, selfReferencing(wf2.id));
    expect(rev1.number).toBe(1);
    expect(rev4.number).toBe(1);
    const run = h.enqueueRevisionRun(rev1.id);

    await h.engine.executeRun(run.id, noAbort);
    await awaitStatus(h, run.id, "failed");

    // Exactly four runs: the top plus children at depths 1..3 — the depth-4
    // spawn failed its node BEFORE creating a row.
    const all = h.db.runs.list();
    expect(all).toHaveLength(4);
    const deepest = all.find((row) => row.parentRunId !== undefined && row.workflowId === wf4.id);
    expect(deepest?.status).toBe("failed");
    expect(deepest?.error).toContain("sub-workflow nesting depth exceeds the maximum of 3");
    expect(h.db.runs.get(run.id)?.error).toContain("child run");
    expect(h.db.runs.get(run.id)?.error).toContain("nesting depth exceeds the maximum of 3");
  });

  it("aborting the parent mid-child aborts the child (shared abort chain)", async () => {
    const h = setup();
    const slow = createFakeDriver({
      id: "slow",
      events: [
        { type: "session", seq: 1, sessionId: "s-slow" },
        { type: "message-delta", seq: 2, delta: "working" },
      ],
      output: "SLOW-OUT",
      delayMs: 40,
    });
    h.registry.registerDriver(slow);
    const child = h.pinGraph(
      WorkflowGraphSchema.parse({
        entryNodeId: "c1",
        nodes: [agentNode("c1", "slow"), exitNode()],
        edges: [{ id: "e-c1exit", source: "c1", target: "exit", condition: { type: "always" } }],
      }),
    );
    const { revisionId } = h.pinGraph(parentGraph(child.workflow.id));
    const run = h.enqueueRevisionRun(revisionId);

    let abortRequested = false;
    let handleCount = 0;
    const control = {
      isAbortRequested: (): boolean => abortRequested,
      onHandle: (handle: AgentHandle | undefined): void => {
        if (handle === undefined) return;
        handleCount += 1;
        // 1st handle: the parent's entry node. 2nd: the CHILD's node —
        // abort the parent while the child is mid-flight.
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

    const childRun = h.db.runs.listByParentRun(run.id)[0] as Run;
    expect(childRun.status).toBe("aborted");
    expect(h.db.stepRuns.listByRun(childRun.id).find((row) => row.stepId === "c1")?.status).toBe(
      "aborted",
    );
    expect(h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "sub")?.status).toBe(
      "aborted",
    );
  });
});
