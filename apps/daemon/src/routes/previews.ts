import { Hono, type Context } from "hono";
import type { AppEnv } from "../app.js";
import type { RunSandboxInfo } from "../executor.js";
import { UNDECLARED_PORT_HINT } from "../executor.js";
import { HttpError } from "../errors.js";
import {
  createPreviewProxy,
  forwardableSearch,
  parsePreviewPath,
  PREVIEW_UNAVAILABLE_HINT,
  resolvePreviewTarget,
} from "../preview-proxy.js";
import type { PreviewProxy } from "../preview-proxy.js";

/**
 * Preview proxy routes (#108): `/previews/:runId[/:port]/*` (canonical) and
 * the `/api/previews/…` alias, both method-passthrough
 * (GET/HEAD/POST/PUT/PATCH/DELETE). Port resolution: path segment → `?port=`
 * → first declared port. Only declared ports of a live sandbox proxy
 * (403 + declare-to-preview hint otherwise); no sandbox → 410; unknown run →
 * 404. The proxy itself streams both directions (see `preview-proxy.ts`).
 *
 * Auth: `/api/previews` is covered by the global `/api/*` gate; the bare
 * `/previews` mount gets the same middleware in `app.ts`. Both accept
 * `?token=` on GET (the iframe/EventSource fallback, #92). The route is a
 * rate-limit/payload-cap exempt "stream route" (#97), so proxied bodies are
 * not capped — the sandbox is the backstop.
 */

const PREVIEW_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

export interface PreviewRouterOptions {
  /** Injectable proxy service (tests shrink the timeouts). Defaults to {@link createPreviewProxy}. */
  proxy?: PreviewProxy;
}

export function createPreviewRouter(options: PreviewRouterOptions = {}): Hono<AppEnv> {
  const proxy = options.proxy ?? createPreviewProxy();

  const handler = async (c: Context): Promise<Response> => {
    const db = c.get("db");
    const executor = c.get("executor");
    if (db === undefined) {
      throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
    }
    if (executor === undefined) {
      throw new HttpError(503, "EXECUTOR_UNAVAILABLE", "executor is not configured");
    }

    // Parse the RAW (still-encoded) pathname so nothing is decoded before
    // it is re-attached to the upstream request line — encoded CR/LF stays
    // encoded (no request splitting; pinned by tests).
    const url = new URL(c.req.url);
    const parsed = parsePreviewPath(url.pathname);
    if (parsed === undefined || parsed === "malformed") {
      throw new HttpError(
        404,
        "PREVIEW_NOT_FOUND",
        `no preview route for ${c.req.method} ${c.req.path}`,
      );
    }
    // Path form wins; ?port= is the fallback for non-default ports. An
    // explicitly empty ?port= reads as absent (default port), not invalid.
    const portQuery = c.req.query("port");
    const explicitPort =
      parsed.explicitPort ?? (portQuery === undefined || portQuery === "" ? undefined : portQuery);

    const run = db.runs.get(parsed.runId);
    const sandbox: RunSandboxInfo | undefined = await executor.sandboxInfo(parsed.runId);
    const resolution = resolvePreviewTarget(run, sandbox, explicitPort);

    switch (resolution.outcome) {
      case "run_not_found":
        throw new HttpError(404, "RUN_NOT_FOUND", `no run with id ${parsed.runId}`);
      case "invalid_port":
        throw new HttpError(
          422,
          "INVALID_PORT",
          `port must be an integer 1..65535, got ${JSON.stringify(resolution.raw)}`,
        );
      case "no_ports":
        // Detected-but-undeclared ports keep the declare-to-preview hint so
        // the iframe shows something actionable instead of a bare 404.
        if (resolution.detected.length > 0) {
          throw new HttpError(
            403,
            "PREVIEW_PORT_NOT_DECLARED",
            `run ${parsed.runId} tracks ports ${resolution.detected.join(", ")} but declared none; declare ports on the run to preview them (${UNDECLARED_PORT_HINT})`,
            { detected: [...resolution.detected] },
          );
        }
        throw new HttpError(
          404,
          "PREVIEW_NO_PORTS",
          `run ${parsed.runId} declares no ports; create the run with ports: [<containerPort>, …] to preview it`,
        );
      case "not_declared":
        throw new HttpError(
          403,
          "PREVIEW_PORT_NOT_DECLARED",
          `port ${resolution.containerPort} is not declared on run ${parsed.runId}; declare ports on the run to preview them (${UNDECLARED_PORT_HINT})`,
          { containerPort: resolution.containerPort },
        );
      case "unmapped":
        // Declared + live sandbox but the mapping vanished: the container is
        // stopping/exited — surface as an upstream failure with the hint.
        throw new HttpError(
          502,
          "PREVIEW_UPSTREAM_UNAVAILABLE",
          `run ${parsed.runId} no longer maps container port ${resolution.containerPort} (sandbox stopping or exited); ${PREVIEW_UNAVAILABLE_HINT}`,
          { containerPort: resolution.containerPort },
        );
      case "gone": {
        const message = resolution.terminal
          ? `run ${parsed.runId} is ${resolution.status}; its sandbox and published ports are gone — re-run it to preview again`
          : `run ${parsed.runId} has no live sandbox (queued, or executing locally); only actively sandboxed runs expose previews`;
        throw new HttpError(410, "PREVIEW_GONE", message, {
          runStatus: resolution.status,
          terminal: resolution.terminal,
        });
      }
      case "ok":
        return proxy.proxy({
          runId: parsed.runId,
          containerPort: resolution.containerPort,
          hostPort: resolution.hostPort,
          method: c.req.method,
          targetPath: `/${parsed.subPath}${forwardableSearch(url.search)}`,
          headers: c.req.raw.headers,
          body: c.req.raw.body,
          clientSignal: c.req.raw.signal,
        });
    }
  };

  const router = new Hono<AppEnv>();
  for (const method of PREVIEW_METHODS) {
    router.on(method, "/:runId", handler);
    router.on(method, "/:runId/*", handler);
  }
  return router;
}
