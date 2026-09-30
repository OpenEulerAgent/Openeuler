import { z } from "zod";
import { idSchema, timestampSchema } from "./common.js";

export const ProjectSchema = z.strictObject({
  id: idSchema,
  /** Absolute path to the repository working copy on the daemon host. */
  path: z.string().min(1, "path must be a non-empty string"),
  name: z.string().min(1, "name must be a non-empty string"),
  defaultBranch: z.string().min(1, "defaultBranch must be a non-empty string"),
  createdAt: timestampSchema,
});

export type Project = z.infer<typeof ProjectSchema>;
