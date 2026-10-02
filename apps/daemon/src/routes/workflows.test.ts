import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphSummary, Run, Step, Workflow } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import { createExecutor } from "../executor.js";
import { createLogger } from "../logger.js";

interface ApiHarness {
  dir: string;
  db: Db;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
  makeSteps(...drivers: string[]): Step[];
}

interface ErrorResponseBody {
  error: { code: string; message: string };
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const created: { db: Db; dir: string }[] = [];

const setup = (): ApiHarness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-workflows-"));
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
  drivers.registerDriver(
    createFakeDriver({
      id: "first",
      events: [{ type: "session", seq: 1, sessionId: "s-first" }],
      output: "FIRST-OUT",
    }),
  );
  drivers.registerDriver(
    createFakeDriver({
      id: "second",
      events: [{ type: "session", seq: 1, sessionId: "s-second" }],
      output: "SECOND-OUT",
    }),
  );
  drivers.registerDriver(
    createFakeDriver({
      id: "cycler",
      events: [{ type: "session", seq: 1, sessionId: "s-cycle" }],
      outputs: ["WIP", "WIP", "ALL TESTS PASS"],
    }),
  );
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
    request: (path, init) => Promise.resolve(app.request(path, init)),
    projectId: project.id,
    makeSteps(...driverIds) {
      return driverIds.map((driver, index) => ({
        id: `s${index + 1}`,
        name: `step-${index + 1}`,
        driver,
        mode: "auto" as const,
        promptTemplate: index === 0 ? "{{task}}" : "prev: {{prevOutput}}",
        continueSession: index > 0,
      }));
    },
  };
};

afterEach(() => {
  while (created.length > 0) {
    const item = created.pop() as { db: Db; dir: string };
    item.db.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

const postWorkflow = (h: ApiHarness, body: Record<string, unknown>): Promise<Response> =>
  h.request("/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createWorkflow = async (h: ApiHarness, body: Record<string, unknown>): Promise<Workflow> => {
  const res = await postWorkflow(h, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { workflow: Workflow }).workflow;
};

const awaitRunStatus = async (h: ApiHarness, runId: string, want: Run["status"]): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = h.db.runs.get(runId);
    if (run?.status === want) return;
    if (Date.now() > deadline) throw new Error(`run never reached ${want}; at ${run?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("POST /api/workflows", () => {
  it("creates a workflow (201) and round-trips it via GET", async () => {
    const h = setup();
    const steps = h.makeSteps("first", "second");
    const res = await postWorkflow(h, { projectId: h.projectId, name: "ship-it", steps });
    expect(res.status).toBe(201);
    const { workflow } = (await res.json()) as { workflow: Workflow };
    expect(workflow).toMatchObject({
      id: expect.any(String),
      projectId: h.projectId,
      name: "ship-it",
    });
    expect(workflow.steps).toEqual(steps);

    const got = await h.request(`/api/workflows/${workflow.id}`);
    expect(got.status).toBe(200);
    expect(((await got.json()) as { workflow: Workflow }).workflow).toEqual(workflow);

    const list = await h.request(`/api/workflows?projectId=${h.projectId}`);
    expect(
      ((await await list.json()) as { workflows: Workflow[] }).workflows.map((w) => w.id),
    ).toEqual([workflow.id]);
  });

  it("422s on invalid step config from zod", async () => {
    const h = setup();
    const cases: Array<Record<string, unknown>> = [
      {},
      { projectId: h.projectId },
      { projectId: h.projectId, name: "", steps: h.makeSteps("first") },
      { projectId: h.projectId, name: "x", steps: [] },
      {
        projectId: h.projectId,
        name: "x",
        steps: [
          {
            id: "s1",
            name: "bad mode",
            driver: "first",
            mode: "yolo",
            promptTemplate: "{{task}}",
            continueSession: false,
          },
        ],
      },
      {
        projectId: h.projectId,
        name: "x",
        steps: [
          {
            id: "s1",
            name: "no template",
            driver: "first",
            mode: "auto",
            promptTemplate: "",
            continueSession: false,
          },
        ],
      },
      {
        projectId: h.projectId,
        name: "x",
        steps: [
          {
            id: "s1",
            name: "extra key",
            driver: "first",
            mode: "auto",
            promptTemplate: "{{task}}",
            continueSession: false,
            surprise: 1,
          },
        ],
      },
      {
        projectId: h.projectId,
        name: "x",
        steps: h.makeSteps("first"),
        loopBack: { toStepIndex: -1 },
      },
    ];
    for (const body of cases) {
      const res = await postWorkflow(h, body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorResponseBody).error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("422s when loopBack.toStepIndex is out of bounds or the outputMatches regex is invalid", async () => {
    const h = setup();
    const steps = h.makeSteps("first", "second");
    const cases: Array<{ body: Record<string, unknown>; message: string }> = [
      // Cross-field: 2 steps, index 2 does not exist.
      {
        body: {
          projectId: h.projectId,
          name: "x",
          steps,
          loopBack: { toStepIndex: 2, when: { type: "always" }, maxIterations: 2 },
        },
        message: "loopBack.toStepIndex must be < steps.length",
      },
      // Invalid regex must be rejected at save time, never at runtime.
      {
        body: {
          projectId: h.projectId,
          name: "x",
          steps,
          loopBack: {
            toStepIndex: 0,
            when: { type: "outputMatches", regex: "([a-z" },
            maxIterations: 2,
          },
        },
        message: "invalid regular expression",
      },
    ];
    for (const { body, message } of cases) {
      const res = await postWorkflow(h, body);
      expect(res.status).toBe(422);
      const error = ((await res.json()) as ErrorResponseBody).error;
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.message).toContain(message);
    }

    // PATCH is covered too, on the merged workflow (steps + loopBack).
    const workflow = await createWorkflow(h, { projectId: h.projectId, name: "y", steps });
    const patched = await h.request(`/api/workflows/${workflow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopBack: { toStepIndex: 5, when: { type: "always" }, maxIterations: 2 },
      }),
    });
    expect(patched.status).toBe(422);
    const patchError = ((await patched.json()) as ErrorResponseBody).error;
    expect(patchError.code).toBe("VALIDATION_ERROR");
    expect(patchError.message).toContain("loopBack.toStepIndex must be < steps.length");
  });

  it("404s for an unknown project", async () => {
    const h = setup();
    const res = await postWorkflow(h, {
      projectId: crypto.randomUUID(),
      name: "x",
      steps: h.makeSteps("first"),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("GET /api/workflows", () => {
  it("lists workflows filtered by projectId; 404s unknown ids", async () => {
    const h = setup();
    const other = h.db.projects.create({
      id: crypto.randomUUID(),
      path: join(h.dir, "repo"),
      name: "repo-2",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    const mine = (
      (await (
        await postWorkflow(h, { projectId: h.projectId, name: "mine", steps: h.makeSteps("first") })
      ).json()) as { workflow: Workflow }
    ).workflow;
    await postWorkflow(h, { projectId: other.id, name: "theirs", steps: h.makeSteps("second") });

    const scoped = (await (await h.request(`/api/workflows?projectId=${h.projectId}`)).json()) as {
      workflows: Workflow[];
    };
    expect(scoped.workflows.map((w) => w.id)).toEqual([mine.id]);

    const all = (await (await h.request("/api/workflows")).json()) as { workflows: Workflow[] };
    expect(all.workflows).toHaveLength(2);

    const missing = await h.request(`/api/workflows/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorResponseBody).error.code).toBe("WORKFLOW_NOT_FOUND");
  });
});

describe("PATCH /api/workflows/:id", () => {
  it("patches name, steps and loopBack (null clears)", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "v1",
      steps: h.makeSteps("first"),
    });

    const renamed = await h.request(`/api/workflows/${workflow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "v2" }),
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { workflow: Workflow }).workflow.name).toBe("v2");

    const withLoop = await h.request(`/api/workflows/${workflow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        steps: h.makeSteps("first", "second"),
        loopBack: { toStepIndex: 0, when: { type: "always" }, maxIterations: 2 },
      }),
    });
    expect(withLoop.status).toBe(200);
    const patched = ((await withLoop.json()) as { workflow: Workflow }).workflow;
    expect(patched.steps).toHaveLength(2);
    expect(patched.loopBack).toEqual({
      toStepIndex: 0,
      when: { type: "always" },
      maxIterations: 2,
    });

    const cleared = await h.request(`/api/workflows/${workflow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loopBack: null }),
    });
    expect(((await cleared.json()) as { workflow: Workflow }).workflow.loopBack).toBeUndefined();
  });

  it("422s on invalid patches and 404s unknown ids", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "x",
      steps: h.makeSteps("first"),
    });

    const bad = await h.request(`/api/workflows/${workflow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps: [{ id: "s1", name: "no driver" }] }),
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as ErrorResponseBody).error.code).toBe("VALIDATION_ERROR");

    const missing = await h.request(`/api/workflows/${crypto.randomUUID()}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "y" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("DELETE /api/workflows/:id", () => {
  it("deletes an unused workflow (204) and 404s afterwards", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "x",
      steps: h.makeSteps("first"),
    });

    const res = await h.request(`/api/workflows/${workflow.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await h.request(`/api/workflows/${workflow.id}`)).status).toBe(404);
    expect((await h.request(`/api/workflows/${workflow.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("409s while runs reference the workflow", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "x",
      steps: h.makeSteps("first"),
    });
    const run = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "go" }),
    });
    expect(run.status).toBe(202);

    const res = await h.request(`/api/workflows/${workflow.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("WORKFLOW_IN_USE");
  });
});

describe("POST /api/workflows/:id/runs", () => {
  it("202s a queued workflow run that succeeds with ordered engine + driver events", async () => {
    const h = setup();
    const steps = h.makeSteps("first", "second");
    const workflow = await createWorkflow(h, { projectId: h.projectId, name: "two-step", steps });

    const res = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "do the thing" }),
    });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as { run: Run };
    expect(run).toMatchObject({
      id: expect.any(String),
      projectId: h.projectId,
      workflowId: workflow.id,
      status: "queued",
      branch: `agentloop/${run.id}`,
      iteration: 0,
      task: "do the thing",
    });

    await awaitRunStatus(h, run.id, "success");
    expect(h.db.runs.get(run.id)).toMatchObject({ status: "success", output: "SECOND-OUT" });

    // Ordered log: run.status wraps node.queued/node.started / driver
    // events / node.completed + edge.taken (API runs pin the latest graph
    // revision, so they execute on the graph engine, #45).
    const events = h.db.events.getSince(run.id);
    expect(
      events.map((event) => `${event.type}${"status" in event ? `:${event.status}` : ""}`),
    ).toEqual([
      "run.status:running",
      "node.queued",
      "node.started",
      "started",
      "session",
      "node.completed:success",
      "edge.taken",
      "node.queued",
      "node.started",
      "started",
      "session",
      "node.completed:success",
      "edge.taken",
      "run.status:success",
    ]);

    // GET /api/runs/:id returns step runs grouped by iteration, in workflow order.
    const detail = (await (await h.request(`/api/runs/${run.id}`)).json()) as {
      run: Run;
      steps: Array<{ stepId: string; status: string; sessionId?: string }>;
      iterations: Array<{ iteration: number; steps: Array<{ stepId: string; status: string }> }>;
    };
    expect(detail.steps.map((step) => step.stepId)).toEqual(["s1", "s2"]);
    expect(detail.steps.map((step) => step.sessionId)).toEqual(["s-first", "s-second"]);
    expect(detail.iterations.map((group) => group.iteration)).toEqual([1]);
    expect(detail.iterations[0]?.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["s1", "success"],
      ["s2", "success"],
    ]);
  });

  it("422s on an empty task and 404s for an unknown workflow", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "x",
      steps: h.makeSteps("first"),
    });

    const bad = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "" }),
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as ErrorResponseBody).error.code).toBe("VALIDATION_ERROR");

    const missing = await h.request(`/api/workflows/${crypto.randomUUID()}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "go" }),
    });
    expect(missing.status).toBe(404);
  });

  it("loops a workflow run until the exit condition is met, with edge.taken routing events", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "until-green",
      steps: [
        {
          id: "s1",
          name: "implement",
          driver: "cycler",
          mode: "auto",
          promptTemplate: "{{task}} (pass {{iterations}})",
          continueSession: false,
        },
      ],
      loopBack: {
        toStepIndex: 0,
        when: { type: "outputContains", pattern: "ALL TESTS PASS" },
        maxIterations: 5,
      },
    });

    const res = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "get to green" }),
    });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as { run: Run };

    await awaitRunStatus(h, run.id, "success");
    expect(h.db.runs.get(run.id)).toMatchObject({
      status: "success",
      output: "ALL TESTS PASS",
      iteration: 2,
    });

    // The graph engine routes with edge.taken events (no loop.iteration on
    // graph runs): the loop edge twice, then the always exit edge.
    const taken = h.db.events
      .getSince(run.id)
      .filter((event) => event.type === "edge.taken")
      .map((event) => (event.type === "edge.taken" ? event.edgeId : ""));
    expect(taken).toEqual(["e-loop-s1-s1", "e-loop-s1-s1", "e-exit-s1"]);
    expect(h.db.events.getSince(run.id).filter((event) => event.type === "loop.iteration")).toEqual(
      [],
    );

    // Step runs: one per iteration, grouped in the run detail payload.
    const detail = (await (await h.request(`/api/runs/${run.id}`)).json()) as {
      iterations: Array<{ iteration: number; steps: Array<{ stepId: string; status: string }> }>;
    };
    expect(detail.iterations.map((group) => group.iteration)).toEqual([1, 2, 3]);
  });
});

describe("graph revisions (PUT /:id/graph, GET /:id/revisions)", () => {
  const makeGraph = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    entryNodeId: "n1",
    nodes: [
      {
        id: "n1",
        type: "agent",
        name: "implement",
        position: { x: 0, y: 0 },
        config: {
          driver: "first",
          mode: "auto",
          promptTemplate: "{{task}}",
          continueSession: false,
        },
      },
      {
        id: "n2",
        type: "agent",
        name: "review",
        position: { x: 280, y: 0 },
        config: {
          driver: "second",
          mode: "auto",
          promptTemplate: "review: {{prevOutput}}",
          continueSession: true,
        },
      },
      { id: "exit", type: "exit", name: "Exit", position: { x: 560, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "exit" },
    ],
    ...over,
  });

  const putGraph = (h: ApiHarness, id: string, graph: unknown): Promise<Response> =>
    h.request(`/api/workflows/${id}/graph`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph }),
    });

  it("creates a workflow from a graph (revision 1) and mirrors steps", async () => {
    const h = setup();
    const res = await postWorkflow(h, {
      projectId: h.projectId,
      name: "canvas",
      graph: makeGraph(),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workflow: Workflow & {
        latestRevision?: { id: string; number: number };
        graph?: { entryNodeId: string; nodes: unknown[] };
        graphSummary?: GraphSummary;
      };
      revision: { id: string; number: number };
    };
    expect(body.revision).toEqual({ id: expect.any(String), number: 1 });
    expect(body.workflow.latestRevision).toEqual(body.revision);
    expect(body.workflow.graph?.entryNodeId).toBe("n1");
    // The legacy steps mirror round-trips the chain.
    expect(body.workflow.steps.map((step) => step.id)).toEqual(["n1", "n2"]);
    // The summary describes revision 1 (a plain chain: no loop, no router).
    expect(body.workflow.graphSummary).toEqual({
      nodeCount: 3,
      edgeCount: 2,
      hasLoop: false,
      hasRouter: false,
      revision: 1,
    });

    // GET detail carries the same latest revision + graph.
    const got = (await (await h.request(`/api/workflows/${body.workflow.id}`)).json()) as {
      workflow: typeof body.workflow;
    };
    expect(got.workflow.latestRevision).toEqual(body.revision);
    expect(got.workflow.graph?.nodes).toHaveLength(3);
  });

  it("accepts {{output:<nodeId>}} graphs; the steps mirror degrades to the entry node", async () => {
    const h = setup();
    const graph = makeGraph();
    const nodes = graph["nodes"] as Array<Record<string, unknown>>;
    const review = nodes[1]?.["config"] as Record<string, unknown>;
    review["promptTemplate"] = "review: {{output:n1}}";
    const res = await postWorkflow(h, { projectId: h.projectId, name: "outputs", graph });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workflow: Workflow; revision: { number: number } };
    expect(body.revision.number).toBe(1);
    // Round the graph itself: the snapshot keeps the {{output:n1}} template.
    expect(
      h.db.workflowRevisions.latest(body.workflow.id)?.graph.nodes.find((node) => node.id === "n2"),
    ).toMatchObject({ config: { promptTemplate: "review: {{output:n1}}" } });
    // Not round-trippable → placeholder mirror (entry node only).
    expect(body.workflow.steps.map((step) => step.id)).toEqual(["n1"]);
  });

  it("saves graphs as new revisions (1→2→3) with 422 node/edge-attributed details", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "v1",
      steps: h.makeSteps("first"),
    });
    expect(h.db.workflows.get(workflow.id)?.latestRevisionNumber).toBe(1);

    const save1 = await putGraph(h, workflow.id, makeGraph());
    expect(save1.status).toBe(200);
    const save1Body = (await save1.json()) as {
      revision: { number: number };
      workflow: Workflow;
    };
    expect(save1Body.revision.number).toBe(2);
    expect(save1Body.workflow.latestRevisionNumber).toBe(2);

    // A second, different save creates revision 3.
    const renamed = makeGraph();
    const nodes = renamed["nodes"] as Array<Record<string, unknown>>;
    for (const node of nodes) {
      if (typeof node["name"] === "string") node["name"] = `${node["name"]}-v2`;
    }
    const save2 = await putGraph(h, workflow.id, renamed);
    expect(((await save2.json()) as { revision: { number: number } }).revision.number).toBe(3);

    // Validation failures carry node/edge-attributed paths.
    const bad = await putGraph(h, workflow.id, {
      entryNodeId: "n1",
      nodes: [
        {
          id: "n1",
          type: "agent",
          name: "one",
          position: { x: 0, y: 0 },
          config: {
            driver: "first",
            mode: "auto",
            promptTemplate: "{{task}}",
            continueSession: false,
          },
        },
        {
          id: "n2",
          type: "agent",
          name: "two",
          position: { x: 280, y: 0 },
          config: {
            driver: "second",
            mode: "auto",
            promptTemplate: "review: {{output:ghost}}",
            continueSession: true,
          },
        },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n1" },
      ],
    });
    expect(bad.status).toBe(422);
    const error = (
      (await bad.json()) as {
        error: { code: string; details: Array<{ path: string; message: string }> };
      }
    ).error;
    expect(error.code).toBe("VALIDATION_ERROR");
    const cycle = error.details?.find((detail) => detail.message.includes("unconditional cycle"));
    expect(cycle?.path).toContain("edges");
    const nonUpstream = error.details?.find((detail) => detail.path.includes("promptTemplate"));
    expect(nonUpstream?.message).toContain("not an upstream node");

    const missing = await h.request(`/api/workflows/${crypto.randomUUID()}/graph`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph: makeGraph() }),
    });
    expect(missing.status).toBe(404);
  });

  it("guards concurrent saves via expectedRevision (#76)", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "conflict",
      steps: h.makeSteps("first"),
    });
    expect(h.db.workflows.get(workflow.id)?.latestRevisionNumber).toBe(1);

    const put = (body: Record<string, unknown>): Promise<Response> =>
      h.request(`/api/workflows/${workflow.id}/graph`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // Correct expectation: the save proceeds and mints the next revision.
    const ok = await put({ graph: makeGraph(), expectedRevision: 1 });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { revision: { number: number } };
    expect(okBody.revision.number).toBe(2);

    // Stale expectation: 409 REVISION_CONFLICT naming the current revision,
    // and NO new revision is minted by the refused save.
    const stale = await put({ graph: makeGraph(), expectedRevision: 1 });
    expect(stale.status).toBe(409);
    const conflictBody = (await stale.json()) as {
      error: { code: string; message: string; details: { currentRevision: number } };
    };
    expect(conflictBody.error.code).toBe("REVISION_CONFLICT");
    expect(conflictBody.error.message).toContain("revision 2");
    expect(conflictBody.error.details.currentRevision).toBe(2);
    expect(h.db.workflows.get(workflow.id)?.latestRevisionNumber).toBe(2);

    // Absent param: current behavior — no check, plain last-writer-wins.
    const plain = await put({ graph: makeGraph() });
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as { revision: { number: number } }).revision.number).toBe(3);

    // Invalid values are schema-level 422s, never conflict checks.
    const stringy = await put({ graph: makeGraph(), expectedRevision: "3" });
    expect(stringy.status).toBe(422);
    expect(((await stringy.json()) as ErrorResponseBody).error.code).toBe("VALIDATION_ERROR");
    const negative = await put({ graph: makeGraph(), expectedRevision: -1 });
    expect(negative.status).toBe(422);
    expect(((await negative.json()) as ErrorResponseBody).error.code).toBe("VALIDATION_ERROR");
    expect(h.db.workflows.get(workflow.id)?.latestRevisionNumber).toBe(3);
  });

  it("lists revisions without graph blobs and serves full snapshots", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "hist",
      steps: h.makeSteps("first"),
    });
    await putGraph(h, workflow.id, makeGraph());

    const list = (await (await h.request(`/api/workflows/${workflow.id}/revisions`)).json()) as {
      revisions: Array<{ id: string; number: number; createdAt: string }>;
    };
    expect(list.revisions.map((r) => r.number)).toEqual([1, 2]);
    expect(list.revisions[0]?.createdAt).toEqual(expect.any(String));
    expect(JSON.stringify(list)).not.toContain("promptTemplate");

    const snapshot = (await (
      await h.request(`/api/workflows/${workflow.id}/revisions/2`)
    ).json()) as { revision: { number: number; graph: { nodes: unknown[] } } };
    expect(snapshot.revision.number).toBe(2);
    expect(snapshot.revision.graph.nodes).toHaveLength(3);

    expect((await h.request(`/api/workflows/${workflow.id}/revisions/9`)).status).toBe(404);
    expect((await h.request(`/api/workflows/${workflow.id}/revisions/0`)).status).toBe(422);
  });

  // #70: the list/detail payloads summarize the LATEST revision snapshot,
  // never the legacy steps mirror (which goes stale for branchy graphs).
  const listedWorkflow = async (
    h: ApiHarness,
    workflowId: string,
  ): Promise<Workflow & { graphSummary?: GraphSummary }> => {
    const body = (await (await h.request(`/api/workflows?projectId=${h.projectId}`)).json()) as {
      workflows: Array<Workflow & { graphSummary?: GraphSummary }>;
    };
    const listed = body.workflows.find((w) => w.id === workflowId);
    expect(listed).toBeDefined();
    return listed as Workflow & { graphSummary?: GraphSummary };
  };

  it("summarizes the current graph shape + revision on list and detail (#70)", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "v1",
      steps: h.makeSteps("first"),
    });

    // Branchy save (the #70 audit-probe scenario): router at n1 (conditional
    // review edge + always exit) and a conditional back-edge n2→n1. The
    // legacy mirror cannot represent it, so the steps stay stale — but the
    // list must show the saved shape.
    const branchy = makeGraph({
      edges: [
        {
          id: "e-review",
          source: "n1",
          target: "n2",
          condition: { type: "outputContains", pattern: "GO" },
        },
        { id: "e-exit", source: "n1", target: "exit" },
        {
          id: "e-loop",
          source: "n2",
          target: "n1",
          condition: { type: "outputNotContains", pattern: "DONE" },
        },
      ],
    });
    const save = await putGraph(h, workflow.id, branchy);
    expect(save.status).toBe(200);
    expect(((await save.json()) as { revision: { number: number } }).revision.number).toBe(2);
    // Stale mirror confirmed: still the single creation step.
    expect(h.db.workflows.get(workflow.id)?.steps).toHaveLength(1);

    const listed = await listedWorkflow(h, workflow.id);
    expect(listed.graphSummary).toEqual({
      nodeCount: 3,
      edgeCount: 3,
      hasLoop: true,
      hasRouter: true,
      revision: 2,
    });

    // Detail carries the same summary alongside the full graph.
    const detail = (await (await h.request(`/api/workflows/${workflow.id}`)).json()) as {
      workflow: Workflow & { graphSummary?: GraphSummary };
    };
    expect(detail.workflow.graphSummary).toEqual(listed.graphSummary);

    // Revision increments per save and the summary tracks the latest shape:
    // a plain linear graph has neither loop nor router.
    const resave = await putGraph(h, workflow.id, makeGraph());
    expect(((await resave.json()) as { revision: { number: number } }).revision.number).toBe(3);
    const relisted = await listedWorkflow(h, workflow.id);
    expect(relisted.graphSummary).toEqual({
      nodeCount: 3,
      edgeCount: 2,
      hasLoop: false,
      hasRouter: false,
      revision: 3,
    });
  });

  it("omits graphSummary for legacy workflows that have no revisions (#70)", async () => {
    const h = setup();
    // A pre-graph row written directly (as before revisions existed): the
    // list keeps the steps-based display, with no summary key at all.
    const legacy = h.db.workflows.create({
      id: crypto.randomUUID(),
      projectId: h.projectId,
      name: "ancient",
      steps: h.makeSteps("first", "second"),
    });
    const listed = await listedWorkflow(h, legacy.id);
    expect("graphSummary" in listed).toBe(false);
    expect(listed.steps).toHaveLength(2);
  });
});

describe("revision pinning on runs", () => {
  it("pins each run to the revision latest at creation; later saves never mutate it", async () => {
    const h = setup();
    const workflow = await createWorkflow(h, {
      projectId: h.projectId,
      name: "pinned",
      steps: h.makeSteps("first", "second"),
    });

    const runBefore = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "before the edit" }),
    });
    expect(runBefore.status).toBe(202);
    const runBeforeBody = (await runBefore.json()) as {
      run: Run & { workflowRevision: { id: string; number: number } };
    };
    expect(runBeforeBody.run.workflowRevision).toMatchObject({ number: 1 });
    const pinnedId = runBeforeBody.run.workflowRevision.id;

    // Save a different graph: revision 2 becomes latest, the old snapshot is
    // untouched and the run created before still resolves revision 1.
    const saved = await h.request(`/api/workflows/${workflow.id}/graph`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        graph: {
          entryNodeId: "solo",
          nodes: [
            {
              id: "solo",
              type: "agent",
              name: "solo",
              position: { x: 0, y: 0 },
              config: {
                driver: "first",
                mode: "auto",
                promptTemplate: "just {{task}}",
                continueSession: false,
              },
            },
            { id: "exit", type: "exit", name: "Exit", position: { x: 280, y: 0 } },
          ],
          edges: [{ id: "e1", source: "solo", target: "exit" }],
        },
      }),
    });
    expect(((await saved.json()) as { revision: { number: number } }).revision.number).toBe(2);

    const stored = h.db.runs.get(runBeforeBody.run.id);
    expect(stored?.workflowRevisionId).toBe(pinnedId);
    expect(h.db.workflowRevisions.get(pinnedId)?.number).toBe(1);
    expect(h.db.workflowRevisions.get(pinnedId)?.graph.nodes.map((node) => node.id)).toEqual([
      "s1",
      "s2",
      "exit",
    ]);

    // New runs pin the new latest revision.
    const runAfter = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "after the edit" }),
    });
    const runAfterBody = (await runAfter.json()) as {
      run: Run & { workflowRevision: { id: string; number: number } };
    };
    expect(runAfterBody.run.workflowRevision.number).toBe(2);

    // Run detail responses expose the pinned revision.
    const detail = (await (await h.request(`/api/runs/${runBeforeBody.run.id}`)).json()) as {
      run: Run & { workflowRevision?: { id: string; number: number } };
    };
    expect(detail.run.workflowRevision).toEqual({ id: pinnedId, number: 1 });
  });
});
