/**
 * Pure unified-patch parsing for the run Diffs tab: file entries with +/-
 * counts (sidebar), old/new side reconstruction for the split viewer, and
 * extension→language mapping. Framework-free so it is trivially testable.
 */

/** One `diff --git` section of a unified patch. */
export interface DiffFileEntry {
  /** Section id within the rendered page (index + path). */
  key: string;
  /** Path as shown in the sidebar: post-image path, or the old path for deletions. */
  path: string;
  /** Pre-image path without the `a/` prefix ("" for new files). */
  oldPath: string;
  /** Post-image path without the `b/` prefix ("" for deleted files). */
  newPath: string;
  /** Added lines counted from hunk bodies. */
  additions: number;
  /** Deleted lines counted from hunk bodies. */
  deletions: number;
  /** True for `new file mode` sections. */
  isNew: boolean;
  /** True for `deleted file mode` sections. */
  isDeleted: boolean;
  /** True for `rename from`/`rename to` sections. */
  isRename: boolean;
  /** True for `Binary files ... differ` sections (no hunks to render). */
  isBinary: boolean;
  /** Reconstructed pre-image content (hunk context + deletions). */
  oldText: string;
  /** Reconstructed post-image content (hunk context + additions). */
  newText: string;
}

const META_PREFIXES = [
  "index ",
  "old mode ",
  "new mode ",
  "similarity index ",
  "dissimilarity index ",
  "copy from ",
  "copy to ",
] as const;

/** Strips an optional `a/` or `b/` prefix; `/dev/null` becomes "". */
function stripSide(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/dev/null") return "";
  return trimmed.replace(/^a\//, "").replace(/^b\//, "");
}

/** Sets the reconstructed sides and display path; pushes the entry. */
function finalizeEntry(entry: DiffFileEntry, oldLines: string[], newLines: string[]): void {
  entry.oldText = oldLines.join("\n");
  entry.newText = newLines.join("\n");
  entry.path = entry.newPath || entry.oldPath;
}

function makeEntry(): DiffFileEntry {
  return {
    key: "",
    path: "",
    oldPath: "",
    newPath: "",
    additions: 0,
    deletions: 0,
    isNew: false,
    isDeleted: false,
    isRename: false,
    isBinary: false,
    oldText: "",
    newText: "",
  };
}

/**
 * Parses a unified git patch into per-file entries with +/- counts and
 * reconstructed old/new sides (context + deletions build the old side;
 * context + additions build the new). Tolerates a truncated tail (the
 * server cap may cut mid-hunk): the last section keeps whatever completed.
 */
export function parsePatch(patch: string): DiffFileEntry[] {
  if (patch.length === 0) return [];
  const lines = patch.split("\n");
  const entries: DiffFileEntry[] = [];
  let current: DiffFileEntry | null = null;
  let oldLines: string[] = [];
  let newLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current !== null) {
        finalizeEntry(current, oldLines, newLines);
        entries.push(current);
      }
      current = makeEntry();
      oldLines = [];
      newLines = [];
      // `diff --git a/<old> b/<new>` — best effort (paths with spaces are
      // refined by the ---/+++ lines that follow).
      const rest = line.slice("diff --git ".length);
      const aMatch = rest.match(/^a\/(.*) b\//);
      const bMatch = rest.match(/ b\/(.*)$/);
      if (aMatch) current.oldPath = aMatch[1] ?? "";
      if (bMatch) current.newPath = bMatch[1] ?? "";
      current.key = `${entries.length}-${bMatch?.[1] ?? aMatch?.[1] ?? "file"}`;
      continue;
    }
    if (current === null) continue;
    const entry = current;

    if (line.startsWith("--- ")) {
      entry.oldPath = stripSide(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      entry.newPath = stripSide(line.slice(4));
      continue;
    }
    if (line.startsWith("new file mode")) {
      entry.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      entry.isDeleted = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      entry.isRename = true;
      entry.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      entry.isRename = true;
      entry.newPath = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      entry.isBinary = true;
      continue;
    }
    if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
    if (line.startsWith("@@")) continue;

    if (line.startsWith("+")) {
      entry.additions += 1;
      newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      entry.deletions += 1;
      oldLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
    // "\ No newline at end of file" and anything else: ignored.
  }
  if (current !== null) {
    finalizeEntry(current, oldLines, newLines);
    entries.push(current);
  }
  return entries;
}

/** Language ids kept deliberately small: common code + config, else plain text. */
const EXTENSION_LANGUAGES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  py: "python",
  go: "go",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  java: "java",
};

const NAME_LANGUAGES: Record<string, string> = {
  Makefile: "makefile",
  makefile: "makefile",
};

/** Refractor language id for a path, or undefined (plain text fallback). */
export function languageForPath(path: string): string | undefined {
  const byName = NAME_LANGUAGES[path];
  if (byName !== undefined) return byName;
  const ext = path.includes(".") ? (path.split(".").pop() as string).toLowerCase() : "";
  return EXTENSION_LANGUAGES[ext];
}
