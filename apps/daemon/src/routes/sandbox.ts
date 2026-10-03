import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import type { SandboxProvider, SandboxUsage, SandboxSummary } from "@openeuler/sandbox";
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
import { DEFAULT_SANDBOX_MEMORY_MB } from "@openeuler/engine";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@openeuler/db";
import { recordImageJobActivity } from "../activity.js";
import type { AppEnv } from "../app.js";
import { resolveExecutionMode } from "../executor.js";
import { HttpError } from "../errors.js";
import { createDockerStatusService, type DockerStatusOptions } from "../sandbox-status.js";

/**
 * Sandbox API (#100 images, #106 status).
 *
 * - `GET /api/sandbox/status` — docker availability detection (#106):
 *   `{available, version?, mode: "docker"|"unavailable", checkedAt}` from a
 *   60s-cached `docker info` probe + `docker --version`. `?refresh=1`
 *   bypasses the cache. `?projectId=<id>` adds `{projectMode, effective}` —
 *   the project's policy executionMode and the same local/sandbox resolution
 *   the executor applies to its runs (unknown projects answer 404).
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
 * - `GET /api/sandbox/instances` — the sandboxes dashboard (#112): every
 *   provider sandbox (`provider.list()`, newest first) joined with run rows
 *   (project name, run status, hosted flag) where the `run` label resolves,
 *   plus a live `usage` snapshot from `provider.stats()` when available (a
 *   stats hiccup omits usage, never fails the listing).
 * - `POST /api/sandbox/instances/:id/stop` — graceful container stop by
 *   `list()` id: the sandbox is KEPT (listed `stopped`, inspectable).
 * - `DELETE /api/sandbox/instances/:id` — typed destroy by id (#105's
 *   `provider.destroy`), idempotent.
 *
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

/** One `GET /api/sandbox/instances` row (#112). */
export interface SandboxInstanceBody {
  /** `list()` id (the docker container name). */
  id: string;
  /** Owning run id from the sandbox labels (`run`); null when unlabeled. */
  runId: string | null;
  image: string;
  status: SandboxSummary["status"];
  /** Epoch ms the sandbox was created. */
  startedAt: number;
  /**
   * Live usage from `provider.stats()` when available. `cpuPercent` is the
   * host-relative percentage (stats' fractional cores × host CPUs back into
   * percent); `memLimitMb` is the project policy's memory cap (engine
   * default when unset) — a soft reference for usage bars.
   */
  usage?: { cpuPercent?: number; memMb?: number; memLimitMb?: number };
  /** Joined run row when the labeled run still exists (hosted runs too). */
  run?: {
    id: string;
    status: string;
    project?: { id: string; name: string };
    /** True while the run's sandbox is hosted past success (#110). */
    hosted?: boolean;
  };
}

/** `GET /api/sandbox/instances` payload (#112). */
export interface SandboxInstancesBody {
  instances: SandboxInstanceBody[];
  /** Epoch ms of the `list()` snapshot. */
  checkedAt: number;
}

/** Options for {@link createSandboxRouter}. */
export interface SandboxRouterOptions {
  /** Sandbox provider backing the in-use check; omit → 503 SANDBOX_UNAVAILABLE. */
  provider?: SandboxProvider;
  /** Injectable image-operation knobs (scripted runners for tests). */
  images?: SandboxImagesOptions;
  /**
   * Docker availability detection (#106): `GET /api/sandbox/status`. index.ts
   * passes its boot-warmed service; tests inject the probe/version runner.
   */
  status?: DockerStatusOptions;
  /** Cap on finished jobs kept in the registry (oldest pruned). Default 200. */
  maxFinishedJobs?: number;
  /** Cap on concurrently-running pull/build jobs (each spawns a docker child). Default 4. */
  maxConcurrentJobs?: number;
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
  const maxConcurrentJobs = options.maxConcurrentJobs ?? 4;

  const jobs = new Map<string, SandboxJob>();
  /** running-job ids by `${kind}:${normalizedRef}` for dedupe. */
  const runningByKey = new Map<string, string>();
  /** Docker availability resolver (#106); shared boot-warmed instance in prod. */
  const dockerStatus = options.status?.service ?? createDockerStatusService(options.status);

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
    // Cap CONCURRENT jobs too: each job spawns a docker pull/build child —
    // trusted users only, but a cheap DoS guard regardless.
    const runningCount = [...jobs.values()].filter((job) => job.status === "running").length;
    if (runningCount >= maxConcurrentJobs) {
      throw new HttpError(
        429,
        "TOO_MANY_JOBS",
        `too many concurrent image jobs (max ${maxConcurrentJobs}); retry shortly`,
      );
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

  // Docker availability (#106). Availability + CLI version resolve through the
  // 60s-cached service; `?projectId=` layers the project's policy mode and the
  // effective local/sandbox resolution on top — the SAME resolveExecutionMode
  // the executor uses at run time, so the hint never disagrees with reality.
  router.get("/status", async (c) => {
    const status = await dockerStatus.status({
      refresh: c.req.query("refresh") === "1",
    });
    const projectId = c.req.query("projectId")?.trim();
    if (projectId === undefined || projectId === "") return c.json(status);
    const db = c.get("db");
    if (db === undefined) {
      throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
    }
    const project = db.projects.get(projectId);
    if (project === undefined) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", `no project with id ${projectId}`);
    }
    return c.json({
      ...status,
      projectId: project.id,
      projectMode: project.sandboxPolicy?.executionMode ?? "local",
      effective: resolveExecutionMode(project.sandboxPolicy, status.available),
    });
  });

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

  // Sandboxes dashboard (#112): provider sandboxes joined with run rows.
  // No provider → 503 like every sandbox route; a provider/daemon hiccup on
  // list() surfaces typed; a stats() hiccup only drops the usage column.
  router.get("/instances", async (c) => {
    const sandboxProvider = provider();
    const db = c.get("db");
    let summaries: SandboxSummary[];
    try {
      summaries = await sandboxProvider.list();
    } catch (err) {
      if (err instanceof SandboxError) throw sandboxHttpError(err);
      throw err;
    }

    const usageById = new Map<string, SandboxUsage>();
    if (sandboxProvider.stats !== undefined) {
      try {
        for (const usage of await sandboxProvider.stats()) {
          if (usage.id !== "") usageById.set(usage.id, usage);
        }
      } catch (err) {
        c.get("logger").warn({ err }, "sandbox stats() failed — instances listed without usage");
      }
    }

    // The docker provider reports fractional HOST cores; back into a percent
    // with the daemon's own CPU count (same host in every real deployment).
    const hostCpus = cpus().length || 1;
    const instances: SandboxInstanceBody[] = summaries.map((summary) => {
      const runId = summary.labels["run"] ?? null;
      let run: SandboxInstanceBody["run"];
      let memLimitMb: number | undefined;
      if (runId !== null && db !== undefined) {
        const row = db.runs.get(runId);
        if (row !== undefined) {
          const project = db.projects.get(row.projectId);
          run = {
            id: row.id,
            status: row.status,
            ...(project === undefined ? {} : { project: { id: project.id, name: project.name } }),
            ...(row.hostedUntil === undefined || row.hostedUntil === null ? {} : { hosted: true }),
          };
          const policyMb = project?.sandboxPolicy?.memoryMb;
          memLimitMb = policyMb ?? DEFAULT_SANDBOX_MEMORY_MB;
        }
      }
      const usage = usageById.get(summary.id);
      const cpuPercent =
        usage?.cpus !== undefined && Number.isFinite(usage.cpus) && usage.cpus >= 0
          ? Math.min(100, Math.round((usage.cpus / hostCpus) * 1000) / 10)
          : undefined;
      const memMb = usage?.memoryMb;
      const hasUsage = cpuPercent !== undefined || memMb !== undefined || memLimitMb !== undefined;
      return {
        id: summary.id,
        runId,
        image: summary.image,
        status: summary.status,
        startedAt: summary.createdAt,
        ...(hasUsage
          ? {
              usage: {
                ...(cpuPercent === undefined ? {} : { cpuPercent }),
                ...(memMb === undefined ? {} : { memMb }),
                ...(memLimitMb === undefined ? {} : { memLimitMb }),
              },
            }
          : {}),
        ...(run === undefined ? {} : { run }),
      };
    });
    // Newest first; ties (same-ms creations) break on id like the runs table.
    instances.sort((a, b) =>
      a.startedAt === b.startedAt ? (a.id < b.id ? -1 : 1) : b.startedAt - a.startedAt,
    );
    return c.json({ instances, checkedAt: Date.now() } satisfies SandboxInstancesBody);
  });

  /** Resolves 404 unless `id` is one of the provider's listed sandboxes. */
  const requireKnownInstance = async (
    sandboxProvider: SandboxProvider,
    id: string,
  ): Promise<void> => {
    let listed: SandboxSummary[];
    try {
      listed = await sandboxProvider.list();
    } catch (err) {
      if (err instanceof SandboxError) throw sandboxHttpError(err);
      throw err;
    }
    if (!listed.some((summary) => summary.id === id)) {
      throw new HttpError(404, "SANDBOX_NOT_FOUND", `no sandbox with id ${id}`);
    }
  };

  router.post("/instances/:id/stop", async (c) => {
    const sandboxProvider = provider();
    const id = c.req.param("id");
    await requireKnownInstance(sandboxProvider, id);
    if (sandboxProvider.stop === undefined) {
      throw new HttpError(
        501,
        "SANDBOX_STOP_UNSUPPORTED",
        `sandbox provider "${sandboxProvider.id}" cannot stop sandboxes by id`,
      );
    }
    try {
      await sandboxProvider.stop(id);
    } catch (err) {
      if (err instanceof SandboxError) throw sandboxHttpError(err);
      throw err;
    }
    c.get("logger").info({ sandbox: id }, "sandbox stopped from the dashboard (kept)");
    return c.json({ stopped: id });
  });

  router.delete("/instances/:id", async (c) => {
    const sandboxProvider = provider();
    const id = c.req.param("id");
    await requireKnownInstance(sandboxProvider, id);
    if (sandboxProvider.destroy === undefined) {
      throw new HttpError(
        501,
        "SANDBOX_DESTROY_UNSUPPORTED",
        `sandbox provider "${sandboxProvider.id}" cannot destroy sandboxes by id`,
      );
    }
    try {
      await sandboxProvider.destroy(id);
    } catch (err) {
      if (err instanceof SandboxError) throw sandboxHttpError(err);
      throw err;
    }
    c.get("logger").info({ sandbox: id }, "sandbox destroyed from the dashboard");
    return c.json({ deleted: id });
  });

  return router;
}
