import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import type { FileNode, Project } from "@openeuler/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { HttpError } from "../errors.js";

/** Maximum bytes of content returned by /file before the payload is truncated. */
export const MAX_CONTENT_BYTES = 256 * 1024;
/** Bytes sniffed from the start of a file to detect binaries (null byte). */
export const BINARY_SNIFF_BYTES = 8 * 1024;

const TreeQuerySchema = z.strictObject({
  path: z.string().default("."),
  includeNodeModules: z
    .string()
    .optional()
    .transform((value) => value === "1"),
});

const FileQuerySchema = z.strictObject({
  path: z.string().min(1, "path must be a non-empty string"),
});

/**
 * Resolves `relative` against `root` and asserts the result stays inside the
 * root. Blocks `..` traversal and absolute paths pointing outside the root.
 * Symlink escapes are caught afterwards by {@link realpathWithinRoot}.
 * Throws 403 PATH_ESCAPE on violation. `label` names the root in errors
 * ("project root", "artifact store" — shared with the run-artifacts routes,
 * #122).
 */
export function resolveWithinRoot(root: string, relative: string, label = "project root"): string {
  if (relative.includes("\0")) {
    throw new HttpError(422, "INVALID_PATH", "path must not contain null bytes");
  }
  const resolved = resolvePath(root, relative);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new HttpError(403, "PATH_ESCAPE", `path escapes the ${label}: ${relative}`);
  }
  return resolved;
}

/**
 * Canonicalizes both paths with fs.realpath and re-asserts containment, so a
 * symlink inside the root that points outside is rejected with 403.
 * Returns the canonical target path (a 404 when it does not exist).
 */
export async function realpathWithinRoot(
  root: string,
  resolved: string,
  label = "project root",
): Promise<string> {
  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([realpath(root), realpath(resolved)]);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new HttpError(404, "PATH_NOT_FOUND", "requested path does not exist");
    }
    if (code === "EINVAL" || code === "ERR_INVALID_ARG_VALUE") {
      throw new HttpError(422, "INVALID_PATH", "path is not a valid filesystem path");
    }
    throw err;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new HttpError(
      403,
      "PATH_ESCAPE",
      `path resolves outside the ${label} (symlink?): ${resolved}`,
    );
  }
  return realTarget;
}

async function statEntry(fullPath: string): Promise<Stats | undefined> {
  try {
    return await stat(fullPath);
  } catch {
    // Broken symlink (or raced deletion): fall back to lstat so the entry is
    // still listed instead of silently disappearing from the tree.
    try {
      return await lstat(fullPath);
    } catch {
      return undefined;
    }
  }
}

async function toFileNode(fullPath: string, name: string): Promise<FileNode | null> {
  const info = await statEntry(fullPath);
  if (!info) return null;
  const isDir = info.isDirectory();
  return { name, type: isDir ? "dir" : "file", size: isDir ? 0 : info.size };
}

function sortEntries(entries: FileNode[]): FileNode[] {
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

function requireProject(c: Context<AppEnv>): Project {
  const db = c.get("db");
  if (!db) throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
  const id = c.req.param("id");
  if (!id) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", "project id is required");
  }
  const project = db.projects.get(id);
  if (!project) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", `no project with id ${id}`);
  }
  return project;
}

async function assertDirectory(target: string): Promise<void> {
  const info = await stat(target);
  if (!info.isDirectory()) {
    throw new HttpError(422, "PATH_NOT_DIRECTORY", `path is not a directory: ${target}`);
  }
}

/** Read-only file tree + file content endpoints scoped to a registered project. */
export function createFilesRouter(): Hono<AppEnv> {
  const files = new Hono<AppEnv>();

  files.get("/:id/tree", async (c) => {
    const project = requireProject(c);
    const query = TreeQuerySchema.parse({
      path: c.req.query("path"),
      includeNodeModules: c.req.query("includeNodeModules"),
    });
    const resolved = resolveWithinRoot(project.path, query.path);
    const target = await realpathWithinRoot(project.path, resolved);
    await assertDirectory(target);

    const dirents = await readdir(target, { withFileTypes: true });
    const entries: FileNode[] = [];
    for (const dirent of dirents) {
      if (dirent.name === ".git") continue;
      if (dirent.name === "node_modules" && !query.includeNodeModules) continue;
      const node = await toFileNode(join(target, dirent.name), dirent.name);
      if (node) entries.push(node);
    }
    return c.json({ entries: sortEntries(entries) });
  });

  files.get("/:id/file", async (c) => {
    const project = requireProject(c);
    const query = FileQuerySchema.parse({ path: c.req.query("path") ?? "" });
    const resolved = resolveWithinRoot(project.path, query.path);
    const target = await realpathWithinRoot(project.path, resolved);

    const handle = await openFile(target);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new HttpError(422, "PATH_NOT_FILE", `path is not a regular file: ${target}`);
      }
      const readLength = Math.min(stats.size, MAX_CONTENT_BYTES);
      const buffer = Buffer.alloc(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
      const data = buffer.subarray(0, bytesRead);
      const sniffLength = Math.min(bytesRead, BINARY_SNIFF_BYTES);
      if (data.subarray(0, sniffLength).includes(0)) {
        return c.json({ content: "", truncated: false, binary: true, size: stats.size });
      }
      return c.json({
        content: data.toString("utf8"),
        truncated: bytesRead < stats.size,
        binary: false,
        size: stats.size,
      });
    } finally {
      await handle.close();
    }
  });

  return files;
}

async function openFile(target: string) {
  try {
    return await open(target, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new HttpError(404, "FILE_NOT_FOUND", `file does not exist in project: ${target}`);
    }
    if (code === "EISDIR") {
      throw new HttpError(422, "PATH_NOT_FILE", `path is not a regular file: ${target}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new HttpError(500, "FILE_READ_ERROR", `file is not readable: ${target}`);
    }
    throw err;
  }
}
