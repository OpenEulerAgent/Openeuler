import { z } from "zod";
import { idSchema, timestampSchema } from "./common.js";
import { StepConfigSchema } from "./workflow.js";

/**
 * A reusable named agent preset — the "your team" primitive (#49): a saved
 * `StepConfig` ("Senior Reviewer", "Test Engineer") that palette items and
 * new nodes are created from. Project-scoped in v0.1.
 *
 * Nodes copy the config at creation time and keep that copy; preset edits
 * never silently mutate existing nodes — syncing is an explicit "Update from
 * preset" action in the node inspector.
 */
export const AgentPresetSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  name: z.string().min(1, "preset name must be a non-empty string"),
  description: z.string(),
  /** Short emoji/label rendered next to the palette item, e.g. "🧪". */
  icon: z.string().min(1, "icon must be a non-empty string").optional(),
  config: StepConfigSchema,
  /** True for presets seeded on project creation; deletable like any other. */
  builtin: z.boolean().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export type AgentPreset = z.infer<typeof AgentPresetSchema>;
