import { serve } from "@hono/node-server";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "./app.js";
import { createExecutor } from "./executor.js";
import { createLogger } from "./logger.js";
import { sweepInterruptedRuns } from "./recovery.js";

const DEFAULT_PORT = 8787;

function resolvePort(): number {
  const parsed = Number(process.env["PORT"] ?? DEFAULT_PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : DEFAULT_PORT;
}

export async function main(): Promise<void> {
  const logger = createLogger();
  const db = createDatabase();

  // Driver composition at boot. `fake` is the only backend for now; the real
  // opencode driver arrives later. OPENEULER_DRIVER selects the run driver.
  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver());

  const worktrees = new WorktreeManager();
  const executor = createExecutor({ db, worktrees, drivers, logger });

  // Startup task, before serving: settle runs orphaned by a previous daemon
  // process (SIGKILL/crash) to `interrupted` and report orphaned worktrees.
  const sweep = await sweepInterruptedRuns({ db, worktrees, executor, logger });
  if (sweep.interruptedRunIds.length > 0 || sweep.orphanedWorktrees.length > 0) {
    logger.info(
      {
        interrupted: sweep.interruptedRunIds.length,
        orphanedWorktrees: sweep.orphanedWorktrees.length,
      },
      "boot recovery complete",
    );
  }

  const { app, onShutdown, handleShutdown } = createApp({
    db,
    logger,
    executor,
    drivers,
    worktrees,
    maxConcurrentRuns: executor.maxConcurrentRuns,
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

  logger.info({ pid: process.pid, port, dbPath: db.path }, "daemon started");
}

main().catch((err) => {
  console.error("fatal: daemon failed to start", err);
  process.exit(1);
});
