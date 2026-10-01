import { describe, expect, it, vi } from "vitest";
import type { AgentPreset, Run, Workflow } from "@openeuler/core";
import { ApiError } from "./api";
import {
  createAgentPreset,
  deleteAgentPreset,
  deleteWorkflow,
  fetchAgentPresets,
  fetchDriverIds,
  fetchWorkflow,
  fetchWorkflowForEditor,
  fetchWorkflows,
  startWorkflowRun,
  updateAgentPreset,
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

describe("fetchWorkflowForEditor (editor load + retry)", () => {
  it("maps a successful fetch to the ready state", async () => {
    const fetcher = vi.fn().mockResolvedValue({ workflow: fixtureWorkflow() });
    const state = await fetchWorkflowForEditor("w-1", fetcher as unknown as WorkflowFetcher);
    expect(state).toEqual({ phase: "ready", workflow: fixtureWorkflow() });
    expect(fetcher).toHaveBeenCalledWith("/api/workflows/w-1");
  });

  it("maps a 404 to notfound and other failures to error messages", async () => {
    const notFound = vi.fn().mockRejectedValue(new ApiError("WORKFLOW_NOT_FOUND", "nope", 404));
    expect(await fetchWorkflowForEditor("x", notFound as unknown as WorkflowFetcher)).toEqual({
      phase: "notfound",
    });

    const serverError = vi.fn().mockRejectedValue(new ApiError("HTTP_ERROR", "daemon down", 503));
    expect(await fetchWorkflowForEditor("x", serverError as unknown as WorkflowFetcher)).toEqual({
      phase: "error",
      message: "daemon down",
    });

    const unknown = vi.fn().mockRejectedValue(new Error("network"));
    expect(await fetchWorkflowForEditor("x", unknown as unknown as WorkflowFetcher)).toEqual({
      phase: "error",
      message: "Failed to load workflow",
    });
  });

  it("re-fetches on the next call, so Retry triggers a real refetch", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("HTTP_ERROR", "transient", 502))
      .mockResolvedValueOnce({ workflow: fixtureWorkflow() });
    const first = await fetchWorkflowForEditor("w-1", fetcher as unknown as WorkflowFetcher);
    expect(first).toEqual({ phase: "error", message: "transient" });
    const second = await fetchWorkflowForEditor("w-1", fetcher as unknown as WorkflowFetcher);
    expect(second).toEqual({ phase: "ready", workflow: fixtureWorkflow() });
    expect(fetcher).toHaveBeenCalledTimes(2);
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

describe("deleteWorkflow", () => {
  it("sends DELETE and tolerates the empty 204 body", async () => {
    const fetcher = vi.fn().mockResolvedValue(undefined);
    await expect(
      deleteWorkflow("w-1", fetcher as unknown as WorkflowFetcher),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith("/api/workflows/w-1", { method: "DELETE" });
  });
});

describe("agent presets api (#49)", () => {
  const config = {
    driver: "opencode",
    mode: "auto" as const,
    promptTemplate: "Review {{task}}",
    continueSession: false,
  };

  const fixturePreset: AgentPreset = {
    id: "preset-1",
    projectId: "p-1",
    name: "Senior Reviewer",
    description: "Reviews everything twice.",
    icon: "🔍",
    config,
    builtin: true,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
  };

  it("fetchAgentPresets lists the project roster", async () => {
    const fetcher = vi.fn().mockResolvedValue({ presets: [fixturePreset] });
    const presets = await fetchAgentPresets("p-1", fetcher as unknown as WorkflowFetcher);
    expect(presets).toEqual([fixturePreset]);
    expect(fetcher).toHaveBeenCalledWith("/api/projects/p-1/presets");
  });

  it("createAgentPreset posts name/description/icon/config and returns the preset", async () => {
    const fetcher = vi.fn().mockResolvedValue({ preset: fixturePreset });
    const created = await createAgentPreset({
      projectId: "p-1",
      name: "Senior Reviewer",
      description: "Reviews everything twice.",
      icon: "🔍",
      config,
      fetcher: fetcher as unknown as WorkflowFetcher,
    });
    expect(created).toEqual(fixturePreset);
    expect(fetcher).toHaveBeenCalledWith("/api/projects/p-1/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Senior Reviewer", description: "Reviews everything twice.", icon: "🔍", config }),
    });
  });

  it("createAgentPreset omits optional fields entirely", async () => {
    const fetcher = vi.fn().mockResolvedValue({ preset: fixturePreset });
    await createAgentPreset({
      projectId: "p-1",
      name: "Bare",
      config,
      fetcher: fetcher as unknown as WorkflowFetcher,
    });
    expect(JSON.parse(vi.mocked(fetcher).mock.calls[0]?.[1]?.body as string)).toEqual({
      name: "Bare",
      config,
    });
  });

  it("updateAgentPreset patches and returns the preset (icon: null clears)", async () => {
    const fetcher = vi.fn().mockResolvedValue({ preset: fixturePreset });
    const updated = await updateAgentPreset({
      projectId: "p-1",
      presetId: "preset-1",
      patch: { name: "Principal Reviewer", icon: null },
      fetcher: fetcher as unknown as WorkflowFetcher,
    });
    expect(updated).toEqual(fixturePreset);
    expect(fetcher).toHaveBeenCalledWith("/api/projects/p-1/presets/preset-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Principal Reviewer", icon: null }),
    });
  });

  it("deleteAgentPreset sends DELETE to the scoped path", async () => {
    const fetcher = vi.fn().mockResolvedValue(undefined);
    await deleteAgentPreset({
      projectId: "p-1",
      presetId: "preset-1",
      fetcher: fetcher as unknown as WorkflowFetcher,
    });
    expect(fetcher).toHaveBeenCalledWith("/api/projects/p-1/presets/preset-1", {
      method: "DELETE",
    });
  });

  it("propagates daemon 422s (invalid config)", async () => {
    const fetcher = vi.fn().mockRejectedValue(
      new ApiError("VALIDATION_ERROR", "promptTemplate must be a non-empty string", 422),
    );
    await expect(
      createAgentPreset({
        projectId: "p-1",
        name: "bad",
        config: { ...config, promptTemplate: "" },
        fetcher: fetcher as unknown as WorkflowFetcher,
      }),
    ).rejects.toBeInstanceOf(ApiError);
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
