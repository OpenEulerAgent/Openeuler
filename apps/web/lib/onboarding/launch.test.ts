import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { starterGraph } from "@/lib/graph/canvas-document";
import { findStarterTemplate } from "@/lib/onboarding/templates";
import {
  graphForChoice,
  launchWizardWorkflow,
  workflowNameForChoice,
} from "@/lib/onboarding/launch";
import type { WorkflowFetcher } from "@/lib/workflows-api";

/** Capturing mock transport: records calls, replies from a prefix route map. */
type CapturedCall = { path: string; init: RequestInit | undefined };
type CapturingFetcher = WorkflowFetcher & { calls: CapturedCall[] };

function mockFetch(routes: Record<string, (init?: RequestInit) => unknown>): CapturingFetcher {
  const calls: CapturedCall[] = [];
  // Longest-prefix match wins so "/api/workflows/wf_1/runs" is not captured
  // by the broader "/api/workflows" route.
  const sorted = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  const impl = async (path: string, init?: RequestInit): Promise<unknown> => {
    calls.push({ path, init });
    const handler = sorted.find(([prefix]) => path.startsWith(prefix))?.[1];
    if (handler === undefined) throw new ApiError("NOT_MOCKED", `no route for ${path}`, 0);
    return handler(init);
  };
  return Object.assign(impl, { calls }) as unknown as CapturingFetcher;
}

const workflowRow = (id: string) => ({
  id,
  projectId: "p1",
  name: "n",
  steps: [],
  latestRevision: { id: "rev", number: 1 },
});

const jsonBody = (init: RequestInit | undefined): Record<string, unknown> =>
  JSON.parse(String(init?.body)) as Record<string, unknown>;

describe("workflowNameForChoice / graphForChoice", () => {
  it("derives names from the templates and a plain name for blank", () => {
    expect(workflowNameForChoice("implement-review-fix")).toBe("Implement → Review → Fix");
    expect(workflowNameForChoice("feature-pipeline")).toBe("Feature pipeline");
    expect(workflowNameForChoice("blank")).toMatch(/\w/);
  });

  it("returns the template graph for starters and the canvas starter graph for blank", () => {
    expect(graphForChoice("implement-review-fix")).toBe(
      findStarterTemplate("implement-review-fix")?.graph,
    );
    expect(graphForChoice("feature-pipeline")).toBe(findStarterTemplate("feature-pipeline")?.graph);
    expect(graphForChoice("blank")).toEqual(starterGraph());
  });

  it("throws ApiError for unknown template ids", () => {
    expect(() => graphForChoice("nope" as never)).toThrow(ApiError);
  });
});

describe("launchWizardWorkflow", () => {
  it("POSTs the workflow with the exact template payload, then the run with the task", async () => {
    const template = findStarterTemplate("implement-review-fix");
    expect(template).toBeDefined();
    const fetcher = mockFetch({
      "/api/workflows": () => ({ workflow: workflowRow("wf_1"), revision: { id: "r", number: 1 } }),
      "/api/workflows/wf_1/runs": () => ({ run: { id: "run_1" } }),
    });

    const outcome = await launchWizardWorkflow({
      projectId: "p1",
      choice: "implement-review-fix",
      task: "  Add a greeting module  ",
      fetcher,
    });

    expect(outcome).toEqual({
      workflowId: "wf_1",
      workflowName: template?.workflowName,
      runId: "run_1",
    });
    expect(fetcher.calls).toHaveLength(2);

    const [create, run] = fetcher.calls;
    expect(create?.path).toBe("/api/workflows");
    expect(create?.init?.method).toBe("POST");
    const body = jsonBody(create?.init);
    expect(body).toEqual({
      projectId: "p1",
      name: template?.workflowName,
      graph: template?.graph,
    });

    expect(run?.path).toBe("/api/workflows/wf_1/runs");
    expect(run?.init?.method).toBe("POST");
    // Task is trimmed before POSTing.
    expect(jsonBody(run?.init)).toEqual({ task: "Add a greeting module" });
  });

  it("materializes the blank choice as the single-node starter graph", async () => {
    const fetcher = mockFetch({
      "/api/workflows": () => ({
        workflow: workflowRow("wf_blank"),
        revision: { id: "r", number: 1 },
      }),
      "/api/workflows/wf_blank/runs": () => ({ run: { id: "run_blank" } }),
    });

    await launchWizardWorkflow({ projectId: "p1", choice: "blank", task: "t", fetcher });

    const body = jsonBody(fetcher.calls[0]?.init);
    expect(body["name"]).toBe(workflowNameForChoice("blank"));
    expect(body["graph"]).toEqual(starterGraph());
  });

  it("rejects an empty task before any request is made", async () => {
    const fetcher = mockFetch({});
    await expect(
      launchWizardWorkflow({ projectId: "p1", choice: "blank", task: "   ", fetcher }),
    ).rejects.toMatchObject({ code: "TASK_REQUIRED" });
    expect(fetcher.calls).toHaveLength(0);
  });

  it("surfaces workflow-creation failures (e.g. graph validation 422)", async () => {
    const fetcher = mockFetch({
      "/api/workflows": () => {
        throw new ApiError("VALIDATION_ERROR", "unconditional cycle rejected", 422);
      },
    });
    await expect(
      launchWizardWorkflow({ projectId: "p1", choice: "feature-pipeline", task: "t", fetcher }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
  });

  it("does not start a run when workflow creation failed", async () => {
    const fetcher = mockFetch({
      "/api/workflows": () => {
        throw new ApiError("VALIDATION_ERROR", "bad graph", 422);
      },
    });
    await expect(
      launchWizardWorkflow({ projectId: "p1", choice: "feature-pipeline", task: "t", fetcher }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetcher.calls).toHaveLength(1);
  });
});
