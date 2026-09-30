import { describe, expect, it, vi } from "vitest";
import type { Run, Workflow } from "@openeuler/core";
import { ApiError } from "./api";
import {
  createLoopDraft,
  createStepDraft,
  createWorkflowDraft,
  draftReducer,
} from "./workflow-builder";
import {
  deleteWorkflow,
  fetchDriverIds,
  fetchWorkflow,
  fetchWorkflows,
  saveWorkflowDraft,
  startWorkflowRun,
  type WorkflowFetcher,
} from "./workflows-api";

/**
 * Mocks are apiFetch-shaped: they receive (path, init) and resolve to the
 * already-parsed body (or reject with an ApiError), matching WorkflowFetcher.
 */
function fixtureWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "w-1",
    projectId: "p-1",
    name: "loop",
    steps: [
      {
        id: "s1",
        name: "only",
        driver: "fake",
        mode: "auto",
        promptTemplate: "{{task}}",
        continueSession: false,
      },
    ],
    ...overrides,
  };
}

describe("fetchWorkflows", () => {
  it("lists workflows scoped to the project", async () => {
    const fetcher = vi.fn().mockResolvedValue({ workflows: [fixtureWorkflow()] });
    const workflows = await fetchWorkflows("p-1", fetcher as unknown as WorkflowFetcher);
    expect(workflows).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith("/api/workflows?projectId=p-1");
  });
});

describe("fetchWorkflow", () => {
  it("returns the single workflow", async () => {
    const fetcher = vi.fn().mockResolvedValue({ workflow: fixtureWorkflow() });
    const workflow = await fetchWorkflow("w-1", fetcher as unknown as WorkflowFetcher);
    expect(workflow.id).toBe("w-1");
    expect(fetcher).toHaveBeenCalledWith("/api/workflows/w-1");
  });

  it("propagates 404s as ApiError", async () => {
    const fetcher = vi.fn().mockRejectedValue(new ApiError("WORKFLOW_NOT_FOUND", "nope", 404));
    await expect(fetchWorkflow("x", fetcher as unknown as WorkflowFetcher)).rejects.toThrow(
      ApiError,
    );
  });
});

describe("fetchDriverIds", () => {
  it("returns the registered ids", async () => {
    const fetcher = vi.fn().mockResolvedValue({ drivers: ["fake", "opencode"] });
    expect(await fetchDriverIds(fetcher as unknown as WorkflowFetcher)).toEqual([
      "fake",
      "opencode",
    ]);
  });

  it("falls back to the default list when the daemon is unreachable or empty", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("down"));
    expect(await fetchDriverIds(failing as unknown as WorkflowFetcher)).toEqual(["opencode"]);
    const empty = vi.fn().mockResolvedValue({ drivers: [] });
    expect(await fetchDriverIds(empty as unknown as WorkflowFetcher)).toEqual(["opencode"]);
  });
});

describe("saveWorkflowDraft", () => {
  const draft = draftReducer(createWorkflowDraft(), {
    type: "rename",
    name: "saved",
  });

  it("POSTs a create body with projectId", async () => {
    const fetcher = vi.fn().mockResolvedValue({ workflow: fixtureWorkflow() });
    const workflow = await saveWorkflowDraft({
      projectId: "p-1",
      draft,
      fetcher: fetcher as unknown as WorkflowFetcher,
    });
    expect(workflow.id).toBe("w-1");
    expect(fetcher).toHaveBeenCalledWith("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: expect.any(String),
    });
    const body = JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string) as {
      projectId: string;
      name: string;
    };
    expect(body).toMatchObject({ projectId: "p-1", name: "saved" });
    expect("loopBack" in body && body.loopBack === null).toBe(false); // omitted, not null
  });

  it("PATCHes with loopBack null when the loop is disabled", async () => {
    const fetcher = vi.fn().mockResolvedValue({ workflow: fixtureWorkflow() });
    await saveWorkflowDraft({
      projectId: "p-1",
      draft,
      workflowId: "w-1",
      fetcher: fetcher as unknown as WorkflowFetcher,
    });
    expect(fetcher).toHaveBeenCalledWith("/api/workflows/w-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: expect.any(String),
    });
    const body = JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string) as {
      loopBack: unknown;
    };
    expect(body.loopBack).toBeNull();
  });

  it("PATCHes the enabled loopBack config", async () => {
    let enabled = createWorkflowDraft();
    enabled = draftReducer(enabled, { type: "rename", name: "looped" });
    enabled = draftReducer(enabled, { type: "add-step" }); // loop needs a target after step 1
    enabled = draftReducer(enabled, {
      type: "patch-loop",
      patch: { conditionType: "outputNotContains", pattern: "LGTM" },
    });
    enabled = draftReducer(enabled, { type: "set-loop-enabled", enabled: true });

    const fetcher = vi.fn().mockResolvedValue({ workflow: fixtureWorkflow() });
    await saveWorkflowDraft({
      projectId: "p-1",
      draft: enabled,
      workflowId: "w-1",
      fetcher: fetcher as unknown as WorkflowFetcher,
    });
    const body = JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string) as {
      loopBack: { when: { type: string } };
    };
    expect(body.loopBack).toMatchObject({
      toStepIndex: createLoopDraft().toStepIndex,
      when: { type: "outputNotContains", pattern: "LGTM" },
      maxIterations: createLoopDraft().maxIterations,
    });
  });

  it("exposes server 422 zod details via ApiError", async () => {
    const fetcher = vi.fn().mockRejectedValue(
      new ApiError("VALIDATION_ERROR", "maxIterations must be an integer >= 1", 422, {
        details: [
          { path: "loopBack.maxIterations", message: "maxIterations must be an integer >= 1" },
        ],
      }),
    );
    try {
      await saveWorkflowDraft({
        projectId: "p-1",
        draft,
        fetcher: fetcher as unknown as WorkflowFetcher,
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).details).toEqual([
        { path: "loopBack.maxIterations", message: "maxIterations must be an integer >= 1" },
      ]);
    }
  });
});

describe("deleteWorkflow", () => {
  it("sends DELETE and tolerates the empty 204 body", async () => {
    const fetcher = vi.fn().mockResolvedValue(undefined);
    await expect(
      deleteWorkflow("w-1", fetcher as unknown as WorkflowFetcher),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith("/api/workflows/w-1", { method: "DELETE" });
  });
});

describe("startWorkflowRun (run-modal submit flow)", () => {
  const run: Run = {
    id: "run-9",
    projectId: "p-1",
    workflowId: "w-1",
    status: "queued",
    branch: "openeuler/run-9",
    iteration: 0,
    task: "ship it",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("posts the trimmed task and returns the accepted run", async () => {
    const fetcher = vi.fn().mockResolvedValue({ run });
    const accepted = await startWorkflowRun(
      "w-1",
      "  ship it  ",
      fetcher as unknown as WorkflowFetcher,
    );
    expect(accepted.id).toBe("run-9");
    expect(fetcher).toHaveBeenCalledWith("/api/workflows/w-1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "ship it" }),
    });
  });

  it("refuses an empty task without hitting the network", async () => {
    const fetcher = vi.fn();
    await expect(
      startWorkflowRun("w-1", "   ", fetcher as unknown as WorkflowFetcher),
    ).rejects.toThrow(/non-empty/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("propagates daemon 422s (empty task blocked server-side too)", async () => {
    const fetcher = vi.fn().mockRejectedValue(
      new ApiError("VALIDATION_ERROR", "task must be a non-empty string", 422, {
        details: [{ path: "task", message: "task must be a non-empty string" }],
      }),
    );
    const caught = await startWorkflowRun("w-1", "x", fetcher as unknown as WorkflowFetcher).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(caught).toBeInstanceOf(ApiError);
    const error = caught as ApiError;
    expect(error.status).toBe(422);
    expect(error.details?.[0]?.path).toBe("task");
  });
});

describe("createStepDraft driver default", () => {
  it("defaults to the opencode driver for new steps", () => {
    expect(createStepDraft().driver).toBe("opencode");
  });
});
