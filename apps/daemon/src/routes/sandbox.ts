import { randomUUID } from "node:crypto";
import type { SandboxProvider } from "@openeuler/sandbox";
import { SandboxError } from "@openeuler/sandbox";
import type { SandboxImagesOptions } from "@openeuler/sandbox";
import {
  buildSandboxImage,
  imageNameIssue,
  imageBuildTag,
  imageRefIssue,
  listSandboxImages,
  normalizeImageRef,
  pullSandboxImage,
  removeSandboxImage,
} from "@openeuler/sandbox";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@openeuler/db";
import { recordImageJobActivity } from "../activity.js";
import type { AppEnv } from "../app.js";
import { HttpError } from "../errors.js";

/**
 * Sandbox image management API (#100).
 *
 * - `GET /api/sandbox/images` — the image catalog: images under the
 *   `openeuler/` namespace (ours, built via this API) plus a curated list of
 *   common base images when present locally. Docker cannot label images, so
 *   the namespace prefix is the ownership marker (`ours` flag).
 * - `POST /api/sandbox/images/pull {ref}` — async: 202 `{jobId}`; the pull
 *   runs in the background and emits one `ops.image-pull` activity event at
 *   completion (no per-line progress events). Concurrent pulls of the same
 *   ref are deduped onto one job. Poll `GET /api/sandbox/jobs/:id`.
 * - `POST /api/sandbox/images/build {name, dockerfileText?, baseRef?}` —
 *   async build of `openeuler/<name>:latest` from a Dockerfile sent on stdin
 *   with an EMPTY build context (v0.2 constraint: `COPY`/`ADD` have no files
 *   to copy and fail). When `dockerfileText` is omitted, `baseRef` synthesizes
 *   `FROM <baseRef>`. 202 `{jobId}` + `ops.image-build` on completion.
 * - `DELETE /api/sandbox/images/:ref` — `docker rmi`; 409 `IMAGE_IN_USE`
 *   while a provider sandbox runs the image, 404 after inspecting an unknown
 *   ref.
 * - `GET /api/sandbox/jobs/:id` — in-memory job registry (running | done |
 *   failed, plus the failure message). Jobs live for the daemon process only.
 *
 * `GET /api/sandbox/status` is a different issue (#106) and lives elsewhere.
 * Auth + rate limits apply automatically (mounted under `/api`).
 */

/** One image-job record (in-memory; lost on daemon restart by design). */
export interface SandboxJob {
  id: string;
  kind: "pull" | "build";
  /** Pulled ref or built tag. */
  ref: string;
  status: "running" | "done" | "failed";
  /** Failure message when `status === "failed"`. */
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

/** Options for {@link createSandboxRouter}. */
export interface SandboxRouterOptions {
  /** Sandbox provider backing the in-use check; omit → 503 SANDBOX_UNAVAILABLE. */
  provider?: SandboxProvider;
  /** Injectable image-operation knobs (scripted runners for tests). */
  images?: SandboxImagesOptions;
  /** Cap on finished jobs kept in the registry (oldest pruned). Default 200. */
  maxFinishedJobs?: number;
}

const PullBodySchema = z.strictObject({
  ref: z.string().min(1).max(255),
});

const BuildBodySchema = z.strictObject({
  name: z.string().min(1).max(64),
  dockerfileText: z.string().max(512_000).optional(),
  baseRef: z.string().min(1).max(255).optional(),
});

/** Maps a `SandboxError` onto the HTTP surface of these routes. */
function sandboxHttpError(err: SandboxError): HttpError {
  switch (err.code) {
    case "SANDBOX_UNAVAILABLE":
      return new HttpError(503, "SANDBOX_UNAVAILABLE", err.message);
    case "SANDBOX_IMAGE_MISSING":
      return new HttpError(404, "IMAGE_NOT_FOUND", err.message);
    case "SANDBOX_IMAGE_IN_USE":
      return new HttpError(409, "IMAGE_IN_USE", err.message);
    case "SANDBOX_INVALID_SPEC":
      return new HttpError(422, "VALIDATION_ERROR", err.message);
    default:
      return new HttpError(500, "SANDBOX_ERROR", err.message);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSandboxRouter(options: SandboxRouterOptions = {}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const imageOptions = options.images ?? {};
  const maxFinishedJobs = options.maxFinishedJobs ?? 200;

  const jobs = new Map<string, SandboxJob>();
  /** running-job ids by `${kind}:${normalizedRef}` for dedupe. */
  const runningByKey = new Map<string, string>();

  const pruneFinished = (): void => {
    const finished = [...jobs.values()].filter((job) => job.status !== "running");
    if (finished.length <= maxFinishedJobs) return;
    finished
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
      .slice(0, finished.length - maxFinishedJobs)
      .forEach((job) => jobs.delete(job.id));
  };

  const provider = (): SandboxProvider => {
    if (options.provider === undefined) {
      throw new HttpError(503, "SANDBOX_UNAVAILABLE", "no sandbox provider is configured");
    }
    return options.provider;
  };

  /**
   * Starts a background pull/build job. The HTTP response is the 202 below;
   * completion lands in the job record and one ops activity event. Dedupes
   * concurrent jobs of the same kind+ref onto the existing job.
   */
  const startJob = (
    c: { get(key: "db"): Db | undefined },
    kind: "pull" | "build",
    ref: string,
    run: () => Promise<void>,
    payloadName?: string,
  ): SandboxJob => {
    const key = `${kind}:${normalizeImageRef(ref)}`;
    const existingId = runningByKey.get(key);
    if (existingId !== undefined) {
      const existing = jobs.get(existingId);
      if (existing !== undefined && existing.status === "running") return existing;
    }
    const job: SandboxJob = {
      id: randomUUID(),
      kind,
      ref,
      status: "running",
      createdAt: Date.now(),
    };
    jobs.set(job.id, job);
    runningByKey.set(key, job.id);
    void (async () => {
      try {
        await run();
        job.status = "done";
        job.finishedAt = Date.now();
        recordImageJobActivity(
          c.get("db"),
          kind === "pull" ? "ops.image-pull" : "ops.image-build",
          {
            ref,
            ...(payloadName === undefined ? {} : { name: payloadName }),
            done: true,
          },
        );
      } catch (err) {
        job.status = "failed";
        job.error = errorMessage(err);
        job.finishedAt = Date.now();
        recordImageJobActivity(
          c.get("db"),
          kind === "pull" ? "ops.image-pull" : "ops.image-build",
          {
            ref,
            ...(payloadName === undefined ? {} : { name: payloadName }),
            done: false,
            error: job.error,
          },
        );
      } finally {
        if (runningByKey.get(key) === job.id) runningByKey.delete(key);
        pruneFinished();
      }
    })();
    return job;
  };

  router.get("/images", async (c) => {
    try {
      return c.json({ images: await listSandboxImages(imageOptions) });
    } catch (err) {
      if (err instanceof SandboxError) throw sandboxHttpError(err);
      throw err;
    }
  });

  router.post("/images/pull", async (c) => {
    const body = PullBodySchema.parse(
      await c.req.json().catch(() => {
        throw new HttpError(422, "VALIDATION_ERROR", "pull body must be JSON: {ref}");
      }),
    );
    const issue = imageRefIssue(body.ref);
    if (issue !== null) throw new HttpError(422, "VALIDATION_ERROR", issue);
    const job = startJob(c, "pull", body.ref, async () => {
      await pullSandboxImage(body.ref, imageOptions);
    });
    return c.json({ jobId: job.id }, 202);
  });

  router.post("/images/build", async (c) => {
    const body = BuildBodySchema.parse(
      await c.req.json().catch(() => {
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "build body must be JSON: {name, dockerfileText}",
        );
      }),
    );
    const nameIssue = imageNameIssue(body.name);
    if (nameIssue !== null) throw new HttpError(422, "VALIDATION_ERROR", nameIssue);
    // Empty Dockerfile + baseRef hint → synthesize `FROM <baseRef>`.
    const dockerfileText =
      body.dockerfileText !== undefined && body.dockerfileText.trim() !== ""
        ? body.dockerfileText
        : body.baseRef !== undefined
          ? `FROM ${body.baseRef}\n`
          : undefined;
    if (dockerfileText === undefined) {
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "dockerfileText is required when no baseRef is given",
      );
    }
    if (body.baseRef !== undefined) {
      const baseIssue = imageRefIssue(body.baseRef);
      if (baseIssue !== null) throw new HttpError(422, "VALIDATION_ERROR", `baseRef: ${baseIssue}`);
    }
    const tag = imageBuildTag(body.name);
    const job = startJob(
      c,
      "build",
      tag,
      async () => {
        await buildSandboxImage({ name: body.name, dockerfileText }, imageOptions);
      },
      body.name,
    );
    return c.json({ jobId: job.id, tag }, 202);
  });

  router.delete("/images/:ref{.+}", async (c) => {
    // Refs contain `/` and `:` — the route param is a catch-all and arrives
    // percent-encoded; decode once (Hono decodes plain params, but a %2F
    // inside a segment round-trips differently across versions).
    const raw = c.req.param("ref");
    let ref: string;
    try {
      ref = decodeURIComponent(raw);
    } catch {
      ref = raw;
    }
    const issue = imageRefIssue(ref);
    if (issue !== null) throw new HttpError(422, "VALIDATION_ERROR", issue);

    // In-use check first (cheap `provider.list()`): every provider sandbox
    // carries its spec image; an image a sandbox runs on must not be removed.
    const sandboxes = await provider().list();
    const normalized = normalizeImageRef(ref);
    const holders = sandboxes
      .filter((summary) => normalizeImageRef(summary.image) === normalized)
      .map((summary) => summary.id);
    if (holders.length > 0) {
      throw new HttpError(
        409,
        "IMAGE_IN_USE",
        `image "${ref}" is used by ${holders.length} sandbox${holders.length === 1 ? "" : "es"}`,
        { sandboxes: holders },
      );
    }

    try {
      await removeSandboxImage(ref, imageOptions);
    } catch (err) {
      if (err instanceof SandboxError) throw sandboxHttpError(err);
      throw err;
    }
    return c.json({ deleted: ref });
  });

  router.get("/jobs/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (job === undefined) {
      throw new HttpError(404, "JOB_NOT_FOUND", "no such image job (jobs are in-memory)");
    }
    return c.json(job);
  });

  return router;
}
