import { serve } from "@hono/node-server";
import { createDatabase, migrateLinearWorkflowsToGraphs } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver, createOpenCodeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createDockerSandboxProvider, registerSandboxProvider } from "@openeuler/sandbox";
import { dirname } from "node:path";
import { createApp } from "./app.js";
import { recordDaemonBootActivity } from "./activity.js";
import { createExecutor } from "./executor.js";
import { createLogger } from "./logger.js";
import { sweepInterruptedRuns } from "./recovery.js";
import { startPeriodicSandboxGc } from "./sandbox-gc.js";
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

  // Sandbox composition at boot (#100 + #102): ONE docker provider instance
  // backs the image management API, the run executor's sandboxed execution
  // and the /metrics sandbox gauge. Registered on the module-level default
  // registry as a convenience for callers that resolve providers by id
  // (`getSandboxProvider("docker")`).
  const sandboxProvider = createDockerSandboxProvider();
  registerSandboxProvider(sandboxProvider);

  const executor = createExecutor({
    db,
    worktrees,
    drivers,
    logger,
    secretsKey: secretKey.key,
    sandbox: { provider: sandboxProvider },
  });

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

  // Startup task #3, before serving (#105): sandbox GC boot sweep — reconcile
  // provider sandboxes with the db (stale terminal + orphan containers
  // destroyed, orphan cache volumes pruned; one ops.gc event with the
  // counts), then keep sweeping every 10 minutes. The shared docker provider
  // is the same instance the executor and image routes use.
  const sandboxGc = startPeriodicSandboxGc({
    db,
    provider: sandboxProvider,
    logger,
    activeRunIds: () => executor.activeRunIds(),
  });
  const bootGc = await sandboxGc.bootSweep();
  if (bootGc.destroyed + bootGc.orphans + bootGc.cacheVolumesPruned > 0) {
    logger.info(bootGc, "sandbox GC boot sweep complete");
  }

  const { app, onShutdown, handleShutdown, authRequired } = createApp({
    db,
    logger,
    executor,
    drivers,
    worktrees,
    maxConcurrentRuns: executor.maxConcurrentRuns,
    secretsKey: secretKey.key,
    sandbox: { provider: sandboxProvider },
  });

  // LIFO: http-server → sandbox-gc → executor → db.
  onShutdown(() => db.close(), "db");
  onShutdown(() => executor.shutdown(), "executor");
  onShutdown(() => sandboxGc.stop(), "sandbox-gc");

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
