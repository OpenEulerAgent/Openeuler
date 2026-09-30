import { describe, expect, it } from "vitest";
import { WorkflowSchema } from "@openeuler/core";
import { ApiError } from "./api";
import {
  buildExitCondition,
  createLoopDraft,
  createStepDraft,
  createWorkflowDraft,
  draftReducer,
  draftToPayload,
  fieldErrorsFromApiError,
  insertAtCursor,
  moveItem,
  regexIssue,
  renderStepPreview,
  stepFieldKey,
  validateDraft,
  workflowToDraft,
  type LoopDraft,
  type StepDraft,
} from "./workflow-builder";

function step(overrides: Partial<StepDraft> = {}): StepDraft {
  return createStepDraft({
    name: "step",
    driver: "opencode",
    promptTemplate: "{{task}}",
    ...overrides,
  });
}

/** Draft with `n` valid steps and an optional enabled loop. */
function draftWithSteps(
  loop?: Partial<LoopDraft>,
  count = 3,
): ReturnType<typeof createWorkflowDraft> {
  return {
    name: "review-loop",
    steps: Array.from({ length: count }, (_, index) =>
      step({
        name: `step-${index + 1}`,
        promptTemplate: index === 0 ? "{{task}}" : "{{prevOutput}}",
      }),
    ),
    loop: createLoopDraft({ enabled: true, toStepIndex: 1, ...loop }),
  };
}

describe("createWorkflowDraft", () => {
  it("starts with one empty step and a disabled loop", () => {
    const draft = createWorkflowDraft();
    expect(draft.name).toBe("");
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0]?.driver).toBe("opencode");
    expect(draft.steps[0]?.mode).toBe("auto");
    expect(draft.loop.enabled).toBe(false);
  });

  it("mints a fresh uuid per step", () => {
    const a = createWorkflowDraft();
    const b = createWorkflowDraft();
    expect(a.steps[0]?.id).not.toBe(b.steps[0]?.id);
  });
});

describe("draftReducer steps", () => {
  it("adds steps at the end (explicit or default factory)", () => {
    const explicit = step({ name: "explicit" });
    let draft = createWorkflowDraft();
    draft = draftReducer(draft, { type: "add-step", step: explicit });
    draft = draftReducer(draft, { type: "add-step" });
    expect(draft.steps.map((item) => item.name)).toEqual(["", "explicit", ""]);
  });

  it("never removes the last step", () => {
    let draft = createWorkflowDraft();
    draft = draftReducer(draft, { type: "remove-step", index: 0 });
    expect(draft.steps).toHaveLength(1);
  });

  it("removes a step by index", () => {
    let draft = draftWithSteps(undefined, 3);
    draft = draftReducer(draft, { type: "remove-step", index: 1 });
    expect(draft.steps.map((item) => item.name)).toEqual(["step-1", "step-3"]);
  });

  it("patches a single step without touching ids or siblings", () => {
    let draft = draftWithSteps(undefined, 2);
    const id = draft.steps[0]?.id;
    draft = draftReducer(draft, {
      type: "patch-step",
      index: 0,
      patch: { promptTemplate: "go {{iterations}}", mode: "ask" },
    });
    expect(draft.steps[0]).toMatchObject({ id, promptTemplate: "go {{iterations}}", mode: "ask" });
    expect(draft.steps[1]?.promptTemplate).toBe("{{prevOutput}}");
  });

  it("reorders with move-step and ignores out-of-range moves", () => {
    let draft = draftWithSteps(undefined, 3);
    draft = draftReducer(draft, { type: "move-step", index: 2, dir: 1 }); // no-op at the edge
    expect(draft.steps.map((item) => item.name)).toEqual(["step-1", "step-2", "step-3"]);
    draft = draftReducer(draft, { type: "move-step", index: 2, dir: -1 });
    expect(draft.steps.map((item) => item.name)).toEqual(["step-1", "step-3", "step-2"]);
    draft = draftReducer(draft, { type: "move-step", index: 0, dir: -1 }); // no-op at the edge
    expect(draft.steps.map((item) => item.name)).toEqual(["step-1", "step-3", "step-2"]);
  });

  it("moveItem is pure", () => {
    const input = ["a", "b", "c"];
    expect(moveItem(input, 0, 1)).toEqual(["b", "a", "c"]);
    expect(input).toEqual(["a", "b", "c"]);
  });
});

describe("draftReducer loop bookkeeping", () => {
  it("deleting the loop-targeted step resets the loop config", () => {
    let draft = draftWithSteps({
      toStepIndex: 2,
      conditionType: "outputNotContains",
      pattern: "LGTM",
    });
    draft = draftReducer(draft, { type: "remove-step", index: 2 });
    expect(draft.steps).toHaveLength(2);
    expect(draft.loop).toEqual(createLoopDraft()); // fully reset, disabled
  });

  it("deleting a step before the target shifts the target down", () => {
    let draft = draftWithSteps({ toStepIndex: 2 });
    draft = draftReducer(draft, { type: "remove-step", index: 0 });
    expect(draft.loop.enabled).toBe(true);
    expect(draft.loop.toStepIndex).toBe(1);
  });

  it("deleting a step so the target becomes the first step resets the loop", () => {
    let draft = draftWithSteps({ toStepIndex: 1 }, 2);
    draft = draftReducer(draft, { type: "remove-step", index: 0 });
    expect(draft.loop.enabled).toBe(false);
  });

  it("moving steps keeps the loop pointed at the same step", () => {
    let draft = draftWithSteps({ toStepIndex: 2 }, 3); // targets step-3
    draft = draftReducer(draft, { type: "move-step", index: 2, dir: -1 }); // [1,3,2]
    expect(draft.loop.toStepIndex).toBe(1); // still step-3
  });

  it("moving the targeted step into first place resets the loop", () => {
    let draft = draftWithSteps({ toStepIndex: 1 }, 2); // targets step-2
    draft = draftReducer(draft, { type: "move-step", index: 1, dir: -1 }); // [2,1]
    expect(draft.loop.enabled).toBe(false);
  });

  it("enabling the loop clamps the target to the last step", () => {
    let draft = draftWithSteps({ enabled: false, toStepIndex: 9 }, 3);
    draft = draftReducer(draft, { type: "set-loop-enabled", enabled: true });
    expect(draft.loop.toStepIndex).toBe(2);
  });

  it("enabling the loop with a single step resets it instead", () => {
    let draft = createWorkflowDraft();
    draft = draftReducer(draft, { type: "set-loop-enabled", enabled: true });
    expect(draft.loop.enabled).toBe(false);
  });

  it("patch-loop merges fields", () => {
    let draft = draftWithSteps();
    draft = draftReducer(draft, {
      type: "patch-loop",
      patch: { conditionType: "outputMatches", regex: "LGTM", regexFlags: "i" },
    });
    expect(draft.loop).toMatchObject({
      conditionType: "outputMatches",
      regex: "LGTM",
      regexFlags: "i",
      maxIterations: 3,
    });
  });
});

describe("insertAtCursor", () => {
  it("inserts at the cursor and returns the new cursor", () => {
    expect(insertAtCursor("ab", "{{task}}", 1)).toEqual({ text: "a{{task}}b", cursor: 9 });
  });

  it("appends when the cursor is at the end", () => {
    expect(insertAtCursor("do: ", "{{prevOutput}}", 4)).toEqual({
      text: "do: {{prevOutput}}",
      cursor: 18,
    });
  });

  it("prepends at cursor 0 and clamps out-of-range cursors", () => {
    expect(insertAtCursor("x", "{{iterations}}", 0)).toEqual({
      text: "{{iterations}}x",
      cursor: 14,
    });
    expect(insertAtCursor("x", "{{task}}", 99)).toEqual({ text: "x{{task}}", cursor: 9 });
    expect(insertAtCursor("x", "{{task}}", -5)).toEqual({ text: "{{task}}x", cursor: 8 });
  });
});

describe("renderStepPreview", () => {
  it("renders task, prevOutput and iterations for the sample task", () => {
    const preview = renderStepPreview(
      "Task: {{task}}\nPrev: {{prevOutput}}\nPass: {{iterations}}",
      "write tests",
      { prevOutput: "OUT", iterations: 2 },
    );
    expect(preview.error).toBeUndefined();
    expect(preview.text).toBe("Task: write tests\nPrev: OUT\nPass: 2");
  });

  it("defaults prevOutput to the sample placeholder and iterations to 1", () => {
    const preview = renderStepPreview("{{prevOutput}} / {{iterations}}", "t");
    expect(preview.text).toBe("«output of the previous step» / 1");
  });

  it("turns unknown variables into an error", () => {
    const preview = renderStepPreview("{{nope}}", "t");
    expect(preview.text).toBeUndefined();
    expect(preview.error).toContain("Unknown prompt template variable");
  });
});

describe("regexIssue", () => {
  it("accepts valid patterns and flags", () => {
    expect(regexIssue("LGTM.*")).toBeNull();
    expect(regexIssue("lgtm", "i")).toBeNull();
  });

  it("rejects empty patterns and non-compiling regexes", () => {
    expect(regexIssue("")).toBe("Regex must be a non-empty string");
    expect(regexIssue("[unclosed")).toMatch(/regular expression/i);
    expect(regexIssue("a", "q")).toMatch(/flags/i);
  });
});

describe("draftToPayload", () => {
  it("omits blank optional fields and disabled loops", () => {
    const draft = draftWithSteps({ enabled: false });
    const payload = draftToPayload(draft);
    expect("loopBack" in payload).toBe(false);
    expect(payload.steps[0]).toEqual({
      id: draft.steps[0]?.id,
      name: "step-1",
      driver: "opencode",
      mode: "auto",
      promptTemplate: "{{task}}",
      continueSession: false,
    });
  });

  it("shapes every condition type", () => {
    const cases: Array<[Partial<LoopDraft>, ReturnType<typeof buildExitCondition>]> = [
      [{ conditionType: "always" }, { type: "always" }],
      [
        { conditionType: "outputContains", pattern: "ok" },
        { type: "outputContains", pattern: "ok" },
      ],
      [
        { conditionType: "outputNotContains", pattern: "no" },
        { type: "outputNotContains", pattern: "no" },
      ],
      [
        { conditionType: "outputMatches", regex: "r" },
        { type: "outputMatches", regex: "r" },
      ],
      [
        { conditionType: "outputMatches", regex: "r", regexFlags: "gi" },
        { type: "outputMatches", regex: "r", flags: "gi" },
      ],
    ];
    for (const [loopPatch, when] of cases) {
      expect(draftToPayload(draftWithSteps(loopPatch)).loopBack?.when).toEqual(when);
    }
  });

  it("includes trimmed model/agent when set", () => {
    const draft = draftWithSteps();
    draft.steps[0] = { ...draft.steps[0]!, model: " glm-4.6 ", agent: " build " };
    expect(draftToPayload(draft).steps[0]).toMatchObject({ model: "glm-4.6", agent: "build" });
  });
});

describe("validateDraft", () => {
  it("accepts a well-formed draft", () => {
    expect(validateDraft(draftWithSteps())).toEqual({});
  });

  it("flags an empty workflow name", () => {
    const errors = validateDraft({ ...draftWithSteps(), name: "" });
    expect(errors["name"]).toMatch(/non-empty/);
  });

  it("flags an empty prompt template", () => {
    const draft = draftWithSteps(undefined, 2);
    draft.steps[1] = { ...draft.steps[1]!, promptTemplate: "" };
    expect(validateDraft(draft)[stepFieldKey(1, "promptTemplate")]).toMatch(/non-empty/);
  });

  it("flags empty driver and bad mode", () => {
    const draft = draftWithSteps(undefined, 1);
    draft.steps[0] = { ...draft.steps[0]!, driver: "" };
    const errors = validateDraft(draft);
    expect(errors[stepFieldKey(0, "driver")]).toMatch(/non-empty/);
  });

  it("flags maxIterations below 1 and above the hard cap", () => {
    expect(validateDraft(draftWithSteps({ maxIterations: 0 }))["loopBack.maxIterations"]).toMatch(
      />= 1/,
    );
    expect(validateDraft(draftWithSteps({ maxIterations: 26 }))["loopBack.maxIterations"]).toMatch(
      /hard-capped at 25/,
    );
  });

  it("flags an invalid outputMatches regex on the regex field", () => {
    const errors = validateDraft(
      draftWithSteps({ conditionType: "outputMatches", regex: "[unclosed" }),
    );
    expect(errors["loopBack.when.regex"]).toMatch(/invalid regular expression/i);
  });

  it("flags an empty contains-pattern", () => {
    const errors = validateDraft(
      draftWithSteps({ conditionType: "outputNotContains", pattern: "" }),
    );
    expect(errors["loopBack.when.pattern"]).toMatch(/non-empty/);
  });

  it("flags a loopBack target outside the steps", () => {
    const errors = validateDraft(draftWithSteps({ toStepIndex: 5 }, 2));
    expect(errors["loopBack.toStepIndex"]).toMatch(/steps\.length/);
  });

  it("flags unknown template variables via the preview", () => {
    const draft = draftWithSteps(undefined, 1);
    draft.steps[0] = { ...draft.steps[0]!, promptTemplate: "{{typo}}" };
    expect(validateDraft(draft)[stepFieldKey(0, "promptTemplate")]).toContain(
      "Unknown prompt template variable",
    );
  });

  it("does not flag loop problems when the loop is disabled", () => {
    const draft = draftWithSteps({ enabled: false, conditionType: "outputMatches", regex: "[" });
    expect(validateDraft(draft)).toEqual({});
  });
});

describe("fieldErrorsFromApiError (daemon 422 mapping)", () => {
  it("maps zod detail paths to field keys", () => {
    const error = new ApiError("VALIDATION_ERROR", "boom", 422, {
      details: [
        { path: "steps.0.promptTemplate", message: "promptTemplate must be a non-empty string" },
        { path: "loopBack.maxIterations", message: "maxIterations must be an integer >= 1" },
      ],
    });
    expect(fieldErrorsFromApiError(error)).toEqual({
      "steps.0.promptTemplate": "promptTemplate must be a non-empty string",
      "loopBack.maxIterations": "maxIterations must be an integer >= 1",
    });
  });

  it("routes pathless refine issues to the loop regex field", () => {
    const error = new ApiError("VALIDATION_ERROR", "bad regex", 422, {
      details: [
        {
          path: "loopBack.when",
          message: "invalid regular expression: regex/flags do not compile",
        },
      ],
    });
    expect(fieldErrorsFromApiError(error, "outputMatches")).toEqual({
      "loopBack.when.regex": "invalid regular expression: regex/flags do not compile",
    });
    expect(fieldErrorsFromApiError(error, "outputNotContains")).toEqual({
      "loopBack.when.pattern": "invalid regular expression: regex/flags do not compile",
    });
  });

  it("returns nothing for errors without details", () => {
    expect(fieldErrorsFromApiError(new ApiError("HTTP_ERROR", "x", 500))).toEqual({});
    expect(fieldErrorsFromApiError(new Error("not an ApiError"))).toEqual({});
  });
});

describe("workflowToDraft round-trip", () => {
  it("restores drafts from a persisted workflow", () => {
    const payload = draftToPayload(
      draftWithSteps({ conditionType: "outputNotContains", pattern: "LGTM" }),
    );
    const workflow = WorkflowSchema.parse({
      id: "w1",
      projectId: "p1",
      ...payload,
    });
    const draft = workflowToDraft(workflow);
    expect(draft.name).toBe("review-loop");
    expect(draft.steps).toHaveLength(3);
    expect(draft.loop).toMatchObject({
      enabled: true,
      toStepIndex: 1,
      conditionType: "outputNotContains",
      pattern: "LGTM",
      maxIterations: 3,
    });
    expect(validateDraft(draft)).toEqual({});
  });
});

describe("implement → critique → fix loop (issue #17 checklist)", () => {
  it("builds the 3-step loop-back workflow via reducer logic and passes the core schema", () => {
    // Step 1: three steps — implement, critique, fix.
    let draft = createWorkflowDraft();
    draft = draftReducer(draft, { type: "rename", name: "implement-critique-fix" });

    const specs = [
      { name: "implement", prompt: "Implement the task: {{task}}" },
      { name: "critique", prompt: "Critique this diff:\n{{prevOutput}}" },
      { name: "fix", prompt: "Address the critique (pass {{iterations}}):\n{{prevOutput}}" },
    ];
    specs.forEach((spec, index) => {
      draft = draftReducer(draft, {
        type: "patch-step",
        index,
        patch: { name: spec.name, promptTemplate: spec.prompt },
      });
      if (index < specs.length - 1) draft = draftReducer(draft, { type: "add-step" });
    });

    // Step 2: loop back to the critique step until it stops saying LGTM.
    draft = draftReducer(draft, {
      type: "patch-loop",
      patch: {
        toStepIndex: 1,
        conditionType: "outputNotContains",
        pattern: "LGTM",
        maxIterations: 3,
      },
    });
    draft = draftReducer(draft, { type: "set-loop-enabled", enabled: true });

    const payload = draftToPayload(draft);
    expect(payload.name).toBe("implement-critique-fix");
    expect(payload.steps.map((step) => step.name)).toEqual(["implement", "critique", "fix"]);
    expect(payload.loopBack).toEqual({
      toStepIndex: 1,
      when: { type: "outputNotContains", pattern: "LGTM" },
      maxIterations: 3,
    });
    expect(validateDraft(draft)).toEqual({});

    // The exact body the UI would POST parses against the daemon's schema.
    const workflow = WorkflowSchema.parse({
      id: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      ...payload,
    });
    expect(workflow.loopBack?.when).toEqual({ type: "outputNotContains", pattern: "LGTM" });
  });
});
