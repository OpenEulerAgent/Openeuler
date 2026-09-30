import { z } from "zod";

/**
 * Unique entity id. The daemon is expected to mint these with
 * crypto.randomUUID() or an equivalent scheme; schemas only require a
 * non-empty string.
 */
export const idSchema = z.string().min(1, "id must be a non-empty string");

/**
 * Timestamps are ISO 8601 strings (not Date objects) so every entity stays
 * JSON-serializable end to end.
 */
export const timestampSchema = z.iso.datetime({
  message: "timestamp must be an ISO 8601 string (e.g. 2026-01-01T00:00:00.000Z)",
});
