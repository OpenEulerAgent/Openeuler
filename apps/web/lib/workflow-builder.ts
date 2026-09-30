import {
  WorkflowShapeSchema,
  loopBackToStepIndexIssue,
  renderPromptTemplate,
  type ExitCondition,
  type LoopBack,
  type Step,
  type Step as WorkflowStep,
  type Workflow,
} from "@openeuler/core";
import { ApiError } from "./api";

/**
 * Pure state + logic for the workflow builder form. Deliberately free of React
 * and fetch so every rule (step CRUD, loop bookkeeping, validation, payload
 * shaping, preview) is unit-testable without a browser.
 */

export type StepMode = "auto" | "ask";

export type ConditionType = "always" | "outputContains" | "outputNotContains" | "outputMatches";

export const CONDITION_TYPES: ReadonlyArray<{ id: ConditionType; label: string }> = [
  { id: "always", label: "Always loop" },
  { id: "outputContains", label: "Output contains" },
  { id: "outputNotContains", label: "Output does not contain" },
  { id: "outputMatches", label: "Output matches regex" },
];

/** Hard cap on loop iterations (UI hint + client-side validation). */
export const MAX_LOOP_ITERATIONS = 25;

/** Driver dropdown fallback when `GET /api/drivers` is unreachable or empty. */
export const DEFAULT_DRIVER_IDS: readonly string[] = ["opencode"];

export const DEFAULT_DRIVER_ID = "opencode";

/** Default task used for the live prompt preview (editable in the editor). */
export const DEFAULT_SAMPLE_TASK = "Add a README section describing the CLI flags";

/** Placeholder shown for `{{prevOutput}}` in the preview (empty on step 1). */
export const SAMPLE_PREV_OUTPUT = "«output of the previous step»";

export const TEMPLATE_VARIABLE_TOKENS = ["{{task}}", "{{prevOutput}}", "{{iterations}}"] as const;

/** Editable form representation of a single step (all fields as raw strings). */
export interface StepDraft {
  id: string;
  name: string;
  driver: string;
  model: string;
  agent: string;
  mode: StepMode;
  promptTemplate: string;
  continueSession: boolean;
}

/** Editable form representation of the loop-back configuration. */
export interface LoopDraft {
  enabled: boolean;
  /** Index of the step to jump back to; UI only offers steps after the first. */
  toStepIndex: number;
  conditionType: ConditionType;
  /** Substring for outputContains / outputNotContains. */
  pattern: string;
  /** Source + flags for outputMatches. */
  regex: string;
  regexFlags: string;
  maxIterations: number;
}

/** Whole-form state for the editor. */
export interface WorkflowDraft {
  name: string;
  steps: StepDraft[];
  loop: LoopDraft;
}

export function newStepId(): string {
  return crypto.randomUUID();
}

export function createStepDraft(overrides: Partial<Omit<StepDraft, "id">> = {}): StepDraft {
  return {
    id: newStepId(),
    name: "",
    driver: DEFAULT_DRIVER_ID,
    model: "",
    agent: "",
    mode: "auto",
    promptTemplate: "",
    continueSession: false,
    ...overrides,
  };
}

export function createLoopDraft(overrides: Partial<LoopDraft> = {}): LoopDraft {
  return {
    enabled: false,
    toStepIndex: 1,
    conditionType: "always",
    pattern: "",
    regex: "",
    regexFlags: "",
    maxIterations: 3,
    ...overrides,
  };
}

/** Draft for a brand-new workflow: one empty step, loop disabled. */
export function createWorkflowDraft(): WorkflowDraft {
  return {
    name: "",
    steps: [createStepDraft()],
    loop: createLoopDraft(),
  };
}

/** Draft pre-filled from a persisted workflow (edit mode). */
export function workflowToDraft(workflow: Workflow): WorkflowDraft {
  return {
    name: workflow.name,
    steps: workflow.steps.map((step) => ({
      id: step.id,
      name: step.name,
      driver: step.driver,
      model: step.model ?? "",
      agent: step.agent ?? "",
      mode: step.mode,
      promptTemplate: step.promptTemplate,
      continueSession: step.continueSession,
    })),
    loop: workflow.loopBack
      ? createLoopDraft({
          enabled: true,
          toStepIndex: workflow.loopBack.toStepIndex,
          maxIterations: workflow.loopBack.maxIterations,
          ...conditionToDraft(workflow.loopBack.when),
        })
      : createLoopDraft(),
  };
}

function conditionToDraft(when: ExitCondition): Partial<LoopDraft> {
  switch (when.type) {
    case "always":
      return { conditionType: "always" };
    case "outputContains":
      return { conditionType: "outputContains", pattern: when.pattern };
    case "outputNotContains":
      return { conditionType: "outputNotContains", pattern: when.pattern };
    case "outputMatches":
      return { conditionType: "outputMatches", regex: when.regex, regexFlags: when.flags ?? "" };
  }
}

export type DraftAction =
  | { type: "rename"; name: string }
  | { type: "add-step"; step?: StepDraft }
  | { type: "remove-step"; index: number }
  | { type: "move-step"; index: number; dir: -1 | 1 }
  | { type: "patch-step"; index: number; patch: Partial<Omit<StepDraft, "id">> }
  | { type: "set-loop-enabled"; enabled: boolean }
  | { type: "patch-loop"; patch: Partial<LoopDraft> };

/** Rewrite `steps` with `index` swapped with its neighbour in `dir`. */
export function moveItem<T>(steps: readonly T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir;
  if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) {
    return [...steps];
  }
  const next = [...steps];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as T);
  return next;
}

/**
 * Loop bookkeeping when a step is removed: deleting the step the loop targets
 * resets the whole loop config; deleting an earlier step shifts the target
 * down (resetting too if it would land on the first step).
 */
function loopAfterRemoval(loop: LoopDraft, steps: StepDraft[], index: number): LoopDraft {
  if (!loop.enabled) return loop;
  if (loop.toStepIndex === index) return createLoopDraft();
  if (loop.toStepIndex > index) {
    const toStepIndex = loop.toStepIndex - 1;
    if (toStepIndex < 1) return createLoopDraft();
    return { ...loop, toStepIndex };
  }
  return clampLoopTarget(loop, steps);
}

/**
 * Loop bookkeeping when steps move: keep pointing at the same step identity;
 * reset the config if that step becomes the first one (invalid target).
 */
function loopAfterMove(loop: LoopDraft, steps: StepDraft[], before: StepDraft[]): LoopDraft {
  if (!loop.enabled) return loop;
  const target = before[loop.toStepIndex];
  const nextIndex = target ? steps.findIndex((step) => step.id === target.id) : -1;
  if (nextIndex < 1) return createLoopDraft();
  return { ...loop, toStepIndex: nextIndex };
}

function clampLoopTarget(loop: LoopDraft, steps: StepDraft[]): LoopDraft {
  if (!loop.enabled) return loop;
  const maxIndex = steps.length - 1;
  if (maxIndex < 1) return createLoopDraft();
  return { ...loop, toStepIndex: Math.min(loop.toStepIndex, maxIndex) };
}

/** Reducer driving the whole editor form; every mutation keeps the loop sane. */
export function draftReducer(state: WorkflowDraft, action: DraftAction): WorkflowDraft {
  switch (action.type) {
    case "rename":
      return { ...state, name: action.name };
    case "add-step":
      return {
        ...state,
        steps: [...state.steps, action.step ?? createStepDraft()],
      };
    case "remove-step": {
      if (state.steps.length <= 1) return state;
      const steps = state.steps.filter((_, index) => index !== action.index);
      return { ...state, steps, loop: loopAfterRemoval(state.loop, steps, action.index) };
    }
    case "move-step": {
      const steps = moveItem(state.steps, action.index, action.dir);
      return { ...state, steps, loop: loopAfterMove(state.loop, steps, state.steps) };
    }
    case "patch-step":
      return {
        ...state,
        steps: state.steps.map((step, index) =>
          index === action.index ? { ...step, ...action.patch } : step,
        ),
      };
    case "set-loop-enabled":
      return {
        ...state,
        loop: clampLoopTarget({ ...state.loop, enabled: action.enabled }, state.steps),
      };
    case "patch-loop":
      return { ...state, loop: { ...state.loop, ...action.patch } };
  }
}

/** Insert `token` (e.g. `{{task}}`) into `text` at `cursor`; returns the new cursor. */
export function insertAtCursor(
  text: string,
  token: string,
  cursor: number,
): { text: string; cursor: number } {
  const clamped = Math.max(0, Math.min(cursor, text.length));
  const next = text.slice(0, clamped) + token + text.slice(clamped);
  return { text: next, cursor: clamped + token.length };
}

export interface PromptPreview {
  text?: string;
  error?: string;
}

/** Render the live preview for a sample task; unknown variables become errors. */
export function renderStepPreview(
  template: string,
  sampleTask: string,
  options: { prevOutput?: string; iterations?: number } = {},
): PromptPreview {
  try {
    return {
      text: renderPromptTemplate(template, {
        task: sampleTask,
        prevOutput: options.prevOutput ?? SAMPLE_PREV_OUTPUT,
        iterations: options.iterations ?? 1,
      }),
    };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Try compiling `regex` with `flags`; returns the problem, or null when valid. */
export function regexIssue(regex: string, flags = ""): string | null {
  if (regex.length === 0) return "Regex must be a non-empty string";
  try {
    new RegExp(regex, flags);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** Shape the loop draft into the API's `when` condition (passthrough; zod validates). */
export function buildExitCondition(loop: LoopDraft): ExitCondition {
  switch (loop.conditionType) {
    case "always":
      return { type: "always" };
    case "outputContains":
      return { type: "outputContains", pattern: loop.pattern };
    case "outputNotContains":
      return { type: "outputNotContains", pattern: loop.pattern };
    case "outputMatches":
      return {
        type: "outputMatches",
        regex: loop.regex,
        ...(loop.regexFlags.length === 0 ? {} : { flags: loop.regexFlags }),
      };
  }
}

/** Steps of the draft as API-shaped `Step` objects (blank optionals omitted). */
export function draftSteps(steps: readonly StepDraft[]): WorkflowStep[] {
  return steps.map((step) => ({
    id: step.id,
    name: step.name,
    driver: step.driver,
    mode: step.mode,
    promptTemplate: step.promptTemplate,
    continueSession: step.continueSession,
    ...(step.model.trim().length === 0 ? {} : { model: step.model.trim() }),
    ...(step.agent.trim().length === 0 ? {} : { agent: step.agent.trim() }),
  }));
}

export interface WorkflowPayload {
  name: string;
  steps: Step[];
  loopBack?: LoopBack;
}

/**
 * Draft → request body for POST/PATCH. Passthrough: invalid values (empty
 * prompt, maxIterations 0, …) survive so {@link validateDraft}/the server can
 * flag them. `loopBack` is omitted when the loop is disabled; PATCH callers
 * turn that into `null` to clear a stored loop.
 */
export function draftToPayload(draft: WorkflowDraft): WorkflowPayload {
  return {
    name: draft.name,
    steps: draftSteps(draft.steps),
    ...(draft.loop.enabled
      ? {
          loopBack: {
            toStepIndex: draft.loop.toStepIndex,
            when: buildExitCondition(draft.loop),
            maxIterations: draft.loop.maxIterations,
          },
        }
      : {}),
  };
}

const DraftWorkflowBodySchema = WorkflowShapeSchema.omit({ id: true, projectId: true }).superRefine(
  (body, ctx) => {
    const issue = loopBackToStepIndexIssue(body);
    if (issue !== undefined) {
      ctx.addIssue({ code: "custom", path: ["loopBack", "toStepIndex"], message: issue });
    }
  },
);

/** Field path (dot-joined, same format as daemon 422 `details`) → message. */
export type FieldErrors = Record<string, string>;

export const stepFieldKey = (index: number, field: keyof Omit<StepDraft, "id">): string =>
  `steps.${index}.${field}`;

/**
 * Field key that best matches a condition-level problem: the pattern input
 * for substring conditions, the regex input for outputMatches.
 */
export function conditionFieldKey(conditionType: ConditionType): string {
  if (conditionType === "outputContains" || conditionType === "outputNotContains") {
    return "loopBack.when.pattern";
  }
  if (conditionType === "outputMatches") return "loopBack.when.regex";
  return "loopBack.when";
}

/**
 * Client-side validation reusing the daemon's zod schemas, plus UI-only rules
 * (unknown template variables, the 25-iteration hard cap, regex feedback).
 */
export function validateDraft(draft: WorkflowDraft): FieldErrors {
  const errors: FieldErrors = {};
  const payload = draftToPayload(draft);

  const result = DraftWorkflowBodySchema.safeParse(payload);
  if (!result.success) {
    for (const issue of result.error.issues) {
      let key = issue.path.map(String).join(".");
      if (key.length === 0) key = "form";
      // Condition-level refine failures carry no deeper path; point them at
      // the input the user is editing (pattern or regex).
      if (key === "loopBack.when") key = conditionFieldKey(draft.loop.conditionType);
      if (errors[key] === undefined) errors[key] = issue.message;
    }
  }

  draft.steps.forEach((step, index) => {
    const preview = renderStepPreview(step.promptTemplate, "");
    if (
      preview.error !== undefined &&
      errors[stepFieldKey(index, "promptTemplate")] === undefined
    ) {
      errors[stepFieldKey(index, "promptTemplate")] = preview.error;
    }
  });

  if (
    draft.loop.enabled &&
    Number.isFinite(draft.loop.maxIterations) &&
    draft.loop.maxIterations > MAX_LOOP_ITERATIONS
  ) {
    errors["loopBack.maxIterations"] ??= `maxIterations is hard-capped at ${MAX_LOOP_ITERATIONS}`;
  }

  return errors;
}

/**
 * Map a daemon 422 (zod `error.details`) onto field errors. Keys are the same
 * dot-joined paths {@link validateDraft} produces, so one lookup covers both.
 * Condition-level paths are re-routed to the input for the current condition
 * type when the caller provides it.
 */
export function fieldErrorsFromApiError(
  error: unknown,
  conditionType?: ConditionType,
): FieldErrors {
  if (!(error instanceof ApiError) || error.details === undefined) return {};
  const errors: FieldErrors = {};
  for (const detail of error.details) {
    let path = detail.path;
    if (path === "loopBack.when" && conditionType !== undefined) {
      path = conditionFieldKey(conditionType);
    }
    if (errors[path] === undefined) errors[path] = detail.message;
  }
  return errors;
}

/** LoopDraft field → field-error key it addresses. */
const LOOP_ERROR_KEYS: Record<keyof LoopDraft, string> = {
  enabled: "loopBack.when",
  toStepIndex: "loopBack.toStepIndex",
  conditionType: "loopBack.when",
  pattern: "loopBack.when.pattern",
  regex: "loopBack.when.regex",
  regexFlags: "loopBack.when.flags",
  maxIterations: "loopBack.maxIterations",
};

function omitErrors(errors: FieldErrors, keys: readonly string[]): FieldErrors {
  let next: FieldErrors | null = null;
  for (const key of keys) {
    if (key in errors) {
      next ??= { ...errors };
      delete next[key];
    }
  }
  return next ?? errors;
}

function omitErrorsWhere(errors: FieldErrors, stale: (key: string) => boolean): FieldErrors {
  return omitErrors(errors, Object.keys(errors).filter(stale));
}

/**
 * Field errors made stale by a draft action: structural changes (add, remove,
 * reorder) drop every index-keyed step error — kept around, those would shift
 * onto the wrong steps — while renames/patches clear only the fields they
 * touch. Returns the same object when nothing is stale.
 */
export function errorsAfterAction(errors: FieldErrors, action: DraftAction): FieldErrors {
  switch (action.type) {
    case "rename":
      return omitErrors(errors, ["name"]);
    case "add-step":
    case "remove-step":
    case "move-step":
      return omitErrorsWhere(errors, (key) => key.startsWith("steps."));
    case "patch-step":
      return omitErrors(
        errors,
        (Object.keys(action.patch) as Array<keyof Omit<StepDraft, "id">>).map((field) =>
          stepFieldKey(action.index, field),
        ),
      );
    case "set-loop-enabled":
      return omitErrorsWhere(errors, (key) => key.startsWith("loopBack."));
    case "patch-loop":
      return omitErrors(
        errors,
        (Object.keys(action.patch) as Array<keyof LoopDraft>).map(
          (field) => LOOP_ERROR_KEYS[field],
        ),
      );
  }
}
