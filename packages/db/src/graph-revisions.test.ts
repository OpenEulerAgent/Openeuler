import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linearToGraph } from "@openeuler/core";
import type { Step, Workflow } from "@openeuler/core";
import { createDatabase, migrateLinearWorkflowsToGraphs } from "./index.js";
import type { Db } from "./index.js";

const iso = (): string => new Date().toISOString();

const makeSteps = (count: number): Step[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `s${index + 1}`,
    name: `step-${index + 1}`,
    driver: "opencode",
    mode: "auto",
    promptTemplate: index === 0 ? "{{task}}" : "prev: {{prevOutput}}",
    continueSession: index > 0,
  }));

const makeWorkflow = (db: Db, projectId: string, over: Partial<Workflow> = {}): Workflow =>
  db.workflows.create({
    id: crypto.randomUUID(),
    projectId,
    name: "graph-flow",
    steps: makeSteps(3),
    ...over,
  });

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openeuler-db-graph-"));
  db = createDatabase({ path: join(dir, "test.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("workflowRevisions repo", () => {
  const setupProject = (): string => {
    const id = crypto.randomUUID();
    db.projects.create({
      id,
      path: "/srv/repos/demo",
      name: "demo",
      defaultBranch: "main",
      createdAt: iso(),
    });
    return id;
  };

  it("creates per-workflow numbered revisions and bumps latestRevisionNumber", () => {
    const projectId = setupProject();
    const workflow = makeWorkflow(db, projectId);
    expect(workflow.latestRevisionNumber).toBeUndefined();

    const r1 = db.workflowRevisions.create(workflow.id, linearToGraph({ steps: makeSteps(2) }));
    expect(r1).toMatchObject({ workflowId: workflow.id, number: 1 });
    expect(db.workflows.get(workflow.id)?.latestRevisionNumber).toBe(1);

    const r2 = db.workflowRevisions.create(workflow.id, linearToGraph({ steps: makeSteps(3) }));
    const r3 = db.workflowRevisions.create(workflow.id, linearToGraph({ steps: makeSteps(1) }));
    expect([r1.number, r2.number, r3.number]).toEqual([1, 2, 3]);
    expect(db.workflows.get(workflow.id)?.latestRevisionNumber).toBe(3);

    // Numbers are per-workflow: a second workflow restarts at 1.
    const other = makeWorkflow(db, projectId, { name: "other" });
    expect(
      db.workflowRevisions.create(other.id, linearToGraph({ steps: makeSteps(1) })).number,
    ).toBe(1);
    expect(db.workflows.get(other.id)?.latestRevisionNumber).toBe(1);
  });

  it("get / getByNumber / list / latest", () => {
    const projectId = setupProject();
    const workflow = makeWorkflow(db, projectId);
    const r1 = db.workflowRevisions.create(workflow.id, linearToGraph({ steps: makeSteps(2) }));
    const r2 = db.workflowRevisions.create(workflow.id, linearToGraph({ steps: makeSteps(3) }));

    expect(db.workflowRevisions.get(r1.id)?.graph.nodes).toHaveLength(3); // 2 steps + exit
    expect(db.workflowRevisions.getByNumber(workflow.id, 2)?.id).toBe(r2.id);
    expect(db.workflowRevisions.getByNumber(workflow.id, 9)).toBeUndefined();
    expect(db.workflowRevisions.list(workflow.id).map((r) => r.number)).toEqual([1, 2]);
    expect(db.workflowRevisions.latest(workflow.id)?.id).toBe(r2.id);
    expect(db.workflowRevisions.latest(crypto.randomUUID())).toBeUndefined();
  });

  it("validates the graph at save time (invalid graph throws)", () => {
    const projectId = setupProject();
    const workflow = makeWorkflow(db, projectId);
    expect(() =>
      db.workflowRevisions.create(workflow.id, {
        entryNodeId: "ghost",
        nodes: [],
        edges: [],
      }),
    ).toThrowError();
    // Nothing was written: still no revision, no bump.
    expect(db.workflowRevisions.list(workflow.id)).toEqual([]);
    expect(db.workflows.get(workflow.id)?.latestRevisionNumber).toBeUndefined();
  });

  it("stores the graph snapshot immutably across later edits", () => {
    const projectId = setupProject();
    const workflow = makeWorkflow(db, projectId);
    const r1 = db.workflowRevisions.create(workflow.id, linearToGraph({ steps: makeSteps(2) }));
    db.workflowRevisions.create(workflow.id, linearToGraph({ steps: makeSteps(3) }));
    // The first snapshot is unchanged by the later save.
    expect(db.workflowRevisions.get(r1.id)?.graph.nodes).toHaveLength(3);
  });
});

describe("migrateLinearWorkflowsToGraphs", () => {
  const setupProject = (): string => {
    const id = crypto.randomUUID();
    db.projects.create({
      id,
      path: "/srv/repos/demo",
      name: "demo",
      defaultBranch: "main",
      createdAt: iso(),
    });
    return id;
  };

  it("snapshots legacy workflows as revision 1 and is idempotent", () => {
    const projectId = setupProject();
    const looped = makeWorkflow(db, projectId, {
      name: "looped",
      loopBack: {
        toStepIndex: 1,
        when: { type: "outputNotContains", pattern: "LGTM" },
        maxIterations: 5,
      },
    });
    const plain = makeWorkflow(db, projectId, { name: "plain" });

    const first = migrateLinearWorkflowsToGraphs(db);
    expect(first.migrated.sort()).toEqual([looped.id, plain.id].sort());
    expect(first.skipped).toEqual([]);

    const loopedRevision = db.workflowRevisions.latest(looped.id);
    expect(loopedRevision?.number).toBe(1);
    // Loop edge carries the inverted condition and the loop's cap.
    const loopEdge = loopedRevision?.graph.edges.find(
      (edge) => edge.source === "s3" && edge.target === "s2",
    );
    expect(loopEdge).toMatchObject({
      condition: { type: "outputContains", pattern: "LGTM" },
      maxIterations: 5,
    });
    expect(db.workflows.get(plain.id)?.latestRevisionNumber).toBe(1);

    // Second boot: everything skipped, nothing new written.
    const second = migrateLinearWorkflowsToGraphs(db);
    expect(second).toEqual({
      migrated: [],
      skipped: expect.arrayContaining([looped.id, plain.id]),
    });
    expect(db.workflowRevisions.list(looped.id)).toHaveLength(1);
    // A workflow saved via the graph API afterwards is untouched too.
    db.workflowRevisions.create(looped.id, linearToGraph({ steps: makeSteps(2) }));
    const third = migrateLinearWorkflowsToGraphs(db);
    expect(third.migrated).toEqual([]);
    expect(db.workflowRevisions.list(looped.id)).toHaveLength(2);
  });
});
