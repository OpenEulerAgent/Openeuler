import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import {
  createActivityRepo,
  createAgentPresetRepo,
  createEventRepo,
  createProjectRepo,
  createProjectSecretRepo,
  createRunRepo,
  createStepRunRepo,
  createWorkflowRepo,
  createWorkflowRevisionRepo,
} from "./repos.js";
import type {
  ActivityRepo,
  AgentPresetRepo,
  EventRepo,
  ProjectRepo,
  ProjectSecretRepo,
  RunRepo,
  StepRunRepo,
  WorkflowRepo,
  WorkflowRevisionRepo,
} from "./repos.js";

export * from "./schema.js";
export type {
  ActivityInput,
  ActivityRow,
  AgentEventInput,
  AgentPresetPatch,
  EventInput,
  ProjectSecret,
  ProjectSecretName,
  RunPatch,
  StepRunPatch,
  WorkflowPatch,
  WorkflowRevision,
  WorkflowRevisionRepo,
} from "./repos.js";
export type {
  ActivityRepo,
  AgentPresetRepo,
  EventRepo,
  ProjectRepo,
  ProjectSecretRepo,
  RunRepo,
  StepRunRepo,
  WorkflowRepo,
} from "./repos.js";
export { migrateLinearWorkflowsToGraphs } from "./migrate.js";
export type { LinearMigrationResult } from "./migrate.js";

export const PACKAGE_NAME = "@openeuler/db";

export interface Db {
  /** Absolute path of the SQLite file. */
  readonly path: string;
  /** Raw better-sqlite3 handle (synchronous); use repos for typed access. */
  readonly sqlite: Database.Database;
  readonly projects: ProjectRepo;
  readonly projectSecrets: ProjectSecretRepo;
  readonly agentPresets: AgentPresetRepo;
  readonly workflows: WorkflowRepo;
  readonly workflowRevisions: WorkflowRevisionRepo;
  readonly runs: RunRepo;
  readonly stepRuns: StepRunRepo;
  readonly events: EventRepo;
  readonly activity: ActivityRepo;
  close(): void;
}

export interface CreateDatabaseOptions {
  /** SQLite file path. Defaults to `OPENEULER_DB`, then `<repo>/data/openeuler.db`. */
  path?: string;
}

/** Migrations ship with the package: `<pkg>/drizzle` (adjacent to `src`/`dist`). */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Walk up from this module to the directory containing the workspace manifest. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function resolveDbPath(opts: CreateDatabaseOptions = {}): string {
  const raw = opts.path ?? process.env["OPENEULER_DB"];
  if (raw && isAbsolute(raw)) return raw;
  if (raw) return join(process.cwd(), raw);
  const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  return join(root, "data", "openeuler.db");
}

/**
 * Opens (and, if needed, creates) the SQLite database, applies pending
 * migrations (re-running against an up-to-date file is a no-op), and returns
 * a typed `Db` with repository accessors.
 */
export function createDatabase(opts: CreateDatabaseOptions = {}): Db {
  const path = resolveDbPath(opts);
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    path,
    sqlite,
    projects: createProjectRepo(db),
    projectSecrets: createProjectSecretRepo(db),
    agentPresets: createAgentPresetRepo(db),
    workflows: createWorkflowRepo(db),
    workflowRevisions: createWorkflowRevisionRepo(db),
    runs: createRunRepo(db),
    stepRuns: createStepRunRepo(db),
    events: createEventRepo(db),
    activity: createActivityRepo(db),
    close() {
      sqlite.close();
    },
  };
}
