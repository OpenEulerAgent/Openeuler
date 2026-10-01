import type { WorkflowGraphShape } from "@openeuler/core";
import { ApiError } from "@/lib/api";
import { starterGraph } from "@/lib/graph/canvas-document";
import {
  createWorkflowWithGraph,
  startWorkflowRun,
  type WorkflowFetcher,
} from "@/lib/workflows-api";
import { findStarterTemplate, type StarterTemplateId } from "./templates";

/**
 * Wizard launch flow (#53): materialize the chosen starter (or a blank
 * canvas) as a real workflow (revision 1 snapshots the graph), then queue
 * the first run and land the user on the run detail page. Injectable
 * transport keeps the whole flow headless-testable.
 */

export type LaunchChoice = StarterTemplateId | "blank";

export interface WizardLaunchOutcome {
  workflowId: string;
  workflowName: string;
  runId: string;
}

/** Default workflow name for a wizard choice. */
export function workflowNameForChoice(choice: LaunchChoice): string {
  if (choice === "blank") return "My workflow";
  return findStarterTemplate(choice)?.workflowName ?? "Starter workflow";
}

/** The graph a wizard choice materializes as. */
export function graphForChoice(choice: LaunchChoice): WorkflowGraphShape {
  if (choice === "blank") return starterGraph();
  const template = findStarterTemplate(choice);
  if (template === undefined) {
    throw new ApiError("UNKNOWN_TEMPLATE", `Unknown starter template: ${choice}`, 0);
  }
  return template.graph;
}

/**
 * Create the workflow from the choice, then start the first run with the
 * given task. Returns both ids; the component navigates to `/runs/:runId`.
 */
export async function launchWizardWorkflow(options: {
  projectId: string;
  choice: LaunchChoice;
  task: string;
  fetcher?: WorkflowFetcher;
}): Promise<WizardLaunchOutcome> {
  const { projectId, choice, task, fetcher } = options;
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    throw new ApiError("TASK_REQUIRED", "task must be a non-empty string", 0);
  }
  const name = workflowNameForChoice(choice);
  const graph = graphForChoice(choice);
  const created = await createWorkflowWithGraph({ projectId, name, graph, fetcher });
  const run = await startWorkflowRun(created.workflow.id, trimmed, fetcher);
  return { workflowId: created.workflow.id, workflowName: name, runId: run.id };
}
