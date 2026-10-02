import { serve } from "@hono/node-server";
import { createDatabase, migrateLinearWorkflowsToGraphs } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver, createOpenCodeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { dirname } from "node:path";
import { createApp } from "./app.js";
import { recordDaemonBootActivity } from "./activity.js";
import { createExecutor } from "./executor.js";
import { createLogger } from "./logger.js";
import { sweepInterruptedRuns } from "./recovery.js";
import { loadOrCreateSecretKey } from "./secrets-crypto.js";
import { getVersion } from "./version.js";

const DEFAULT_PORT = 8787;

function resolvePort(): number {
  const parsed = Number(process.env["PORT"] ?? DEFAULT_PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : DEFAULT_PORT;
}

export async function main(): Promise<void> {
  const logger = createLogger();
  const db = createDatabase();

  // #94: ops event stream starts with the boot itself (versioned).
  recordDaemonBootActivity(db, getVersion());

  // Master key for per-project secrets (#93): generated on first boot next
  // to the db (mode 600). Losing this file makes stored secrets
  // undecryptable — back it up alongside the database.
  const secretKey = loadOrCreateSecretKey({ dataDir: dirname(db.path) });
  logger.info(
    { path: secretKey.path, created: secretKey.created },
    secretKey.created
      ? "secret key generated (keep it safe; losing it loses stored secrets)"
      : "secret key loaded",
  );

  // Driver composition at boot: every driver listed in `GET /api/drivers`.
  // `fake` needs no external binary; `opencode` spawns the real CLI.
  // OPENEULER_DRIVER selects the driver for ad-hoc runs; workflow steps pick
  // theirs per step in the workflow definition.
  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver());
  drivers.registerDriver(createOpenCodeDriver());

  const worktrees = new WorktreeManager();
  const executor = createExecutor({ db, worktrees, drivers, logger, secretsKey: secretKey.key });

  // Startup task #1: snapshot legacy `steps` workflows as graph revision 1
  // (idempotent — workflows that already have revisions are untouched), so
  // every run can pin an immutable revision.
  const graphMigration = migrateLinearWorkflowsToGraphs(db);
  if (graphMigration.migrated.length > 0) {
    logger.info(
      { migrated: graphMigration.migrated.length, skipped: graphMigration.skipped.length },
      "legacy workflows migrated to graph revisions",
    );
  }

  // Startup task #2, before serving: settle runs orphaned by a previous
  // daemon process (SIGKILL/crash) to `interrupted` and report orphaned
  // worktrees.
  const sweep = await sweepInterruptedRuns({
    db,
    worktrees,
    executor,
    logger,
    secretsKey: secretKey.key,
  });
  if (sweep.interruptedRunIds.length > 0 || sweep.orphanedWorktrees.length > 0) {
    logger.info(
      {
        interrupted: sweep.interruptedRunIds.length,
        orphanedWorktrees: sweep.orphanedWorktrees.length,
      },
      "boot recovery complete",
    );
  }

  const { app, onShutdown, handleShutdown, authRequired } = createApp({
    db,
    logger,
    executor,
    drivers,
    worktrees,
    maxConcurrentRuns: executor.maxConcurrentRuns,
    secretsKey: secretKey.key,
  });

  // LIFO: http-server → executor → db.
  onShutdown(() => db.close(), "db");
  onShutdown(() => executor.shutdown(), "executor");

  const port = resolvePort();
  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info(
      { port: info.port, dbPath: db.path, maxConcurrentRuns: executor.maxConcurrentRuns },
      "@openeuler/daemon listening",
    );
  });
  server.on("error", (err) => {
    logger.error({ err, port }, "http server error");
    process.exit(1);
  });

  onShutdown(() => new Promise<void>((resolve) => server.close(() => resolve())), "http-server");

  const onSignal = (signal: NodeJS.Signals) => {
    void handleShutdown(signal);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  logger.info(
    { pid: process.pid, port, dbPath: db.path, ...(authRequired ? { auth: "token" } : {}) },
    "daemon started",
  );
}

main().catch((err) => {
  console.error("fatal: daemon failed to start", err);
  process.exit(1);
});
