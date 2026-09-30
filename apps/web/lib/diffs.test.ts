import { describe, expect, it, vi } from "vitest";
import type { StepRun } from "@openeuler/core";
import {
  diffLoadReducer,
  fetchRunDiff,
  scopeToQuery,
  stepScopeOptions,
  type DiffLoadState,
  type RunDiffResponse,
} from "./diffs.js";

const makeStep = (over: Partial<StepRun>): StepRun => ({
  id: "sr-1",
  runId: "r-1",
  stepId: "implement",
  iteration: 1,
  status: "success",
  output: "",
  ...over,
});

describe("scopeToQuery", () => {
  it("builds query strings for both scope kinds", () => {
    expect(scopeToQuery({ kind: "cumulative" })).toBe("scope=cumulative");
    expect(scopeToQuery({ kind: "step", stepRunId: "abc" })).toBe("scope=step&stepRunId=abc");
    expect(scopeToQuery({ kind: "step", stepRunId: "id with spaces" })).toBe(
      "scope=step&stepRunId=id%20with%20spaces",
    );
  });
});

describe("stepScopeOptions", () => {
  it("labels each step run with its step id and 1-based iteration, flagging empty diffs", () => {
    const steps = [
      makeStep({ id: "sr-a", stepId: "implement", iteration: 1, diff: "x" }),
      makeStep({ id: "sr-b", stepId: "review", iteration: 1 }),
      makeStep({ id: "sr-c", stepId: "implement", iteration: 2, diff: "y" }),
    ];
    expect(stepScopeOptions(steps)).toEqual([
      { stepRunId: "sr-a", label: "implement (iter 1)", hasDiff: true },
      { stepRunId: "sr-b", label: "review (iter 1)", hasDiff: false },
      { stepRunId: "sr-c", label: "implement (iter 2)", hasDiff: true },
    ]);
  });
});

describe("diffLoadReducer", () => {
  const diff: RunDiffResponse = {
    scope: "cumulative",
    stat: "",
    patch: "diff --git a/x b/x",
    truncated: false,
    totalLines: 1,
    maxLines: 20_000,
  };
  const cumulative = { kind: "cumulative" } as const;
  const stepScope = { kind: "step", stepRunId: "sr-9" } as const;

  it("select → loading, loaded → ready", () => {
    let state: DiffLoadState = { phase: "idle" };
    state = diffLoadReducer(state, { type: "select", scope: cumulative });
    expect(state).toEqual({ phase: "loading", scope: cumulative });
    state = diffLoadReducer(state, { type: "loaded", scope: cumulative, diff });
    expect(state).toEqual({ phase: "ready", scope: cumulative, diff });
  });

  it("maps 410 to the gone phase", () => {
    let state: DiffLoadState = diffLoadReducer(
      { phase: "idle" },
      {
        type: "select",
        scope: cumulative,
      },
    );
    state = diffLoadReducer(state, { type: "gone", scope: cumulative });
    expect(state).toEqual({ phase: "gone", scope: cumulative });
  });

  it("maps failures to the error phase with the message", () => {
    let state: DiffLoadState = diffLoadReducer(
      { phase: "idle" },
      {
        type: "select",
        scope: stepScope,
      },
    );
    state = diffLoadReducer(state, {
      type: "failed",
      scope: stepScope,
      status: 500,
      message: "boom",
    });
    expect(state).toEqual({ phase: "error", scope: stepScope, message: "boom" });
  });

  it("drops stale responses after a newer selection", () => {
    let state: DiffLoadState = diffLoadReducer(
      { phase: "idle" },
      {
        type: "select",
        scope: cumulative,
      },
    );
    // User switches scope before the cumulative fetch resolves.
    state = diffLoadReducer(state, { type: "select", scope: stepScope });
    // Late cumulative response arrives — must not clobber the step loading.
    state = diffLoadReducer(state, { type: "loaded", scope: cumulative, diff });
    expect(state).toEqual({ phase: "loading", scope: stepScope });
    // Step response lands — ready.
    state = diffLoadReducer(state, {
      type: "loaded",
      scope: stepScope,
      diff: { ...diff, scope: "step", stepRunId: "sr-9" },
    });
    expect(state).toMatchObject({ phase: "ready", scope: stepScope });
  });

  it("distinguishes step scopes by stepRunId for staleness", () => {
    const other = { kind: "step", stepRunId: "sr-1" } as const;
    let state: DiffLoadState = { phase: "ready", scope: other, diff };
    state = diffLoadReducer(state, { type: "select", scope: stepScope });
    state = diffLoadReducer(state, {
      type: "loaded",
      scope: other,
      diff,
    });
    expect(state).toEqual({ phase: "loading", scope: stepScope });
  });
});

describe("fetchRunDiff", () => {
  it("requests the right path per scope and returns the parsed body", async () => {
    const fetcher = vi.fn<(path: string) => Promise<RunDiffResponse>>();
    fetcher.mockResolvedValue({
      scope: "step",
      stat: " x | 1 +",
      patch: "diff --git a/x b/x",
      truncated: false,
      totalLines: 1,
      maxLines: 20_000,
      stepRunId: "sr-7",
    });

    const body = await fetchRunDiff("run 42", { kind: "step", stepRunId: "sr-7" }, fetcher);

    expect(fetcher).toHaveBeenCalledWith("/api/runs/run%2042/diff?scope=step&stepRunId=sr-7");
    expect(body.stepRunId).toBe("sr-7");
  });

  it("uses cumulative scope without a stepRunId", async () => {
    const fetcher = vi.fn<(path: string) => Promise<RunDiffResponse>>();
    fetcher.mockResolvedValue({
      scope: "cumulative",
      stat: "",
      patch: "",
      truncated: false,
      totalLines: 0,
      maxLines: 20_000,
    });
    await fetchRunDiff("r", { kind: "cumulative" }, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/runs/r/diff?scope=cumulative");
  });
});
