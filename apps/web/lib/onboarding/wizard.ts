import type { Project, Workflow } from "@openeuler/core";
import type { SystemCheck } from "@/lib/system-check";
import type { StarterTemplateId } from "./templates";

/**
 * Onboarding wizard state machine (#53) — pure, headless-testable. The React
 * component is a thin skin: it dispatches actions and renders the step.
 *
 * Step 1 environment → step 2 project → step 3 starter → step 4 launch.
 * Skippable everywhere; completion is remembered in localStorage so the
 * wizard never nags (re-run is explicit from Settings).
 */

export const WIZARD_STEPS = ["environment", "project", "template", "launch"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Step 3 choice: one of the two starters, or a blank canvas. */
export type TemplateChoice = StarterTemplateId | "blank";

export interface WizardState {
  step: WizardStep;
  check: SystemCheck | null;
  checkError: string | null;
  projects: Project[];
  /** Project opened/selected in step 2 (null until chosen). */
  projectId: string | null;
  /** Warnings from POST /api/projects (e.g. empty repo) surfaced before continuing. */
  projectWarnings: string[];
  templateChoice: TemplateChoice | null;
  task: string;
  /** Set by the skip action; the component marks completion and navigates. */
  skipped: boolean;
}

export const initialWizardState: WizardState = {
  step: "environment",
  check: null,
  checkError: null,
  projects: [],
  projectId: null,
  projectWarnings: [],
  templateChoice: null,
  task: "",
  skipped: false,
};

export type WizardAction =
  | { type: "checkLoaded"; check: SystemCheck }
  | { type: "checkFailed"; message: string }
  | { type: "projectsLoaded"; projects: Project[] }
  | { type: "projectOpened"; projectId: string; warnings?: string[] }
  | { type: "projectSelected"; projectId: string }
  | { type: "templateChosen"; choice: TemplateChoice }
  | { type: "taskChanged"; value: string }
  | { type: "next" }
  | { type: "back" }
  | { type: "skip" };

export function wizardStepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

function stepAfter(step: WizardStep, delta: number): WizardStep {
  const next = Math.min(WIZARD_STEPS.length - 1, Math.max(0, wizardStepIndex(step) + delta));
  return WIZARD_STEPS[next] as WizardStep;
}

/**
 * Whether "Continue" is enabled on the current step:
 * environment requires git (and a reachable check); project requires a
 * project; template requires a choice; launch requires a task. opencode
 * problems never block — they warn that only the fake driver will work.
 */
export function canContinue(state: WizardState): boolean {
  switch (state.step) {
    case "environment":
      return state.check !== null && state.check.git.ok && state.check.worktrees.ok;
    case "project":
      return state.projectId !== null;
    case "template":
      return state.templateChoice !== null;
    case "launch":
      return state.task.trim().length > 0;
  }
}

/** The user-facing reason Continue is disabled (null when it isn't). */
export function continueBlockedReason(state: WizardState): string | null {
  if (canContinue(state)) return null;
  switch (state.step) {
    case "environment":
      if (state.check === null) return "Waiting for the environment check…";
      if (!state.check.git.ok) return "git is required — install it, then re-check";
      return "The worktree store must be writable — fix OPENEULER_WORKTREES, then re-check";
    case "project":
      return "Open a local git repository or pick an existing project first";
    case "template":
      return "Choose how to start — a starter template or a blank canvas";
    case "launch":
      return "Describe the task for the first run";
  }
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "checkLoaded":
      return { ...state, check: action.check, checkError: null };
    case "checkFailed":
      return { ...state, checkError: action.message };
    case "projectsLoaded":
      return { ...state, projects: action.projects };
    case "projectOpened":
      return {
        ...state,
        projectId: action.projectId,
        projectWarnings: action.warnings ?? [],
      };
    case "projectSelected":
      return { ...state, projectId: action.projectId, projectWarnings: [] };
    case "templateChosen":
      return { ...state, templateChoice: action.choice };
    case "taskChanged":
      return { ...state, task: action.value };
    case "next":
      return canContinue(state) ? { ...state, step: stepAfter(state.step, 1) } : state;
    case "back":
      return { ...state, step: stepAfter(state.step, -1) };
    case "skip":
      return { ...state, skipped: true };
  }
}

// ---------------------------------------------------------------------------
// Fresh-install detection + completion persistence.
//

/**
 * Fresh install = no projects AND no workflows (checked via
 * GET /api/projects + the workflows list).
 */
export function isFreshInstall(
  projects: readonly Project[],
  workflows: readonly Workflow[],
): boolean {
  return projects.length === 0 && workflows.length === 0;
}

export const ONBOARDING_COMPLETED_KEY = "onboarding.completed";

/** Storage-shaped dependency so tests can pass a plain Map adapter. */
type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem" | "removeItem">;

export function isOnboardingCompleted(storage: ReadableStorage | null | undefined): boolean {
  try {
    return storage?.getItem(ONBOARDING_COMPLETED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Remembers completion so the wizard auto-start never nags again. */
export function markOnboardingCompleted(storage: WritableStorage | null | undefined): void {
  try {
    storage?.setItem(ONBOARDING_COMPLETED_KEY, "true");
  } catch {
    // Private mode / disabled storage: auto-start may re-trigger; harmless.
  }
}

export function clearOnboardingCompleted(storage: WritableStorage | null | undefined): void {
  try {
    storage?.removeItem(ONBOARDING_COMPLETED_KEY);
  } catch {
    // Ignore.
  }
}
