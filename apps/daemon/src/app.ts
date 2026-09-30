import type { Db } from "@openeuler/db";
import type { DriverRegistry } from "@openeuler/drivers";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import type { Executor } from "./executor.js";
import { HttpError } from "./errors.js";
import { healthPayload } from "./health.js";
import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { createShutdownRegistry } from "./shutdown.js";
import type { ShutdownHook, ShutdownRegistryOptions } from "./shutdown.js";
import { createProjectsRouter } from "./routes/projects.js";
import { createDriversRouter } from "./routes/drivers.js";
import { createFilesRouter } from "./routes/files.js";
import type { EventStreamOptions } from "./routes/runs.js";
import { createRunsRouter } from "./routes/runs.js";
import { createWorkflowsRouter } from "./routes/workflows.js";

export const DEFAULT_CORS_ORIGIN = "http://localhost:3000";

export interface AppEnv {
  Variables: {
    logger: Logger;
    db: Db | undefined;
    executor: Executor | undefined;
  };
}

export interface CreateAppOptions {
  db?: Db;
  logger?: Logger;
  executor?: Executor;
  /** Driver registry composed at boot; backs `GET /api/drivers`. */
  drivers?: DriverRegistry;
  corsOrigin?: string;
  shutdown?: ShutdownRegistryOptions;
  /** SSE tuning for `GET /api/runs/:id/events`; tests shrink the timers. */
  eventStream?: EventStreamOptions;
}

export interface DaemonApp {
  app: Hono<AppEnv>;
  logger: Logger;
  onShutdown: (hook: ShutdownHook, name?: string) => void;
  handleShutdown: (signal?: string) => Promise<void>;
}

export interface ErrorBody {
  error: { code: string; message: string; details?: Array<{ path: string; message: string }> };
}

export function createApp(options: CreateAppOptions = {}): DaemonApp {
  const logger = options.logger ?? createLogger();
  const db = options.db;
  const executor = options.executor;
  const corsOrigin = options.corsOrigin ?? process.env["CORS_ORIGIN"] ?? DEFAULT_CORS_ORIGIN;

  const app = new Hono<AppEnv>();

  app.use(
    "*",
    cors({
      origin: corsOrigin,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round(performance.now() - start),
      },
      "request",
    );
  });

  app.use("*", (c, next) => {
    c.set("logger", logger);
    c.set("db", db);
    c.set("executor", executor);
    return next();
  });

  app.get("/health", (c) => c.json(healthPayload()));

  app.route("/api/projects", createProjectsRouter());
  app.route("/api/projects", createFilesRouter());
  app.route("/api/drivers", createDriversRouter(options.drivers));
  app.route("/api/workflows", createWorkflowsRouter());
  app.route("/api/runs", createRunsRouter({ eventStream: options.eventStream }));

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        { error: { code: err.code, message: err.message } } satisfies ErrorBody,
        err.status as ContentfulStatusCode,
      );
    }
    if (err instanceof ZodError) {
      const details = err.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      }));
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: details[0]?.message ?? "Validation failed",
            details,
          },
        } satisfies ErrorBody,
        422,
      );
    }
    logger.error({ err, method: c.req.method, path: c.req.path }, "unhandled error");
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } } satisfies ErrorBody,
      500,
    );
  });

  app.notFound((c) =>
    c.json(
      {
        error: { code: "NOT_FOUND", message: `No route for ${c.req.method} ${c.req.path}` },
      } satisfies ErrorBody,
      404,
    ),
  );

  const shutdown = createShutdownRegistry({ logger, ...options.shutdown });

  return { app, logger, onShutdown: shutdown.onShutdown, handleShutdown: shutdown.handleShutdown };
}
