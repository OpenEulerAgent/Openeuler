import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeRetryEvent, Run, RunStatus, Workflow } from "@openeuler/core";
import { WorkflowGraphSchema } from "@openeuler/core";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import type { DriverRegistry, FakeDriver } from "@openeuler/drivers";
import { createFlowEngine } from "./flow-engine.js";
import type { ApprovalTimerFactory, FlowEngine, RunControl } from "./flow-engine.js";
import { WorktreeManager } from "./worktree.js";

/**
 * Node retry policy tests (#119): fake drivers against a temp database,
 * driven through the flow engine's real dispatch path. Backoff waits run
 * through an injected fake timer factory (no real sleeps) with jitter
 * pinned to 0, so the exponential timings are exactly assertable.
 */

interface Harness {
  dir: string;
  db: Db;
  engine: FlowEngine;
  worktrees: WorktreeManager;
  projectId: string;
  registry: DriverRegistry;
  /** The "flaky" driver the graph's node `a` talks to (test-scripted). */
  flaky: FakeDriver;
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

interface RetryTimerHandle {
  delayMs: number;
  fire(): void;
  cancelled: boolean;
}

/**
 * Fake retry-clock factory: records every scheduled wait and either fires
 * it on `setImmediate` (auto mode) or leaves it for the test to fire
 * (manual mode). Returned handles are inspectable for delay assertions.
 */
function fakeRetryClock(): {
  factory: ApprovalTimerFactory;
  timers: RetryTimerHandle[];
  /** Fires the oldest unfired, uncancelled timer (manual mode). */
  fireNext(): void;
} {
  const timers: RetryTimerHandle[] = [];
  return {
    timers,
    factory: (delayMs, fire) => {
      const timer: RetryTimerHandle = {
        delayMs,
        cancelled: false,
        fire: () => {
          if (timer.cancelled) return;
          timer.cancelled = true;
          fire();
        },
      };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
    fireNext: () => {
      // Between backoffs there may be nothing pending — the pump just retries.
      timers.find((candidate) => !candidate.cancelled)?.fire();
    },
  };
}

const setup = (
  options: {
    flaky?: FakeDriver;
    retryTimer?: ApprovalTimerFactory;
    retryJitter?: (backoffMs: number) => number;
  } = {},
): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-retry-"));
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

  const flaky =
    options.flaky ??
    createFakeDriver({
      id: "flaky",
      events: [{ type: "session", seq: 1, sessionId: "s-flaky" }],
      output: "FLAKY-OUT",
      // Scripted per-start exit codes — the whole point of the #119 driver seam.
      exitCodes: [1, 1, 0],
    });

  const registry = createDriverRegistry();
  registry.registerDriver(flaky);

  const worktrees = new WorktreeManager({ storeRoot: join(dir, "store") });
  const engine = createFlowEngine({
    db,
    worktrees,
    drivers: registry,
    ...(options.retryTimer === undefined ? {} : { retryTimer: options.retryTimer }),
    ...(options.retryJitter === undefined ? {} : { retryJitter: options.retryJitter }),
  });

  const placeholderStep = {
    id: "placeholder",
    name: "placeholder",
    driver: "flaky",
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
    flaky,
    pinGraph(graph) {
      const workflow = db.workflows.create({
        id: crypto.randomUUID(),
        projectId: project.id,
        name: "retry-flow",
        steps: [placeholderStep],
      });
      const revision = db.workflowRevisions.create(workflow.id, graph);
      return { workflow, revisionId: revision.id };
    },
    enqueueRevisionRun(revisionId, task = "fix the flaky thing") {
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

/** a → exit, where `a` carries the given retry policy + session mode. */
const retryGraph = (retry: unknown, continueSession = false): unknown =>
  WorkflowGraphSchema.parse({
    entryNodeId: "a",
    nodes: [
      {
        id: "a",
        type: "agent",
        name: "a",
        position: { x: 0, y: 0 },
        config: {
          driver: "flaky",
          mode: "auto",
          promptTemplate: "{{task}}",
          continueSession,
          ...(retry === undefined ? {} : { retry }),
        },
      },
      { id: "exit", type: "exit", name: "Exit", position: { x: 560, y: 0 } },
    ],
    edges: [{ id: "e-a-exit", source: "a", target: "exit", condition: { type: "always" } }],
  });

describe("node retry policies (#119)", () => {
  it("fails twice then succeeds: 3 attempts, ordered node.retry events, exponential backoff (jitter pinned 0)", async () => {
    const clock = fakeRetryClock();
    const h = setup({
      retryTimer: (delayMs, fire) => clock.factory(delayMs, fire),
      retryJitter: () => 0,
    });
    const { revisionId } = h.pinGraph(
      retryGraph({ maxAttempts: 3, backoffMs: 100, retryOn: "failure" }, true),
    );
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);
    // Auto-fire the recorded waits as they appear so the run completes.
    const pump = setInterval(() => clock.fireNext(), 5);
    try {
      const finished = await awaitStatus(h, run.id, "success");
      expect(finished.status).toBe("success");
    } finally {
      clearInterval(pump);
    }

    // 3 driver starts — attempts 1 and 2 failed (exit 1), attempt 3 won.
    expect(h.flaky.calls.length).toBe(3);
    // continueSession keeps the session the failed attempt announced.
    expect(h.flaky.calls[0]?.sessionId).toBeUndefined();
    expect(h.flaky.calls[1]?.sessionId).toBe("s-flaky");
    expect(h.flaky.calls[2]?.sessionId).toBe("s-flaky");

    // Ordered node.retry events with the exact exponential backoff.
    const retryEvents = h.db.events
      .getSince(run.id)
      .filter((event): event is NodeRetryEvent => event.type === "node.retry");
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0]).toMatchObject({ attempt: 1, nextInMs: 100 });
    expect(retryEvents[1]).toMatchObject({ attempt: 2, nextInMs: 200 });

    // The settled state carries the attempt count everywhere.
    const completed = h.db.events.getSince(run.id).find((event) => event.type === "node.completed");
    expect(completed).toMatchObject({ status: "success", attempt: 3 });
    const stepRun = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "a");
    expect(stepRun).toMatchObject({ status: "success", attempt: 3 });

    // Retries live INSIDE one execution: one node.started, one StepRun row,
    // and the outgoing edge traversed exactly once — iteration caps untouched.
    const types = h.db.events.getSince(run.id).map((event) => event.type);
    expect(types.filter((type) => type === "node.started")).toHaveLength(1);
    expect(types.filter((type) => type === "edge.taken")).toHaveLength(1);
    expect(h.db.stepRuns.listByRun(run.id).filter((row) => row.stepId === "a")).toHaveLength(1);
  });

  it("without continueSession, retried attempts start a fresh session", async () => {
    const clock = fakeRetryClock();
    const h = setup({
      retryTimer: (delayMs, fire) => clock.factory(delayMs, fire),
      retryJitter: () => 0,
    });
    const { revisionId } = h.pinGraph(
      retryGraph({ maxAttempts: 3, backoffMs: 10, retryOn: "failure" }, false),
    );
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);
    const pump = setInterval(() => clock.fireNext(), 5);
    try {
      await awaitStatus(h, run.id, "success");
    } finally {
      clearInterval(pump);
    }
    expect(h.flaky.calls.length).toBe(3);
    expect(h.flaky.calls[0]?.sessionId).toBeUndefined();
    expect(h.flaky.calls[1]?.sessionId).toBeUndefined();
    expect(h.flaky.calls[2]?.sessionId).toBeUndefined();
  });

  it("exhausted retries fail the run with attempt detail", async () => {
    const clock = fakeRetryClock();
    // Every start fails — the policy exhausts.
    const alwaysFails = createFakeDriver({ id: "flaky", events: [], output: "", exitCode: 1 });
    const h = setup({
      flaky: alwaysFails,
      retryTimer: (delayMs, fire) => clock.factory(delayMs, fire),
      retryJitter: () => 0,
    });
    const { revisionId } = h.pinGraph(
      retryGraph({ maxAttempts: 3, backoffMs: 10, retryOn: "failure" }),
    );
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);
    const pump = setInterval(() => clock.fireNext(), 5);
    try {
      const finished = await awaitStatus(h, run.id, "failed");
      expect(finished.status).toBe("failed");
    } finally {
      clearInterval(pump);
    }

    expect(alwaysFails.calls.length).toBe(3);
    const completed = h.db.events.getSince(run.id).find((event) => event.type === "node.completed");
    expect(completed).toMatchObject({ status: "failed", attempt: 3 });
    expect(completed?.error).toContain("(attempt 3/3)");
    const stepRun = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "a");
    expect(stepRun).toMatchObject({ status: "failed", attempt: 3 });
    const retryEvents = h.db.events
      .getSince(run.id)
      .filter((event): event is NodeRetryEvent => event.type === "node.retry");
    expect(retryEvents.map((event) => event.attempt)).toEqual([1, 2]);
  });

  it("retryOn 'always' re-executes even successful attempts", async () => {
    const clock = fakeRetryClock();
    // Both starts succeed — 'always' still takes the second attempt.
    const ok = createFakeDriver({ id: "flaky", events: [], output: "OK", exitCode: 0 });
    const h = setup({
      flaky: ok,
      retryTimer: (delayMs, fire) => clock.factory(delayMs, fire),
      retryJitter: () => 0,
    });
    const { revisionId } = h.pinGraph(
      retryGraph({ maxAttempts: 2, backoffMs: 10, retryOn: "always" }),
    );
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);
    const pump = setInterval(() => clock.fireNext(), 5);
    try {
      await awaitStatus(h, run.id, "success");
    } finally {
      clearInterval(pump);
    }
    expect(ok.calls.length).toBe(2);
    const retryEvents = h.db.events
      .getSince(run.id)
      .filter((event): event is NodeRetryEvent => event.type === "node.retry");
    expect(retryEvents).toHaveLength(1);
    // No failure → no error field on the retry event.
    expect(retryEvents[0]?.error).toBeUndefined();
    const completed = h.db.events.getSince(run.id).find((event) => event.type === "node.completed");
    expect(completed).toMatchObject({ status: "success", attempt: 2 });
  });

  it("without a retry policy a failed node is a single attempt (previous behavior)", async () => {
    const fails = createFakeDriver({ id: "flaky", events: [], output: "", exitCode: 1 });
    const h = setup({ flaky: fails });
    const { revisionId } = h.pinGraph(retryGraph(undefined));
    const run = h.enqueueRevisionRun(revisionId);
    void startRun(h, run.id, makeControl().control);
    await awaitStatus(h, run.id, "failed");
    expect(fails.calls.length).toBe(1);
    expect(h.db.events.getSince(run.id).filter((event) => event.type === "node.retry")).toEqual([]);
    const stepRun = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "a");
    expect(stepRun && "attempt" in stepRun ? stepRun.attempt : undefined).toBeUndefined();
  });

  it("abort during the backoff settles the node and run aborted, no further attempts", async () => {
    const clock = fakeRetryClock();
    const fails = createFakeDriver({ id: "flaky", events: [], output: "", exitCode: 1 });
    const h = setup({
      flaky: fails,
      retryTimer: (delayMs, fire) => clock.factory(delayMs, fire),
      retryJitter: () => 0,
    });
    const { revisionId } = h.pinGraph(
      retryGraph({ maxAttempts: 5, backoffMs: 60_000, retryOn: "failure" }),
    );
    const run = h.enqueueRevisionRun(revisionId);
    const { control, abort } = makeControl();
    void startRun(h, run.id, control);

    // Wait for the first backoff wait, then abort mid-wait and fire.
    const deadline = Date.now() + 5_000;
    while (clock.timers.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(clock.timers[0]?.delayMs).toBe(60_000);
    abort();
    clock.fireNext();

    const finished = await awaitStatus(h, run.id, "aborted");
    expect(finished.status).toBe("aborted");
    expect(fails.calls.length).toBe(1);
    const stepRun = h.db.stepRuns.listByRun(run.id).find((row) => row.stepId === "a");
    expect(stepRun?.status).toBe("aborted");
  });
});
