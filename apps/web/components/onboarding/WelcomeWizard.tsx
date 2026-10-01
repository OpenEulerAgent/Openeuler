"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import type { Project } from "@openeuler/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { launchWizardWorkflow } from "@/lib/onboarding/launch";
import {
  WIZARD_STEPS,
  canContinue,
  continueBlockedReason,
  initialWizardState,
  markOnboardingCompleted,
  wizardReducer,
  wizardStepIndex,
} from "@/lib/onboarding/wizard";
import { STARTER_TEMPLATES } from "@/lib/onboarding/templates";
import {
  fetchSystemCheck,
  systemCheckRows,
  type SystemCheck,
  type SystemCheckRow,
} from "@/lib/system-check";

/**
 * Onboarding wizard (#53): environment check → open project → pick a starter
 * → launch the first run. All navigation logic lives in the headless reducer
 * (`@/lib/onboarding/wizard`); this component only renders and dispatches.
 */

const CHECK_POLL_INTERVAL_MS = 5000;

const STEP_LABELS: Record<(typeof WIZARD_STEPS)[number], string> = {
  environment: "Environment",
  project: "Project",
  template: "Starter",
  launch: "Launch",
};

const ROW_STATUS_BADGE: Record<
  SystemCheckRow["status"],
  { variant: "success" | "warning" | "danger"; label: string }
> = {
  ok: { variant: "success", label: "OK" },
  warn: { variant: "warning", label: "Warning" },
  error: { variant: "danger", label: "Missing" },
};

export function WelcomeWizard() {
  const router = useRouter();
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState);
  const [path, setPath] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const onEnvironmentStep = state.step === "environment";

  const loadCheck = useCallback(async (refresh = false): Promise<void> => {
    try {
      const check = await fetchSystemCheck(apiFetch, { refresh });
      dispatch({ type: "checkLoaded", check });
    } catch (cause) {
      dispatch({
        type: "checkFailed",
        message: cause instanceof ApiError ? cause.message : "Environment check failed",
      });
    }
  }, []);

  const loadProjects = useCallback(async (): Promise<void> => {
    try {
      const body = await apiFetch<{ projects: Project[] }>("/api/projects");
      dispatch({ type: "projectsLoaded", projects: body.projects });
    } catch {
      // The pick-list stays empty; opening a path still works.
    }
  }, []);

  // Initial load + light polling while the environment step is visible (the
  // daemon caches probes for 30s, so polling is cheap).
  useEffect(() => {
    void loadCheck();
    void loadProjects();
  }, [loadCheck, loadProjects]);

  useEffect(() => {
    if (!onEnvironmentStep) return;
    const timer = setInterval(() => void loadCheck(), CHECK_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [onEnvironmentStep, loadCheck]);

  useEffect(() => {
    if (state.step === "project") void loadProjects();
  }, [state.step, loadProjects]);

  const selectedProject = state.projects.find((project) => project.id === state.projectId) ?? null;

  const openProject = async () => {
    const trimmed = path.trim();
    if (trimmed.length === 0 || opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const body = await apiFetch<{ project: Project; warnings: string[] }>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: trimmed }),
      });
      dispatch({
        type: "projectOpened",
        projectId: body.project.id,
        warnings: body.warnings,
      });
      void loadProjects();
      if (body.warnings.length === 0) dispatch({ type: "next" });
    } catch (cause) {
      setOpenError(cause instanceof ApiError ? cause.message : "Failed to open project");
    } finally {
      setOpening(false);
    }
  };

  const skip = () => {
    markOnboardingCompleted(window.localStorage);
    router.push("/");
  };

  const launch = async () => {
    if (state.projectId === null || state.templateChoice === null || launching) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const outcome = await launchWizardWorkflow({
        projectId: state.projectId,
        choice: state.templateChoice,
        task: state.task,
      });
      markOnboardingCompleted(window.localStorage);
      router.push(`/runs/${outcome.runId}`);
    } catch (cause) {
      setLaunchError(cause instanceof ApiError ? cause.message : "Failed to launch the first run");
      setLaunching(false);
    }
  };

  const stepIndex = wizardStepIndex(state.step);
  const blockedReason = continueBlockedReason(state);
  const continueAllowed = canContinue(state);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6" data-testid="welcome-wizard">
      <div>
        <h1 className="text-display font-semibold text-fg">Welcome to Openeuler</h1>
        <p className="mt-1 text-sm text-muted-fg">
          From install to your first agent run in four steps — then the canvas is yours.
        </p>
      </div>

      <ol className="flex flex-wrap items-center gap-2" aria-label="Wizard steps">
        {WIZARD_STEPS.map((step, index) => {
          const current = index === stepIndex;
          const done = index < stepIndex;
          return (
            <li key={step} className="flex items-center gap-2">
              <span
                className={
                  "flex size-6 items-center justify-center rounded-full border text-xs font-medium " +
                  (current
                    ? "border-accent bg-accent text-accent-fg"
                    : done
                      ? "border-accent/60 bg-accent/20 text-fg"
                      : "border-border bg-elevated text-muted-fg")
                }
                aria-current={current ? "step" : undefined}
              >
                {done ? "✓" : index + 1}
              </span>
              <span className={"text-sm " + (current ? "font-medium text-fg" : "text-muted-fg")}>
                {STEP_LABELS[step]}
              </span>
              {index < WIZARD_STEPS.length - 1 ? (
                <span aria-hidden className="mx-1 text-muted-fg">
                  ·
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>

      <Card data-testid={`wizard-step-${state.step}`}>
        <CardContent className="flex flex-col gap-4">
          {state.step === "environment" ? (
            <EnvironmentStep state={state} onRecheck={() => void loadCheck(true)} />
          ) : null}

          {state.step === "project" ? (
            <ProjectStep
              state={state}
              path={path}
              setPath={setPath}
              opening={opening}
              openError={openError}
              onOpen={() => void openProject()}
              onSelect={(projectId) => dispatch({ type: "projectSelected", projectId })}
            />
          ) : null}

          {state.step === "template" ? (
            <TemplateStep
              choice={state.templateChoice}
              onChoose={(choice) => dispatch({ type: "templateChosen", choice })}
            />
          ) : null}

          {state.step === "launch" ? (
            <LaunchStep
              state={state}
              selectedProject={selectedProject}
              launching={launching}
              launchError={launchError}
              onTaskChange={(value) => dispatch({ type: "taskChanged", value })}
            />
          ) : null}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={skip} data-testid="wizard-skip">
          Skip setup
        </Button>
        <div className="flex items-center gap-2">
          {stepIndex > 0 ? (
            <Button
              variant="secondary"
              onClick={() => dispatch({ type: "back" })}
              data-testid="wizard-back"
            >
              Back
            </Button>
          ) : null}
          {state.step === "launch" ? (
            <Button
              onClick={() => void launch()}
              disabled={!continueAllowed || launching}
              loading={launching}
              data-testid="wizard-launch"
            >
              {launching ? "Launching…" : "Launch first run"}
            </Button>
          ) : (
            <Button
              onClick={() => dispatch({ type: "next" })}
              disabled={!continueAllowed}
              title={blockedReason ?? undefined}
              data-testid="wizard-continue"
            >
              Continue
            </Button>
          )}
        </div>
      </div>
      {state.step !== "launch" && blockedReason !== null ? (
        <p className="text-xs text-muted-fg" data-testid="wizard-blocked-reason">
          {blockedReason}
        </p>
      ) : null}
    </div>
  );
}

function EnvironmentStep({
  state,
  onRecheck,
}: {
  state: { check: SystemCheck | null; checkError: string | null };
  onRecheck: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-title font-semibold text-fg">Check your environment</h2>
        <p className="mt-0.5 text-sm text-muted-fg">
          git and a writable worktree store are required. A missing opencode CLI only warns —
          workflows can still run on the fake driver.
        </p>
      </div>
      {state.check === null ? (
        <p className="text-sm text-muted-fg" data-testid="env-check-loading">
          {state.checkError ?? "Checking git, opencode and the worktree store…"}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="env-check-rows">
          {systemCheckRows(state.check).map((row) => {
            const badge = ROW_STATUS_BADGE[row.status];
            return (
              <li
                key={row.id}
                className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2"
                data-testid={`env-check-${row.id}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-fg">{row.label}</span>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </span>
                <span className="font-mono text-xs text-muted-fg">{row.detail}</span>
                {row.hint ? <span className="text-xs text-warning">{row.hint}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
      {state.checkError !== null ? (
        <p className="text-sm text-danger" role="alert">
          {state.checkError}
        </p>
      ) : null}
      <div>
        <Button variant="secondary" size="sm" onClick={onRecheck} data-testid="env-recheck">
          Re-check
        </Button>
      </div>
    </div>
  );
}

function ProjectStep({
  state,
  path,
  setPath,
  opening,
  openError,
  onOpen,
  onSelect,
}: {
  state: { projects: Project[]; projectId: string | null; projectWarnings: string[] };
  path: string;
  setPath: (value: string) => void;
  opening: boolean;
  openError: string | null;
  onOpen: () => void;
  onSelect: (projectId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-title font-semibold text-fg">Open a project</h2>
        <p className="mt-0.5 text-sm text-muted-fg">
          Point Openeuler at a local git working copy (absolute path) — or pick one you already
          opened.
        </p>
      </div>
      <Field label="Repository path" htmlFor="wizard-project-path" error={openError ?? undefined}>
        <div className="flex flex-wrap gap-2">
          <Input
            id="wizard-project-path"
            type="text"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onOpen();
            }}
            placeholder="/absolute/path/to/repo"
            aria-label="Repository path"
            className="min-w-64 flex-1 font-mono"
            invalid={openError !== null}
            data-testid="wizard-project-path"
          />
          <Button onClick={onOpen} disabled={path.trim().length === 0 || opening} loading={opening}>
            {opening ? "Opening…" : "Open"}
          </Button>
        </div>
      </Field>
      {state.projectWarnings.length > 0 ? (
        <div
          className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning"
          data-testid="wizard-project-warnings"
        >
          {state.projectWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}
      {state.projects.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-fg">Existing projects</p>
          <ul className="flex flex-col gap-1" data-testid="wizard-project-list">
            {state.projects.map((project) => {
              const selected = project.id === state.projectId;
              return (
                <li key={project.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(project.id)}
                    aria-pressed={selected}
                    className={
                      "flex w-full flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
                      (selected
                        ? "border-accent bg-accent/10"
                        : "border-border bg-elevated hover:bg-surface")
                    }
                    data-testid={`wizard-project-option-${project.id}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-sm text-fg">
                        {project.path}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-fg">
                        {project.defaultBranch}
                        {project.dirty ? " · uncommitted changes" : ""}
                      </span>
                    </span>
                    {selected ? <Badge variant="accent">selected</Badge> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const BLANK_CARD = {
  id: "blank" as const,
  name: "Blank canvas",
  description:
    "Start from a single entry agent prompted with {{task}} and shape your own graph on the canvas.",
  highlights: ["One entry node, zero opinions", "The whole palette is yours"],
};

function TemplateStep({
  choice,
  onChoose,
}: {
  choice: string | null;
  onChoose: (choice: "implement-review-fix" | "feature-pipeline" | "blank") => void;
}) {
  const cards = [
    ...STARTER_TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      highlights: template.highlights,
    })),
    BLANK_CARD,
  ];
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-title font-semibold text-fg">Choose a starter</h2>
        <p className="mt-0.5 text-sm text-muted-fg">
          Templates are door-openers — every node, prompt and edge stays editable the moment the
          canvas opens.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3" data-testid="wizard-template-cards">
        {cards.map((card) => {
          const selected = card.id === choice;
          return (
            <button
              key={card.id}
              type="button"
              onClick={() =>
                onChoose(card.id as "implement-review-fix" | "feature-pipeline" | "blank")
              }
              aria-pressed={selected}
              className={
                "flex h-full flex-col gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
                (selected
                  ? "border-accent bg-accent/10"
                  : "border-border bg-elevated hover:bg-surface")
              }
              data-testid={`wizard-template-${card.id}`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-fg">{card.name}</span>
                {selected ? <Badge variant="accent">selected</Badge> : null}
              </span>
              <span className="text-xs text-muted-fg">{card.description}</span>
              <span className="mt-auto flex flex-col gap-1 pt-2">
                {card.highlights.map((highlight) => (
                  <span key={highlight} className="text-xs text-muted-fg">
                    · {highlight}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LaunchStep({
  state,
  selectedProject,
  launching,
  launchError,
  onTaskChange,
}: {
  state: { task: string; templateChoice: string | null };
  selectedProject: Project | null;
  launching: boolean;
  launchError: string | null;
  onTaskChange: (value: string) => void;
}) {
  const templateName =
    state.templateChoice === "blank" || state.templateChoice === null
      ? BLANK_CARD.name
      : (STARTER_TEMPLATES.find((template) => template.id === state.templateChoice)?.name ??
        BLANK_CARD.name);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-title font-semibold text-fg">Launch your first run</h2>
        <p className="mt-0.5 text-sm text-muted-fg">
          The starter becomes a workflow you can edit immediately; the run executes it in an
          isolated worktree.
        </p>
      </div>
      <dl className="grid gap-2 rounded-md border border-border bg-elevated px-3 py-2 text-sm sm:grid-cols-2">
        <div className="flex flex-col">
          <dt className="text-xs text-muted-fg">Project</dt>
          <dd className="truncate font-mono text-fg" data-testid="launch-project">
            {selectedProject?.path ?? "—"}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-muted-fg">Starter</dt>
          <dd className="text-fg" data-testid="launch-template">
            {templateName}
          </dd>
        </div>
      </dl>
      <Field
        label="Task"
        hint="passed to the workflow as {{task}}"
        htmlFor="wizard-task"
        error={launchError ?? undefined}
      >
        <Textarea
          id="wizard-task"
          rows={4}
          autoFocus
          value={state.task}
          onChange={(event) => onTaskChange(event.target.value)}
          placeholder="e.g. Add a --verbose flag to the CLI and document it"
          data-testid="wizard-task"
        />
      </Field>
      <p className="text-xs text-muted-fg">
        After launch you land on the live run view; the workflow itself is one click away on the
        canvas.
      </p>
      {launching ? (
        <p className="text-sm text-muted-fg">Creating workflow and queueing the run…</p>
      ) : null}
    </div>
  );
}
