import { describe, expect, it } from "vitest";
import type { Project, Workflow } from "@openeuler/core";
import type { SystemCheck } from "@/lib/system-check";
import {
  ONBOARDING_COMPLETED_KEY,
  WIZARD_STEPS,
  canContinue,
  clearOnboardingCompleted,
  continueBlockedReason,
  initialWizardState,
  isFreshInstall,
  isOnboardingCompleted,
  markOnboardingCompleted,
  wizardReducer,
  type WizardState,
} from "@/lib/onboarding/wizard";

const healthyCheck: SystemCheck = {
  git: { ok: true, version: "2.43.0" },
  opencode: { ok: true, version: "1.18.34", authenticated: true },
  worktrees: { ok: true, path: "/tmp/worktrees" },
};

const project = (id: string): Project => ({
  id,
  path: `/repos/${id}`,
  name: id,
  defaultBranch: "main",
  dirty: false,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const workflow = (id: string): Workflow => ({
  id,
  projectId: "p1",
  name: id,
  steps: [
    {
      id: "s1",
      name: "s1",
      driver: "fake",
      mode: "auto",
      promptTemplate: "{{task}}",
      continueSession: false,
    },
  ],
  latestRevisionNumber: 1,
});

/** Drives the reducer through a sequence of actions, returning the final state. */
const drive = (actions: Parameters<typeof wizardReducer>[1][], from?: WizardState): WizardState =>
  actions.reduce((state, action) => wizardReducer(state, action), from ?? initialWizardState);

describe("wizard step order", () => {
  it("walks environment → project → template → launch and back", () => {
    expect(WIZARD_STEPS).toEqual(["environment", "project", "template", "launch"]);

    const state = drive([
      { type: "checkLoaded", check: healthyCheck },
      { type: "next" },
      { type: "projectOpened", projectId: "p1" },
      { type: "next" },
      { type: "templateChosen", choice: "feature-pipeline" },
      { type: "next" },
      { type: "taskChanged", value: "ship it" },
      { type: "next" },
    ]);
    expect(state.step).toBe("launch");

    const backtracked = drive([{ type: "back" }, { type: "back" }], state);
    expect(backtracked.step).toBe("project");
    // Back past the first step stays on the first step.
    const floored = drive([{ type: "back" }, { type: "back" }, { type: "back" }], backtracked);
    expect(floored.step).toBe("environment");
  });

  it("next is a no-op until the current step's gate is met", () => {
    const gated = drive([{ type: "checkLoaded", check: healthyCheck }, { type: "next" }]);
    // No project chosen yet.
    expect(wizardReducer(gated, { type: "next" }).step).toBe("project");
    // Template choice missing.
    const withProject = drive(
      [{ type: "projectOpened", projectId: "p1" }, { type: "next" }],
      gated,
    );
    expect(wizardReducer(withProject, { type: "next" }).step).toBe("template");
    // Task missing.
    const withTemplate = drive(
      [{ type: "templateChosen", choice: "blank" }, { type: "next" }],
      withProject,
    );
    expect(wizardReducer(withTemplate, { type: "next" }).step).toBe("launch");
  });
});

describe("environment gate", () => {
  it("blocks continue while the check has not loaded", () => {
    expect(canContinue(initialWizardState)).toBe(false);
    expect(continueBlockedReason(initialWizardState)).toContain("Waiting");
    expect(wizardReducer(initialWizardState, { type: "next" })).toBe(initialWizardState);
  });

  it("blocks continue when git is missing (git is a hard requirement)", () => {
    const state = wizardReducer(initialWizardState, {
      type: "checkLoaded",
      check: {
        git: { ok: false, hint: "install git" },
        opencode: { ok: false, hint: "install opencode" },
        worktrees: { ok: true, path: "/tmp/w" },
      },
    });
    expect(canContinue(state)).toBe(false);
    expect(continueBlockedReason(state)).toContain("git is required");
    expect(wizardReducer(state, { type: "next" })).toBe(state);
  });

  it("allows continue past opencode warnings (missing CLI or missing auth)", () => {
    const missingCli = wizardReducer(initialWizardState, {
      type: "checkLoaded",
      check: {
        git: { ok: true, version: "2.43.0" },
        opencode: { ok: false, hint: "install it" },
        worktrees: { ok: true, path: "/tmp/w" },
      },
    });
    expect(canContinue(missingCli)).toBe(true);

    const unauthenticated = wizardReducer(initialWizardState, {
      type: "checkLoaded",
      check: {
        git: { ok: true, version: "2.43.0" },
        opencode: {
          ok: true,
          version: "1.0.0",
          authenticated: false,
          hint: "Run: opencode auth login",
        },
        worktrees: { ok: true, path: "/tmp/w" },
      },
    });
    expect(canContinue(unauthenticated)).toBe(true);
  });

  it("blocks continue when the worktree store is unwritable", () => {
    const state = wizardReducer(initialWizardState, {
      type: "checkLoaded",
      check: {
        git: { ok: true },
        opencode: { ok: true, authenticated: true },
        worktrees: { ok: false, path: "/nope" },
      },
    });
    expect(canContinue(state)).toBe(false);
    expect(continueBlockedReason(state)).toContain("worktree store");
  });

  it("records check failures without unblocking the gate", () => {
    const state = wizardReducer(initialWizardState, {
      type: "checkFailed",
      message: "daemon unreachable",
    });
    expect(state.checkError).toBe("daemon unreachable");
    expect(canContinue(state)).toBe(false);
  });
});

describe("project + template steps", () => {
  it("stores opened-project warnings (empty-repo) and clears them on selection", () => {
    const opened = drive([
      { type: "checkLoaded", check: healthyCheck },
      { type: "next" },
      {
        type: "projectOpened",
        projectId: "p1",
        warnings: ["repository has no commits yet"],
      },
    ]);
    expect(opened.projectId).toBe("p1");
    expect(opened.projectWarnings).toEqual(["repository has no commits yet"]);
    expect(canContinue(opened)).toBe(true);

    const selected = wizardReducer(opened, { type: "projectSelected", projectId: "p2" });
    expect(selected.projectId).toBe("p2");
    expect(selected.projectWarnings).toEqual([]);
  });

  it("tracks the chosen starter (including blank)", () => {
    let state = drive([
      { type: "checkLoaded", check: healthyCheck },
      { type: "next" },
      { type: "projectOpened", projectId: "p1" },
      { type: "next" },
    ]);
    expect(canContinue(state)).toBe(false);
    state = wizardReducer(state, { type: "templateChosen", choice: "implement-review-fix" });
    expect(canContinue(state)).toBe(true);
    state = wizardReducer(state, { type: "templateChosen", choice: "blank" });
    expect(state.templateChoice).toBe("blank");
  });
});

describe("skip", () => {
  it("marks the wizard skipped from any step", () => {
    const state = drive([{ type: "checkLoaded", check: healthyCheck }, { type: "skip" }]);
    expect(state.skipped).toBe(true);
    expect(wizardReducer(initialWizardState, { type: "skip" }).skipped).toBe(true);
  });
});

describe("fresh-install detection", () => {
  it("is fresh only with no projects AND no workflows", () => {
    expect(isFreshInstall([], [])).toBe(true);
    expect(isFreshInstall([project("p1")], [])).toBe(false);
    expect(isFreshInstall([], [workflow("w1")])).toBe(false);
    expect(isFreshInstall([project("p1")], [workflow("w1")])).toBe(false);
  });
});

describe("completion persistence", () => {
  it("remembers completion under the onboarding.completed flag", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
    };

    expect(isOnboardingCompleted(storage)).toBe(false);
    markOnboardingCompleted(storage);
    expect(isOnboardingCompleted(storage)).toBe(true);
    expect(backing.get(ONBOARDING_COMPLETED_KEY)).toBe("true");

    clearOnboardingCompleted(storage);
    expect(isOnboardingCompleted(storage)).toBe(false);
  });

  it("tolerates absent and throwing storages", () => {
    expect(isOnboardingCompleted(undefined)).toBe(false);
    markOnboardingCompleted(null);
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(isOnboardingCompleted(throwing)).toBe(false);
    expect(() => markOnboardingCompleted(throwing)).not.toThrow();
  });
});
