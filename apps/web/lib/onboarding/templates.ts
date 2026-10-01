import type { WorkflowGraphShape } from "@openeuler/core";

/**
 * Starter templates as code (#53). Per product direction, self-defined loops
 * are the product and templates are door-openers — so exactly two ship:
 * a review loop (the aha: conditional edges) and a linear feature pipeline.
 *
 * "Use template" = POST /api/workflows {projectId, name, graph} — revision 1
 * snapshots the graph below and the user lands on the canvas with it
 * immediately editable.
 *
 * This module intentionally imports nothing but `@openeuler/core`, so daemon
 * integration tests can import it and round-trip the exact graphs users get.
 */

export type StarterTemplateId = "implement-review-fix" | "feature-pipeline";

export interface StarterTemplate {
  id: StarterTemplateId;
  name: string;
  description: string;
  /** Default workflow name when the template is materialized. */
  workflowName: string;
  highlights: string[];
  graph: WorkflowGraphShape;
}

const implementPrompt = [
  "You are the implementer. Implement the following task in this repository.",
  "",
  "Task:",
  "{{task}}",
  "",
  "Write a minimal, clean change. Follow the existing code style, keep the diff small, and end with a short summary of the edits you made.",
].join("\n");

/**
 * Implement → Review → Fix loop: the reviewer is a router — approval
 * (`LGTM` in its output) exits, anything else loops back through the fixer.
 * The loop edge carries the cycle guard (maxIterations 3) and explicit router
 * order, matching the #44/#46 router rules.
 */
const implementReviewFix: StarterTemplate = {
  id: "implement-review-fix",
  name: "Implement → Review → Fix loop",
  description:
    "An implementer builds the change, a reviewer approves it or kicks it back, and a fixer patches the issues — looping until LGTM.",
  workflowName: "Implement → Review → Fix",
  highlights: [
    "Conditional routing on the reviewer's verdict",
    "Fix loop bounded by maxIterations",
    "Edit any prompt or wire new agents on the canvas",
  ],
  graph: {
    entryNodeId: "implement",
    nodes: [
      {
        id: "implement",
        type: "agent",
        name: "Implement",
        position: { x: 80, y: 160 },
        config: {
          driver: "opencode",
          mode: "auto",
          promptTemplate: implementPrompt,
          continueSession: false,
        },
      },
      {
        id: "reviewer",
        type: "agent",
        name: "Reviewer",
        position: { x: 400, y: 160 },
        config: {
          driver: "opencode",
          mode: "auto",
          promptTemplate: [
            "You are a strict senior reviewer. Review the change below and decide whether it can ship.",
            "",
            "Task:",
            "{{task}}",
            "",
            "Change to review:",
            "{{output:implement}}",
            "",
            "Check correctness, tests, edge cases and style. List every blocking issue with a concrete suggestion. When nothing blocks, approve — the very last line of your reply must be exactly:",
            "LGTM",
            "Otherwise end with:",
            "CHANGES REQUESTED",
          ].join("\n"),
          continueSession: false,
        },
      },
      {
        id: "fix",
        type: "agent",
        name: "Fix",
        position: { x: 400, y: 400 },
        config: {
          driver: "opencode",
          mode: "auto",
          promptTemplate: [
            "You are the fixer. The reviewer found issues in the implementation — fix them.",
            "",
            "Task:",
            "{{task}}",
            "",
            "Original implementation:",
            "{{output:implement}}",
            "",
            "Reviewer feedback:",
            "{{output:reviewer}}",
            "",
            "Apply the requested fixes, keep the change minimal, and summarize what you changed.",
          ].join("\n"),
          continueSession: false,
        },
      },
      {
        id: "exit",
        type: "exit",
        name: "Exit",
        position: { x: 720, y: 160 },
      },
    ],
    edges: [
      {
        id: "e-implement-reviewer",
        source: "implement",
        target: "reviewer",
        condition: { type: "always" },
      },
      {
        id: "e-reviewer-approve",
        source: "reviewer",
        target: "exit",
        condition: { type: "outputContains", pattern: "LGTM" },
        order: 0,
      },
      {
        id: "e-reviewer-fix",
        source: "reviewer",
        target: "fix",
        condition: { type: "outputNotContains", pattern: "LGTM" },
        order: 1,
        maxIterations: 3,
      },
      {
        id: "e-fix-reviewer",
        source: "fix",
        target: "reviewer",
        condition: { type: "always" },
      },
    ],
  },
};

/** Feature pipeline: implement → tests → docs, a plain linear chain. */
const featurePipeline: StarterTemplate = {
  id: "feature-pipeline",
  name: "Feature pipeline",
  description:
    "An assembly line for a feature: implement the change, cover it with tests, then document it.",
  workflowName: "Feature pipeline",
  highlights: [
    "Linear hand-offs with {{output:<node>}} context",
    "Every stage is a normal agent node — reroute freely",
    "A calm starting point for your own graphs",
  ],
  graph: {
    entryNodeId: "implement",
    nodes: [
      {
        id: "implement",
        type: "agent",
        name: "Implement",
        position: { x: 80, y: 160 },
        config: {
          driver: "opencode",
          mode: "auto",
          promptTemplate: implementPrompt,
          continueSession: false,
        },
      },
      {
        id: "tests",
        type: "agent",
        name: "Tests",
        position: { x: 400, y: 160 },
        config: {
          driver: "opencode",
          mode: "auto",
          promptTemplate: [
            "You are the test engineer. Write or extend tests that cover the change below.",
            "",
            "Task:",
            "{{task}}",
            "",
            "Change to cover:",
            "{{output:implement}}",
            "",
            "Follow the repository's existing test framework and conventions. Cover the happy path and the important edge cases, make the suite green without weakening assertions, and summarize the tests you added.",
          ].join("\n"),
          continueSession: false,
        },
      },
      {
        id: "docs",
        type: "agent",
        name: "Docs",
        position: { x: 720, y: 160 },
        config: {
          driver: "opencode",
          mode: "auto",
          promptTemplate: [
            "You are the documentation writer. Document the change below.",
            "",
            "Task:",
            "{{task}}",
            "",
            "Change to document:",
            "{{output:implement}}",
            "",
            "Tests that were added:",
            "{{output:tests}}",
            "",
            "Update the relevant README/docs sections so users can discover the change. Keep it concise and match the project's tone.",
          ].join("\n"),
          continueSession: false,
        },
      },
      {
        id: "exit",
        type: "exit",
        name: "Exit",
        position: { x: 1040, y: 160 },
      },
    ],
    edges: [
      {
        id: "e-implement-tests",
        source: "implement",
        target: "tests",
        condition: { type: "always" },
      },
      {
        id: "e-tests-docs",
        source: "tests",
        target: "docs",
        condition: { type: "always" },
      },
      {
        id: "e-docs-exit",
        source: "docs",
        target: "exit",
        condition: { type: "always" },
      },
    ],
  },
};

/** The two (and only two) starters — templates are door-openers, not the product. */
export const STARTER_TEMPLATES: readonly StarterTemplate[] = [implementReviewFix, featurePipeline];

export function findStarterTemplate(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((template) => template.id === id);
}
