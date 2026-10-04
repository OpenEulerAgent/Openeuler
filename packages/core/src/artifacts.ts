import { z } from "zod";

/**
 * Workflow-level artifact patterns (#122): safe globs naming files a run's
 * worktree should contribute to a durable artifact set when the run turns
 * terminal. Matching + caps live here (pure, no fs); the engine's
 * `ArtifactStore` performs the capture.
 */

/** Most patterns one workflow may declare. */
export const MAX_ARTIFACT_PATTERNS = 20;

/** Longest single pattern, in characters. */
export const MAX_ARTIFACT_PATTERN_LENGTH = 256;

/** Hard cap on captured FILES per run (#122). */
export const MAX_ARTIFACT_FILES = 200;

/** Hard cap on total captured bytes per run (#122): 50 MiB. */
export const MAX_ARTIFACT_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * Validation issues for one pattern, or `undefined` when it is safe. Rules:
 * non-empty, no null bytes, relative (no leading `/`, no drive letters, no
 * backslashes — patterns are POSIX-style), no `.`/`..`/empty segments, no
 * `{}`/character classes (only `*`, `**` and `?` are wildcards), and `!` is
 * only allowed as the leading negation marker.
 */
export function artifactPatternIssue(pattern: string): string | undefined {
  if (pattern.length === 0) return "pattern must be a non-empty string";
  if (pattern.length > MAX_ARTIFACT_PATTERN_LENGTH) {
    return `pattern must be at most ${MAX_ARTIFACT_PATTERN_LENGTH} characters`;
  }
  if (pattern.includes("\0")) return "pattern must not contain null bytes";
  if (pattern.includes("\\")) return "pattern must use '/' separators (no backslashes)";
  const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  if (body.startsWith("/")) return "pattern must be relative to the worktree root (no leading '/')";
  if (/^[A-Za-z]:/.test(body)) return "pattern must not be an absolute path";
  if (body.length === 0) return "'!' alone is not a pattern";
  if (body.includes("!")) return "'!' is only allowed as the leading negation marker";
  if (/[{}[\]]/.test(body)) {
    return "pattern wildcards are '*', '**' and '?' only (no brace/character classes)";
  }
  for (const segment of body.split("/")) {
    if (segment === "") return "pattern must not contain empty '//' segments";
    if (segment === "." || segment === "..") {
      return `pattern segment '${segment}' is not allowed (patterns stay inside the worktree)`;
    }
  }
  return undefined;
}

/** One safe artifact glob; leading `!` negates (excludes matches). */
export const ArtifactPatternSchema = z
  .string()
  .refine((pattern) => artifactPatternIssue(pattern) === undefined, {
    message:
      "artifact pattern must be a relative POSIX glob using '*', '**' and '?' only, with optional leading '!' negation",
  });

/** Workflow-level `artifacts` patterns (#122): ordered, bounded, deduped-free. */
export const WorkflowArtifactsSchema = z
  .array(ArtifactPatternSchema)
  .max(MAX_ARTIFACT_PATTERNS, `at most ${MAX_ARTIFACT_PATTERNS} artifact patterns are allowed`);

/** Regex metacharacters escaped when translating a glob segment. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** Compiles one glob segment to regex source (`*`/`?` wildcards). */
function segmentToRegex(segment: string): string {
  let out = "";
  for (const char of segment) {
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(REGEX_SPECIAL, "\\$&");
  }
  return out;
}

/**
 * Compiles one (non-negated) glob into a path matcher. Semantics:
 *
 * - patterns containing `/` are anchored at the worktree root;
 * - slash-free patterns match at any depth (implicit leading `**`
 *   segment, the gitignore convention — `*.log` matches `build/a.log` too);
 * - `**` spans zero or more whole segments; `*`/`?` stay within one;
 * - `dist` therefore matches the directory `dist` itself, and capture treats
 *   an ancestor-directory match as including everything beneath it.
 */
export function compileArtifactPattern(pattern: string): (relPath: string) => boolean {
  const anchored = pattern.includes("/");
  const rawSegments = pattern.split("/");
  // Collapse consecutive `**` segments (semantically identical) so nested
  // quantifiers cannot create an exponential backtracking surface.
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment === "**" && segments[segments.length - 1] === "**") continue;
    segments.push(segment);
  }
  const parts: string[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment === "**") {
      // Interior `**/` may consume zero segments; a trailing `**` needs at
      // least one (files only — the bare directory is covered via ancestors).
      parts.push(index === segments.length - 1 ? "[^/]+(?:/[^/]+)*" : "(?:[^/]+/)*");
      continue;
    }
    parts.push(segmentToRegex(segment) + (index === segments.length - 1 ? "" : "/"));
  }
  const regex = new RegExp(`^${(anchored ? "" : "(?:[^/]+/)*") + parts.join("")}$`);
  return (relPath: string) => regex.test(relPath);
}

/** Parent-directory paths of a relative POSIX path, nearest first (`a/b/c` → `a/b`, `a`). */
function ancestorsOf(relPath: string): string[] {
  const parts = relPath.split("/");
  const out: string[] = [];
  for (let end = parts.length - 1; end > 0; end -= 1) {
    out.push(parts.slice(0, end).join("/"));
  }
  return out;
}

/**
 * Whether `relPath` (POSIX-relative, worktree-rooted) is selected by the
 * ordered `patterns`. Gitignore-style last-match-wins: each pattern that
 * matches the path — or any of its ancestor directories, so a pattern naming
 * a directory includes its subtree — flips the verdict; `!pattern` flips it
 * to excluded. Nothing matched → excluded.
 */
export function matchesArtifactPath(relPath: string, patterns: readonly string[]): boolean {
  const ancestors = ancestorsOf(relPath);
  let included = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const matcher = compileArtifactPattern(negated ? raw.slice(1) : raw);
    const hit = matcher(relPath) || ancestors.some((ancestor) => matcher(ancestor));
    if (hit) included = !negated;
  }
  return included;
}
