import type { Db } from "@openeuler/db";
import type { DriverRegistry } from "@openeuler/drivers";
import type { ArtifactStore, WorktreeManager } from "@openeuler/engine";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { createAuthMiddleware, redactTokenQuery, resolveAuthToken } from "./auth.js";
import { resolveMaxConcurrentRuns } from "./concurrency.js";
import type { Executor } from "./executor.js";
import { HttpError } from "./errors.js";
import { healthPayload, minimalHealthPayload } from "./health.js";
import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { METRICS_CONTENT_TYPE, countActiveSandboxes, scrapeMetrics } from "./metrics.js";
import { createShutdownRegistry } from "./shutdown.js";
import type { ShutdownHook, ShutdownRegistryOptions } from "./shutdown.js";
import { createProjectsRouter } from "./routes/projects.js";
import type { ProjectsRouterOptions } from "./routes/projects.js";
import { createDriversRouter } from "./routes/drivers.js";
import { createFilesRouter } from "./routes/files.js";
import { createPresetsRouter } from "./routes/presets.js";
import { createSandboxRouter } from "./routes/sandbox.js";
import type { SandboxRouterOptions } from "./routes/sandbox.js";
import { createSecretsRouter } from "./routes/secrets.js";
import { createPreviewRouter } from "./routes/previews.js";
import type { PreviewRouterOptions } from "./routes/previews.js";
import type { EventStreamOptions, GlobalStreamOptions } from "./routes/runs.js";
import { createRunsRouter } from "./routes/runs.js";
import type { SystemRouterOptions } from "./routes/system.js";
import { createSystemRouter } from "./routes/system.js";
import { createWorktreesRouter } from "./routes/worktrees.js";
import type { WorktreesRouterOptions } from "./routes/worktrees.js";
import { createWorkflowsRouter } from "./routes/workflows.js";
import { createWorkflowWebhooksRouter } from "./routes/webhooks.js";
import { createHooksRouter } from "./routes/webhooks.js";
import { createWorkflowSchedulesRouter } from "./routes/schedules.js";
import { createActivityRouter } from "./routes/activity.js";
import { createRateLimitMiddleware, resolveRateLimits, resolveTrustProxy } from "./rate-limit.js";
import {
  corsOriginSetting,
  createPayloadCapMiddleware,
  createSecurityHeadersMiddleware,
  DEFAULT_CORS_ORIGIN,
  parseCorsOrigins,
  resolveFramePolicy,
  resolveMaxBodyBytes,
} from "./security.js";

export { DEFAULT_CORS_ORIGIN } from "./security.js";

export interface AppEnv {
  Variables: {
    logger: Logger;
    db: Db | undefined;
    executor: Executor | undefined;
    /** Worktree manager; required for live cumulative diffs (`GET /api/runs/:id/diff`). */
    worktrees: WorktreeManager | undefined;
    /** Artifact store (#122); backs the run artifacts list/download routes. */
    artifacts: ArtifactStore | undefined;
    /** Master key for project secrets (#93); unset = secrets routes answer 503. */
    secretsKey: Buffer | undefined;
  };
}

export interface CreateAppOptions {
  db?: Db;
  logger?: Logger;
  executor?: Executor;
  /** Worktree manager backing cumulative run diffs; index.ts passes the daemon-wide instance. */
  worktrees?: WorktreeManager;
  /**
   * Artifact store backing the run artifacts API (#122); index.ts passes the
   * daemon-wide instance rooted at `<data dir>/artifacts`.
   */
  artifacts?: ArtifactStore;
  /** Driver registry composed at boot; backs `GET /api/drivers`. */
  drivers?: DriverRegistry;
  corsOrigin?: string;
  shutdown?: ShutdownRegistryOptions;
  /** SSE tuning for `GET /api/runs/:id/events`; tests shrink the timers. */
  eventStream?: EventStreamOptions;
  /** SSE tuning for the global `GET /api/runs/stream`; tests shrink the timers. */
  globalStream?: GlobalStreamOptions;
  /**
   * `GET /api/system/check` tuning (#53): probe binaries, timeouts and cache
   * TTL. Defaults probe `git` / `opencode` from PATH and cache for 30s.
   */
  system?: SystemRouterOptions;
  /**
   * Concurrency cap reported by `/health`. Defaults to
   * `$MAX_CONCURRENT_RUNS` (integer >= 1), then 2; the executor applies the
   * same resolution, so index.ts passes its resolved value to keep them equal.
   */
  maxConcurrentRuns?: number;
  /**
   * Bearer-token auth (#92): when set, every `/api/*` route requires
   * `Authorization: Bearer <token>` (GET streaming routes also accept
   * `?token=`). Defaults to `$OPENEULER_TOKEN`; unset = open mode.
   */
  authToken?: string;
  /**
   * Master key for per-project secrets (#93), loaded at boot by
   * `loadOrCreateSecretKey`. Without it the secrets API answers 503 and
   * runs execute without secret env injection.
   */
  secretsKey?: Buffer;
  /**
   * Rate limiting (#97): per-minute caps per route class, 0 disables a
   * class. Defaults `$RATE_LIMIT_MUTATE`=120 (burst 30) /
   * `$RATE_LIMIT_READ`=600; SSE/stream routes and `/metrics` are exempt.
   */
  rateLimit?: { mutatePerMin?: number; readPerMin?: number; mutateBurst?: number };
  /**
   * Trust `X-Forwarded-For` for rate-limit bucket keys (#97) — keyed on the
   * rightmost hop (single trusted proxy tier; see `clientIp`). Only enable
   * behind a reverse proxy you control. Defaults to `$TRUST_PROXY=1`.
   */
  trustProxy?: boolean;
  /** Request-body cap in bytes (#97): `/api/*` bodies above it answer 413. Defaults `$MAX_BODY_BYTES`=1 MiB. */
  maxBodyBytes?: number;
  /**
   * Raw `frame-ancestors` sources (#97), used verbatim in the CSP header,
   * e.g. `"'self' https://trusted.host"`. Defaults to `'none'`
   * (+ `X-Frame-Options: DENY`); see `resolveFramePolicy`.
   */
  frameAncestors?: string;
  /**
   * M7 preview-iframe placeholder (#97): allow framing by the app itself
   * and the CORS allowlist instead of denying framing outright. Defaults to
   * `$PREVIEW_IFRAME=1`.
   */
  previewIframe?: boolean;
  /**
   * Sandbox image management (#100): the provider backing the in-use check
   * plus injectable docker CLI runners for the image catalog/pull/build
   * operations. index.ts passes the boot-composed docker provider.
   */
  sandbox?: SandboxRouterOptions;
  /**
   * Projects router tuning (#105): injectable docker CLI runner for the
   * project-delete cache-volume cleanup (tests script it).
   */
  projects?: ProjectsRouterOptions;
  /**
   * Worktree manager UI tuning (#111): injectable `du` binary, timeout and
   * cache TTL for `GET /api/projects/:id/worktrees` (tests script the
   * sizing).
   */
  worktreeRoutes?: WorktreesRouterOptions;
  /**
   * Preview proxy tuning (#108): injectable proxy service — tests shrink
   * the connect/overall timeouts. Routes mount at BOTH `/previews/…` (the
   * canonical iframe URL) and `/api/previews/…` (API-origin alias).
   */
  previews?: PreviewRouterOptions;
}

export interface DaemonApp {
  app: Hono<AppEnv>;
  logger: Logger;
  /** True when the bearer-token middleware is active (#92). */
  authRequired: boolean;
  onShutdown: (hook: ShutdownHook, name?: string) => void;
  handleShutdown: (signal?: string) => Promise<void>;
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    /** Zod 422 issue list, or a structured payload (e.g. REVISION_CONFLICT's currentRevision). */
    details?: Array<{ path: string; message: string }> | Record<string, unknown>;
  };
}

export function createApp(options: CreateAppOptions = {}): DaemonApp {
  const logger = options.logger ?? createLogger();
  const db = options.db;
  const executor = options.executor;
  const worktrees = options.worktrees;
  const artifacts = options.artifacts;
  // CORS allowlist (#97): `CORS_ORIGIN` may be a comma-separated list;
  // every entry must match a request's Origin exactly for the ACAO header
  // to be sent (hono cors: string = single exact match, array = any exact
  // match, unmatched origins get no ACAO at all).
  const corsOrigin = options.corsOrigin ?? process.env["CORS_ORIGIN"] ?? DEFAULT_CORS_ORIGIN;
  const corsOrigins = parseCorsOrigins(corsOrigin);
  const maxConcurrentRuns =
    options.maxConcurrentRuns ?? resolveMaxConcurrentRuns(process.env["MAX_CONCURRENT_RUNS"]);
  // Explicit option wins over the env var; both go through the same
  // trim/empty-means-unset normalization.
  const authToken = resolveAuthToken({
    ...process.env,
    ...(options.authToken === undefined ? {} : { OPENEULER_TOKEN: options.authToken }),
  });
  const authRequired = authToken !== undefined;
  // A set-but-empty OPENEULER_TOKEN is almost certainly a misconfiguration
  // (someone meant to lock the daemon) — surface it loudly at boot instead
  // of silently degrading to open mode.
  if (
    !authRequired &&
    (process.env.OPENEULER_TOKEN ?? "").trim() === "" &&
    process.env.OPENEULER_TOKEN !== undefined
  ) {
    options.logger?.warn(
      { env: "OPENEULER_TOKEN" },
      "OPENEULER_TOKEN is set but empty — running in OPEN mode; set a non-empty value to require auth",
    );
  }

  const app = new Hono<AppEnv>();

  // Hardening (#97). Security headers come first so even CORS preflight
  // 204s carry them. Rate limits shed load before auth (brute-force
  // attempts burn the attacker's own bucket); the payload cap rejects
  // oversized bodies before any handler buffers them. Both cover /api/*
  // only and leave stream routes (`/api/runs/*/events`, `/api/runs/stream`,
  // previews, `/metrics`) untouched.
  const frameAncestorsEnv = process.env["FRAME_ANCESTORS"]?.trim();
  app.use(
    "*",
    createSecurityHeadersMiddleware(
      resolveFramePolicy({
        frameAncestors:
          options.frameAncestors ?? (frameAncestorsEnv ? frameAncestorsEnv : undefined),
        previewIframe: options.previewIframe ?? process.env["PREVIEW_IFRAME"]?.trim() === "1",
        corsOrigins,
      }),
    ),
  );

  app.use(
    "*",
    cors({
      origin: corsOriginSetting(corsOrigins),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const queryIndex = c.req.url.indexOf("?");
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        // Query string with the SSE `token` param redacted (#92) — the token
        // must never reach the logs.
        ...(queryIndex === -1 ? {} : { query: redactTokenQuery(c.req.url.slice(queryIndex)) }),
        status: c.res.status,
        durationMs: Math.round(performance.now() - start),
      },
      "request",
    );
  });

  // Rate limits + payload caps (#97) run before auth so brute-force and
  // oversized requests are shed cheaply; see the hardening block above.
  const rateLimits = { ...resolveRateLimits(process.env), ...(options.rateLimit ?? {}) };
  const trustProxy = options.trustProxy ?? resolveTrustProxy(process.env);
  app.use(
    "/api/*",
    createRateLimitMiddleware({
      config: rateLimits,
      mutateBurst: options.rateLimit?.mutateBurst,
      trustProxy,
      logger,
    }),
  );
  app.use(
    "/api/*",
    createPayloadCapMiddleware({
      maxBytes: options.maxBodyBytes ?? resolveMaxBodyBytes(process.env["MAX_BODY_BYTES"]),
    }),
  );

  // Bearer-token gate (#92): every /api/* route except the open auth-status
  // probe. No-op in open mode (no OPENEULER_TOKEN).
  if (authToken !== undefined) {
    app.use("/api/*", createAuthMiddleware({ token: authToken, logger }));
    // `/metrics` (#94) sits outside /api but is token-gated too: bearer
    // header, or `?token=` on GET (scrapers often cannot set headers).
    app.use("/metrics", createAuthMiddleware({ token: authToken, logger }));
    // #108: the canonical `/previews/:runId/…` mount also sits outside
    // /api — same gate (GET previews accept `?token=` via the stream-route
    // patterns in auth.ts, so header-less iframes still work).
    app.use("/previews/*", createAuthMiddleware({ token: authToken, logger }));
  }

  app.use("*", (c, next) => {
    c.set("logger", logger);
    c.set("db", db);
    c.set("executor", executor);
    c.set("worktrees", worktrees);
    c.set("artifacts", artifacts);
    c.set("secretsKey", options.secretsKey);
    return next();
  });

  app.get("/health", (c) =>
    c.json(authRequired ? minimalHealthPayload() : healthPayload(maxConcurrentRuns)),
  );

  // Prometheus scrape endpoint (#94): gauges refreshed on scrape from cheap
  // sqlite counts + in-memory executor/worktree state (see metrics.ts). The
  // sandbox gauge (#102) needs one async provider.list() round-trip.
  app.get("/metrics", async (c) => {
    const sandboxesActive = await countActiveSandboxes({
      ...(options.sandbox?.provider === undefined
        ? {}
        : { sandbox: { provider: options.sandbox.provider } }),
    });
    return c.newResponse(
      scrapeMetrics({
        db,
        executor,
        worktrees,
        ...(sandboxesActive === undefined ? {} : { sandboxesActive }),
      }),
      200,
      { "Content-Type": METRICS_CONTENT_TYPE },
    );
  });

  app.route("/api/projects", createProjectsRouter(options.projects));
  app.route("/api/projects", createFilesRouter());
  app.route("/api/projects", createPresetsRouter());
  app.route("/api/projects", createSecretsRouter());
  // Worktree manager UI (#111): per-project listing + prune.
  app.route("/api/projects", createWorktreesRouter(options.worktreeRoutes));
  app.route("/api/drivers", createDriversRouter(options.drivers));
  // Sandbox image management (#100); `GET /api/sandbox/status` is #106.
  app.route("/api/sandbox", createSandboxRouter(options.sandbox));
  // The system router reads the worktree store root from the context and
  // reports the boot driver registry + resolved concurrency cap (#95).
  app.route(
    "/api/system",
    createSystemRouter({
      drivers: options.drivers,
      maxConcurrentRuns,
      ...options.system,
      authRequired,
    }),
  );
  app.route("/api/workflows", createWorkflowsRouter());
  // #120: per-workflow webhook management (normal auth) + the signature-
  // authenticated inbound trigger mount (own auth — see routes/webhooks.ts;
  // the bearer gate exempts the /api/hooks/ prefix).
  app.route("/api/workflows", createWorkflowWebhooksRouter());
  app.route("/api/hooks", createHooksRouter({ authToken }));
  // #121: per-workflow cron schedule management (normal auth); the daemon's
  // minute ticker (scheduler.ts, started in index.ts) mints the runs.
  app.route("/api/workflows", createWorkflowSchedulesRouter());
  app.route(
    "/api/runs",
    createRunsRouter({
      eventStream: options.eventStream,
      globalStream: options.globalStream,
      worktrees,
      artifacts,
    }),
  );
  app.route("/api/activity", createActivityRouter());

  // Run preview proxy (#108): `/previews/:runId[/:port]/*` streams to the
  // run's live sandbox port; `/api/previews/…` is the same router under the
  // API prefix (auth + exemption patterns cover both mounts).
  app.route("/previews", createPreviewRouter(options.previews));
  app.route("/api/previews", createPreviewRouter(options.previews));

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details === undefined ? {} : { details: err.details }),
          },
        } satisfies ErrorBody,
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

  return {
    app,
    logger,
    authRequired,
    onShutdown: shutdown.onShutdown,
    handleShutdown: shutdown.handleShutdown,
  };
}
