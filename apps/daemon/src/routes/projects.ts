import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Project } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { recordProjectCreatedActivity } from "../activity.js";
import { HttpError } from "../errors.js";
import { GitError, gitExec } from "../git.js";
import { seedBuiltinPresets } from "./presets.js";

export const NO_COMMITS_WARNING =
  "repository has no commits yet; branch creation will fail until an initial commit exists";

const CreateProjectBodySchema = z.strictObject({
  path: z.string().min(1, "path must be a non-empty string"),
});

export interface RepositorySnapshot {
  root: string;
  defaultBranch: string;
  remoteUrl: string | undefined;
  dirty: boolean;
  warnings: string[];
}

async function assertDirectory(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new HttpError(422, "PATH_NOT_DIRECTORY", `path is not a directory: ${path}`);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      422,
      "PATH_NOT_FOUND",
      `path does not exist: ${path}. Provide an absolute path to a local directory`,
    );
  }
}

async function resolveRoot(path: string): Promise<string> {
  try {
    return await gitExec(path, ["rev-parse", "--show-toplevel"]);
  } catch (err) {
    if (err instanceof GitError) {
      if (/not a git repository/i.test(err.stderr)) {
        throw new HttpError(
          422,
          "NOT_A_GIT_REPOSITORY",
          `not a git repository: ${path}. Run \`git init\` there, or open a directory inside a git repository`,
        );
      }
      if (err.timedOut) {
        throw new HttpError(504, "GIT_TIMEOUT", `git rev-parse timed out on ${path}`);
      }
      throw new HttpError(
        422,
        "GIT_ERROR",
        err.stderr.split("\n")[0]?.trim() || `git rev-parse failed on ${path}`,
      );
    }
    throw err;
  }
}

async function detectDefaultBranch(root: string): Promise<string> {
  try {
    return await gitExec(root, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    // Detached HEAD: fall back to the checked-out commit.
    try {
      return await gitExec(root, ["rev-parse", "--short", "HEAD"]);
    } catch {
      return "HEAD";
    }
  }
}

async function detectRemoteUrl(root: string): Promise<string | undefined> {
  try {
    return (await gitExec(root, ["remote", "get-url", "origin"])) || undefined;
  } catch {
    return undefined;
  }
}

async function isDirty(root: string): Promise<boolean> {
  const status = await gitExec(root, ["status", "--porcelain"]);
  return status.length > 0;
}

async function hasCommits(root: string): Promise<boolean> {
  try {
    await gitExec(root, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Collects the git metadata snapshot for a local working copy. */
export async function inspectRepository(path: string): Promise<RepositorySnapshot> {
  await assertDirectory(path);
  const root = await resolveRoot(path);
  const [defaultBranch, remoteUrl, dirty, committed] = await Promise.all([
    detectDefaultBranch(root),
    detectRemoteUrl(root),
    isDirty(root),
    hasCommits(root),
  ]);
  return {
    root,
    defaultBranch,
    remoteUrl,
    dirty,
    warnings: committed ? [] : [NO_COMMITS_WARNING],
  };
}

function requireDb(c: Context<AppEnv>): Db {
  const db = c.get("db");
  if (!db) throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
  return db;
}

async function parseJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(422, "INVALID_JSON", "request body must be valid JSON");
  }
}

export function createProjectsRouter(): Hono<AppEnv> {
  const projects = new Hono<AppEnv>();

  projects.post("/", async (c) => {
    const db = requireDb(c);
    const body = CreateProjectBodySchema.parse(await parseJsonBody(c));
    const snapshot = await inspectRepository(body.path);
    const project: Project = {
      id: randomUUID(),
      path: snapshot.root,
      name: basename(snapshot.root),
      defaultBranch: snapshot.defaultBranch,
      ...(snapshot.remoteUrl === undefined ? {} : { remoteUrl: snapshot.remoteUrl }),
      dirty: snapshot.dirty,
      createdAt: new Date().toISOString(),
    };
    db.projects.create(project);
    recordProjectCreatedActivity(db, project);
    // Fresh roster: seed the builtin agent presets (ordinary rows — the
    // user can rename, edit, or delete them like any preset).
    seedBuiltinPresets(db, project.id);
    c.get("logger").info({ projectId: project.id, path: project.path }, "project registered");
    return c.json({ project, warnings: snapshot.warnings }, 201);
  });

  projects.get("/", (c) => {
    const db = requireDb(c);
    return c.json({ projects: db.projects.list() });
  });

  projects.get("/:id", (c) => {
    const db = requireDb(c);
    const project = db.projects.get(c.req.param("id"));
    if (!project) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", `no project with id ${c.req.param("id")}`);
    }
    return c.json({ project });
  });

  projects.delete("/:id", (c) => {
    const db = requireDb(c);
    const id = c.req.param("id");
    if (!db.projects.get(c.req.param("id"))) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", `no project with id ${c.req.param("id")}`);
    }
    // Presets and secrets are owned metadata, so they go with the project
    // instead of blocking the delete via the FKs.
    db.agentPresets.deleteAllForProject(id);
    db.projectSecrets.deleteAllForProject(id);
    if (!db.projects.delete(id)) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", `no project with id ${c.req.param("id")}`);
    }
    return c.body(null, 204);
  });

  return projects;
}
