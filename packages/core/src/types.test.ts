import { describe, expectTypeOf, it } from "vitest";
import type {
  AgentEvent,
  AgentToolCallEvent,
  ExitCondition,
  LoopBack,
  Project,
  Run,
  RunStatus,
  Step,
  StepRun,
  StepRunStatus,
  Workflow,
} from "./index.js";

describe("inferred z.infer types compile", () => {
  it("Project fields", () => {
    expectTypeOf<Project["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Project["path"]>().toEqualTypeOf<string>();
    expectTypeOf<Project["name"]>().toEqualTypeOf<string>();
    expectTypeOf<Project["defaultBranch"]>().toEqualTypeOf<string>();
    expectTypeOf<Project["createdAt"]>().toEqualTypeOf<string>();
  });

  it("Step mode is a literal union", () => {
    expectTypeOf<Step["mode"]>().toEqualTypeOf<"auto" | "ask">();
    expectTypeOf<Step["driver"]>().toEqualTypeOf<string>();
    expectTypeOf<Step["model"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Step["agent"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Step["promptTemplate"]>().toEqualTypeOf<string>();
    expectTypeOf<Step["continueSession"]>().toEqualTypeOf<boolean>();
  });

  it("ExitCondition is a discriminated union", () => {
    expectTypeOf<ExitCondition["type"]>().toEqualTypeOf<
      "always" | "outputContains" | "outputNotContains" | "outputMatches"
    >();
  });

  it("LoopBack fields", () => {
    expectTypeOf<LoopBack["toStepIndex"]>().toEqualTypeOf<number>();
    expectTypeOf<LoopBack["when"]>().toEqualTypeOf<ExitCondition>();
    expectTypeOf<LoopBack["maxIterations"]>().toEqualTypeOf<number>();
  });

  it("Workflow fields", () => {
    expectTypeOf<Workflow["projectId"]>().toEqualTypeOf<string>();
    expectTypeOf<Workflow["steps"]>().toEqualTypeOf<Step[]>();
    expectTypeOf<LoopBack | undefined>().toEqualTypeOf<Workflow["loopBack"]>();
  });

  it("Run status union and fields", () => {
    expectTypeOf<RunStatus>().toEqualTypeOf<
      "queued" | "running" | "success" | "failed" | "aborted" | "interrupted"
    >();
    expectTypeOf<Run["status"]>().toEqualTypeOf<RunStatus>();
    expectTypeOf<Run["workflowId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Run["task"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Run["output"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Run["error"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Run["createdAt"]>().toEqualTypeOf<string>();
    expectTypeOf<Run["updatedAt"]>().toEqualTypeOf<string>();
  });

  it("StepRun fields", () => {
    expectTypeOf<StepRun["runId"]>().toEqualTypeOf<string>();
    expectTypeOf<StepRun["stepId"]>().toEqualTypeOf<string>();
    expectTypeOf<StepRun["sessionId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<StepRun["status"]>().toEqualTypeOf<StepRunStatus>();
    expectTypeOf<StepRun["output"]>().toEqualTypeOf<string>();
    expectTypeOf<StepRun["diff"]>().toEqualTypeOf<string | undefined>();
  });

  it("AgentEvent is a discriminated union with seq on every variant", () => {
    expectTypeOf<AgentEvent["type"]>().toEqualTypeOf<
      "started" | "session" | "message-delta" | "tool-call" | "tool-output" | "done" | "error"
    >();
    expectTypeOf<AgentEvent["seq"]>().toEqualTypeOf<number>();
  });

  it("tool-call input accepts JSON values", () => {
    const withObject: AgentToolCallEvent = {
      type: "tool-call",
      seq: 1,
      tool: "edit",
      input: { path: "a.ts" },
    };
    const withString: AgentToolCallEvent = {
      type: "tool-call",
      seq: 2,
      tool: "bash",
      input: "ls -la",
    };
    expectTypeOf([withObject, withString]).not.toBeNever();
  });

  it("typed literals assign without casts", () => {
    const project: Project = {
      id: "proj-1",
      path: "/srv/git/openeuler",
      name: "openeuler",
      defaultBranch: "main",
      createdAt: "2026-09-30T09:00:00.000Z",
    };
    expectTypeOf(project).not.toBeNever();
  });
});
