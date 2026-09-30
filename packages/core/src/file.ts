import { z } from "zod";

/** Kind of a filesystem entry as surfaced by the file tree API. */
export const FileTypeSchema = z.enum(["file", "dir"]);

/** One lazy-loaded level of the project file tree (`GET /api/projects/:id/tree`). */
export const FileNodeSchema = z.strictObject({
  name: z.string().min(1, "name must be a non-empty string"),
  type: FileTypeSchema,
  /** Bytes for files; 0 for directories. */
  size: z.number().int().min(0, "size must be a non-negative integer"),
});

/** File payload from `GET /api/projects/:id/file`. */
export const FileContentSchema = z.strictObject({
  /** UTF-8 text; empty string when the file is binary. */
  content: z.string(),
  /** True when `content` was cut off at the ~256KB cap. */
  truncated: z.boolean(),
  /** True when a null byte was sniffed in the first chunk. */
  binary: z.boolean(),
  /** Full size of the file on disk in bytes. */
  size: z.number().int().min(0, "size must be a non-negative integer"),
});

export type FileType = z.infer<typeof FileTypeSchema>;
export type FileNode = z.infer<typeof FileNodeSchema>;
export type FileContent = z.infer<typeof FileContentSchema>;
