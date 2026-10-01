import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowGraphSchema } from "@openeuler/core";
import type { Run, StepRun, Workflow } from "@openeuler/core";
import { createDatabase } from "@openeuler/db";
import type { Db } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "./app.js";
import { createExecutor } from "./executor.js";
import type { Executor } from "./executor.js";
import { createLogger } from "./logger.js";
// The REAL starter templates users get (web lib) — importing them here pins
// the daemon round-trip to the exact graphs the wizard POSTs.
import { STARTER_TEMPLATES } from "../../web/lib/onboarding/templates";

/**
 * Onboarding integration (#53): each starter template materializes as a
 * workflow (POST graph → revision 1 → GET round-trip) and runs end-to-end
 * against the fake driver registered under the templates' driver id.
 */

interface Harness {
  db: Db;
  executor: Executor;
  driver: ReturnType<typeof createFakeDriver>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
}

const created: { db: Db; dir: string }[] = [];

const setup = (fakeOutputs: string[]): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-onboarding-"));
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

  // Templates configure driver "opencode"; the fake driver registers under
  // that id so the exact template graphs run unmodified.
  const drivers = createDriverRegistry();
  const driver = createFakeDriver({ id: "opencode", outputs: fakeOutputs });
  drivers.registerDriver(driver);
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot: join(dir, "store") }),
    drivers,
    logger: createLogger("silent"),
  });
  const { app } = createApp({ db, logger: createLogger("silent"), executor });

  created.push({ db, dir });
  return {
    db,
    executor,
    driver,
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

const pollRunStatus = async (h: Harness, runId: string): Promise<Run> => {
  for (;;) {
    const res = await h.request(`/api/runs/${runId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: Run };
    if (["success", "failed", "aborted", "interrupted"].includes(body.run.status)) return body.run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe.each(STARTER_TEMPLATES.map((template) => [template.id, template] as const))(
  "starter template %s",
  (id, template) => {
    it("materializes as an editable workflow whose graph round-trips via revision 1", async () => {
      const h = setup([]);

      const createRes = await h.request("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: h.projectId,
          name: template.workflowName,
          graph: template.graph,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        workflow: Workflow & { graph?: unknown; latestRevision?: { number: number } };
        revision: { id: string; number: number };
      };
      expect(created.revision.number).toBe(1);
      const workflowId = created.workflow.id;

      // Workflow body carries the latest revision graph...
      const normalized = WorkflowGraphSchema.parse(template.graph);
      expect(created.workflow.latestRevision).toEqual({ id: created.revision.id, number: 1 });
      expect(created.workflow.graph).toEqual(normalized);

      // ...and the revision snapshot round-trips identically.
      const revisionRes = await h.request(`/api/workflows/${workflowId}/revisions/1`);
      expect(revisionRes.status).toBe(200);
      const revisionBody = (await revisionRes.json()) as { revision: { graph: unknown } };
      expect(revisionBody.revision.graph).toEqual(normalized);
    });

    it("runs end-to-end with the fake driver to a successful run", async () => {
      // Output cycling: implement → reviewer approves (LGTM) on the first
      // review pass; later nodes (tests/docs/fix) receive the leftovers.
      const h = setup(["Implemented the change.", "LGTM\nShip it."]);

      const createRes = await h.request("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: h.projectId,
          name: template.workflowName,
          graph: template.graph,
        }),
      });
      expect(createRes.status).toBe(201);
      const { workflow } = (await createRes.json()) as { workflow: Workflow };

      const runRes = await h.request(`/api/workflows/${workflow.id}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "Add a greeting module" }),
      });
      expect(runRes.status).toBe(202);
      const { run } = (await runRes.json()) as { run: Run };

      const finished = await pollRunStatus(h, run.id);
      expect(finished.status).toBe("success");

      const stepsRes = await h.request(`/api/runs/${run.id}`);
      const detail = (await stepsRes.json()) as { steps: StepRun[] };
      expect(detail.steps.length).toBeGreaterThan(0);
      expect(detail.steps.every((step) => step.status === "success")).toBe(true);
      expect(h.executor.activeRunIds()).not.toContain(run.id);
    });
  },
);

describe("starter template implement-review-fix routing", () => {
  it("routes implement → reviewer → exit when the reviewer approves, and loops through fix when not", async () => {
    // Pass 1: reviewer blocks once (CHANGES REQUESTED), fix repairs, reviewer
    // approves. Outputs cycle per driver start across the whole run.
    const h = setup([
      "Implemented the change.", // 1. implement
      "CHANGES REQUESTED\nedge case missed.", // 2. reviewer → fix
      "Fixed the edge case.", // 3. fix
      "LGTM\nShip it.", // 4. reviewer → exit
    ]);

    const template = STARTER_TEMPLATES.find((t) => t.id === "implement-review-fix");
    expect(template).toBeDefined();
    const createRes = await h.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: h.projectId,
        name: template?.workflowName,
        graph: template?.graph,
      }),
    });
    expect(createRes.status).toBe(201);
    const { workflow } = (await createRes.json()) as { workflow: Workflow };

    const runRes = await h.request(`/api/workflows/${workflow.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "Harden the parser" }),
    });
    const { run } = (await runRes.json()) as { run: Run };

    const finished = await pollRunStatus(h, run.id);
    expect(finished.status).toBe("success");

    // implement → reviewer → fix → reviewer: four agent starts, and the
    // breadcrumb proves the router took the fix edge before the approval.
    expect(h.driver.calls).toHaveLength(4);
    expect(finished.breadcrumb).toEqual([
      { kind: "node", nodeId: "implement", iteration: 1 },
      { kind: "edge", edgeId: "e-implement-reviewer", iteration: 1 },
      { kind: "node", nodeId: "reviewer", iteration: 1 },
      { kind: "edge", edgeId: "e-reviewer-fix", iteration: 1 },
      { kind: "node", nodeId: "fix", iteration: 1 },
      { kind: "edge", edgeId: "e-fix-reviewer", iteration: 1 },
      { kind: "node", nodeId: "reviewer", iteration: 2 },
      { kind: "edge", edgeId: "e-reviewer-approve", iteration: 2 },
    ]);
  });
});
