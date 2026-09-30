import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AgentErrorEventSchema,
  AgentEventSchema,
  ExitConditionSchema,
  FileContentSchema,
  FileNodeSchema,
  LoopBackSchema,
  OutputMatchesConditionSchema,
  ProjectSchema,
  RunSchema,
  RunStatusEventSchema,
  StepRunSchema,
  StepSchema,
  WorkflowSchema,
  renderPromptTemplate,
} from "./index.js";

const validProject = {
  id: "proj-1",
  path: "/srv/git/openeuler",
  name: "openeuler",
  defaultBranch: "main",
  createdAt: "2026-09-30T09:00:00.000Z",
};

const validStep = {
  id: "step-1",
  name: "implement",
  driver: "opencode",
  mode: "auto",
  promptTemplate: "Implement the following task:\n{{task}}",
  continueSession: false,
};

const validWorkflow = {
  id: "wf-1",
  projectId: "proj-1",
  name: "docs-sync",
  steps: [
    validStep,
    {
      id: "step-2",
      name: "review",
      driver: "claude",
      model: "claude-sonnet-4",
      agent: "reviewer",
      mode: "ask",
      promptTemplate: "Review this change:\n{{prevOutput}}\n(iteration {{iterations}})",
      continueSession: true,
    },
  ],
  loopBack: {
    toStepIndex: 0,
    when: { type: "outputNotContains", pattern: "LGTM" },
    maxIterations: 3,
  },
};

const validRun = {
  id: "run-1",
  projectId: "proj-1",
  workflowId: "wf-1",
  status: "queued",
  branch: "openeuler/run-1",
  iteration: 0,
  createdAt: "2026-09-30T10:00:00.000Z",
  updatedAt: "2026-09-30T10:00:00.000Z",
};

const adHocRun = {
  id: "run-2",
  projectId: "proj-1",
  status: "running",
  branch: "openeuler/adhoc-1",
  iteration: 0,
  task: "Fix the flaky test in packages/core",
  createdAt: "2026-09-30T10:05:00.000Z",
  updatedAt: "2026-09-30T10:07:30.000Z",
};

const validStepRun = {
  id: "steprun-1",
  runId: "run-1",
  stepId: "step-1",
  iteration: 1,
  sessionId: "session-abc",
  status: "success",
  output: "done: 2 files changed",
  diff: "diff --git a/src/index.ts b/src/index.ts",
};

const validAgentEvents = [
  { type: "started", seq: 0 },
  { type: "session", seq: 1, sessionId: "session-abc" },
  { type: "message-delta", seq: 2, delta: "Editing " },
  { type: "message-delta", seq: 3, delta: "src/index.ts" },
  { type: "tool-call", seq: 4, tool: "edit", input: { path: "src/index.ts" } },
  { type: "tool-output", seq: 5, output: "ok" },
  { type: "done", seq: 6, output: "2 files changed" },
  { type: "error", seq: 7, message: "driver crashed", code: "E_DRIVER" },
];

describe("valid fixtures parse", () => {
  it("parses a project", () => {
    expect(ProjectSchema.parse(validProject)).toEqual(validProject);
  });

  it("parses a project with snapshot metadata", () => {
    const withSnapshot = {
      ...validProject,
      remoteUrl: "https://example.com/openeuler.git",
      dirty: true,
    };
    expect(ProjectSchema.parse(withSnapshot)).toEqual(withSnapshot);
  });

  it("parses a workflow with steps and loopBack", () => {
    expect(WorkflowSchema.parse(validWorkflow)).toEqual(validWorkflow);
  });

  it("parses a step with optional model/agent omitted", () => {
    expect(StepSchema.parse(validStep)).toEqual(validStep);
  });

  it("parses workflow runs and ad-hoc runs", () => {
    expect(RunSchema.parse(validRun)).toEqual(validRun);
    expect(RunSchema.parse(adHocRun)).toEqual(adHocRun);
  });

  it("parses a step run", () => {
    expect(StepRunSchema.parse(validStepRun)).toEqual(validStepRun);
  });

  it("parses every agent event variant", () => {
    for (const event of validAgentEvents) {
      expect(AgentEventSchema.parse(event)).toEqual(event);
    }
  });

  it("parses file nodes and file content payloads", () => {
    const dirNode = { name: "src", type: "dir", size: 0 };
    expect(FileNodeSchema.parse(dirNode)).toEqual(dirNode);
    const fileNode = { name: "alpha.ts", type: "file", size: 26 };
    expect(FileNodeSchema.parse(fileNode)).toEqual(fileNode);
    const content = {
      content: "export const alpha = 1;\n",
      truncated: false,
      binary: false,
      size: 26,
    };
    expect(FileContentSchema.parse(content)).toEqual(content);
  });
});

describe("invalid fixtures are rejected with clear messages", () => {
  const expectRejected = (schema: z.ZodType, input: unknown, ...fragments: string[]) => {
    const result = schema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const text = result.error.issues.map((issue) => issue.message).join(" | ");
      for (const fragment of fragments) {
        expect(text).toContain(fragment);
      }
    }
  };

  it("rejects a bad step mode", () => {
    expectRejected(StepSchema, { ...validStep, mode: "yolo" }, "auto", "ask");
  });

  it("rejects negative and zero maxIterations", () => {
    expectRejected(
      LoopBackSchema,
      { ...validWorkflow.loopBack, maxIterations: 0 },
      "maxIterations must be an integer >= 1",
    );
    expectRejected(
      LoopBackSchema,
      { ...validWorkflow.loopBack, maxIterations: -2 },
      "maxIterations must be an integer >= 1",
    );
  });

  it("rejects an unknown exit condition type", () => {
    expectRejected(ExitConditionSchema, { type: "sometimes" }, "always", "outputContains");
  });

  it("rejects an invalid regex in outputMatches", () => {
    expectRejected(
      OutputMatchesConditionSchema,
      { type: "outputMatches", regex: "([a-z" },
      "invalid regular expression",
    );
    expectRejected(
      ExitConditionSchema,
      { type: "outputMatches", regex: "*" },
      "invalid regular expression",
    );
  });

  it("rejects invalid regex flags", () => {
    expectRejected(
      OutputMatchesConditionSchema,
      { type: "outputMatches", regex: "ok", flags: "q" },
      "flags may only contain",
    );
  });

  it("accepts a valid regex with flags", () => {
    expect(
      ExitConditionSchema.parse({ type: "outputMatches", regex: "^all tests pass", flags: "im" }),
    ).toEqual({ type: "outputMatches", regex: "^all tests pass", flags: "im" });
  });

  it("rejects unknown keys (strict objects)", () => {
    expectRejected(ProjectSchema, { ...validProject, extra: true }, "Unrecognized key");
    expectRejected(WorkflowSchema, { ...validWorkflow, retry: 5 }, "Unrecognized key");
  });

  it("rejects a non-ISO timestamp", () => {
    expectRejected(ProjectSchema, { ...validProject, createdAt: "yesterday" }, "ISO 8601");
  });

  it("rejects an empty steps array", () => {
    expectRejected(WorkflowSchema, { ...validWorkflow, steps: [] }, "at least one step");
  });

  it("rejects a step run without required output", () => {
    const { output, ...noOutput } = validStepRun;
    void output;
    expectRejected(StepRunSchema, noOutput, "expected string, received undefined");
  });

  it("rejects a bad run status", () => {
    expectRejected(RunSchema, { ...validRun, status: "cancelled" }, "queued", "interrupted");
  });

  it("rejects malformed agent events", () => {
    expectRejected(AgentEventSchema, { type: "log", seq: 0 }, "started", "session");
    expectRejected(
      AgentErrorEventSchema,
      { type: "error", seq: -1, message: "boom" },
      "seq must be an integer >= 0",
    );
    expectRejected(AgentEventSchema, { type: "message-delta", seq: 1, delta: 42 }, "string");
  });

  it("keeps run.status out of the persisted agent event union", () => {
    // The synthetic SSE-only terminal event must NOT validate as a persisted
    // AgentEvent (the events table stays driver-only; engine events land with #15).
    expectRejected(AgentEventSchema, { type: "run.status", seq: 1, status: "success" });
  });

  it("parses synthetic run.status events for every terminal status", () => {
    for (const status of ["success", "failed", "aborted", "interrupted"] as const) {
      expect(RunStatusEventSchema.parse({ type: "run.status", seq: 8, status })).toEqual({
        type: "run.status",
        seq: 8,
        status,
      });
    }
  });

  it("rejects malformed synthetic run.status events", () => {
    expectRejected(RunStatusEventSchema, { type: "run.status", seq: 8, status: "queued" });
    expectRejected(RunStatusEventSchema, { type: "run.status", seq: 8, status: "running" });
    expectRejected(RunStatusEventSchema, { type: "run.status", seq: -1, status: "success" });
    expectRejected(
      RunStatusEventSchema,
      { type: "run.status", seq: 8, status: "success", extra: true },
      "Unrecognized key",
    );
  });

  it("rejects malformed file nodes and file content payloads", () => {
    expectRejected(FileNodeSchema, { name: "a", type: "symlink", size: 1 }, "file", "dir");
    expectRejected(FileNodeSchema, { name: "a", type: "file", size: -1 }, "non-negative");
    expectRejected(
      FileNodeSchema,
      { name: "a", type: "file", size: 1, mode: 0o644 },
      "Unrecognized key",
    );
    expectRejected(
      FileContentSchema,
      { content: "x", truncated: false, binary: false, size: "3" },
      "number",
    );
    expectRejected(FileContentSchema, { content: "x", truncated: false, size: 1 }, "boolean");
  });
});

describe("renderPromptTemplate", () => {
  it("renders all documented variables", () => {
    expect(
      renderPromptTemplate("{{task}} / {{prevOutput}} / {{iterations}}", {
        task: "fix bug",
        prevOutput: "previous output",
        iterations: 3,
      }),
    ).toBe("fix bug / previous output / 3");
  });

  it("tolerates whitespace inside tokens and renders missing vars as empty", () => {
    expect(renderPromptTemplate("{{ task }}[{{prevOutput}}]", { task: "t" })).toBe("t[]");
  });

  it("throws on unknown variables listing the valid ones", () => {
    expect(() => renderPromptTemplate("hi {{unknown}}", {})).toThrowError(
      /Unknown prompt template variable \{\{unknown\}\}.*\{\{task\}\}/s,
    );
  });
});
