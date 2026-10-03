import { SandboxError } from "./error.js";
import {
  defaultDockerCliRunner,
  defaultDockerStdinCliRunner,
  docker,
  isDaemonDown,
  isImageMissingText,
  stderrTail,
  type DockerCliRunner,
  type DockerStdinCliRunner,
} from "./docker-cli.js";
import { IMAGE_REF_PATTERN } from "./docker.js";

/**
 * Image catalog + pull/build/remove helpers for the docker provider (#100).
 *
 * The catalog is NOT every image on the host — that would leak unrelated
 * local images into the daemon API. It is the union of:
 *
 * - **ours**: repositories under the {@link OPENEULER_IMAGE_NAMESPACE} prefix
 *   (built via `POST /build` or tagged manually), and
 * - **common bases**: a curated list of small, useful base images
 *   ({@link COMMON_BASE_IMAGES}) shown with `ours: false` when present.
 *
 * Docker cannot label images, so the namespace prefix IS the ownership
 * marker. Pull accepts any valid public ref; pulled bases land under their
 * upstream repository/tag.
 */

/** Repository namespace every image built by this daemon is tagged into. */
export const OPENEULER_IMAGE_NAMESPACE = "openeuler/";

/** Tag applied to images built from a Dockerfile (#100). */
export const OPENEULER_IMAGE_TAG = "latest";

/**
 * Curated common base images offered in the catalog when present locally.
 * Pulling one of these (or any other ref) via the API makes it appear here.
 */
export const COMMON_BASE_IMAGES: readonly string[] = [
  "node:22-alpine",
  "python:3.12-slim",
  "golang:1.23",
  "alpine:3.20",
  "busybox:musl",
  "denoland/deno:2",
];

/** Build names must be flat, lowercase, slash-free (they live in one repo). */
export const IMAGE_NAME_PATTERN = /^[a-z0-9._-]+$/;

/** One catalog row as served by `GET /api/sandbox/images`. */
export interface SandboxImageEntry {
  /** Repository without tag, e.g. `"openeuler/worker"` or `"busybox"`. */
  repository: string;
  /** Tag, e.g. `"latest"`; never `"<none>"` (dangling images are skipped). */
  tag: string;
  /** Image id — full `sha256:…` when the enriching inspect succeeded. */
  id: string;
  /** Size on disk in bytes. */
  sizeBytes: number;
  /** Creation time, epoch ms. */
  createdAt: number;
  /** True when the repository is under our namespace (built by us). */
  ours: boolean;
}

/** Injectable knobs for every image operation; defaults hit the real CLI. */
export interface SandboxImagesOptions {
  /** CLI runner for non-stdin commands (tests script this). */
  runner?: DockerCliRunner;
  /** CLI runner for stdin commands (`docker build -`); tests script this. */
  stdinRunner?: DockerStdinCliRunner;
  /** Timeout for `docker images` + batch `image inspect`. Default 60s. */
  listTimeoutMs?: number;
  /** Timeout for one `docker pull`. Default 600s. */
  pullTimeoutMs?: number;
  /** Timeout for one `docker build`. Default 600s. */
  buildTimeoutMs?: number;
}

/** Client-side mirror of the daemon's pull-ref rules; null when valid. */
export function imageRefIssue(ref: string): string | null {
  if (typeof ref !== "string" || ref.length === 0) return "image ref must be non-empty";
  if (ref.length > 255) return "image ref must be at most 255 characters";
  if (ref !== ref.trim()) return "image ref must not have leading/trailing whitespace";
  if (ref.startsWith("-")) return "image ref must not start with a dash";
  if (!IMAGE_REF_PATTERN.test(ref)) {
    return "image ref may only use a-z 0-9 . _ / - (optional :tag or @digest in the last segment)";
  }
  return null;
}

/** Client-side mirror of the daemon's build-name rules; null when valid. */
export function imageNameIssue(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) return "image name must be non-empty";
  if (name.length > 64) return "image name must be at most 64 characters";
  if (!IMAGE_NAME_PATTERN.test(name)) {
    return "image name may only use a-z 0-9 . _ - (no uppercase, slashes or spaces)";
  }
  return null;
}

/** The tag a build lands under: `openeuler/<name>:latest`. */
export function imageBuildTag(name: string): string {
  return `${OPENEULER_IMAGE_NAMESPACE}${name}:${OPENEULER_IMAGE_TAG}`;
}

/**
 * Appends `:latest` when the ref carries neither tag nor digest, so refs
 * that docker treats identically compare equal (in-use checks).
 */
export function normalizeImageRef(ref: string): string {
  if (ref.includes("@")) return ref;
  const lastSegment = ref.split("/").pop() ?? ref;
  return lastSegment.includes(":") ? ref : `${ref}:${OPENEULER_IMAGE_TAG}`;
}

/** One `docker images --format json` row (only the fields we read). */
interface DockerImagesRow {
  Repository?: string;
  Tag?: string;
  ID?: string;
  Size?: string;
  CreatedAt?: string;
}

/** One `docker image inspect` entry (only the fields we read). */
interface DockerImageInspectView {
  Id?: string;
  Created?: string;
  Size?: number;
}

const COMMON_BASE_REFS: ReadonlySet<string> = new Set(COMMON_BASE_IMAGES);

function isCatalogRow(row: DockerImagesRow): boolean {
  const repository = row.Repository ?? "";
  const tag = row.Tag ?? "";
  if (tag === "" || tag === "<none>") return false; // dangling rows are noise
  if (repository.startsWith(OPENEULER_IMAGE_NAMESPACE)) return true;
  return COMMON_BASE_REFS.has(`${repository}:${tag}`);
}

/** `"95.1MB"` → bytes (docker prints go-units decimal sizes); NaN on no match. */
export function parseDockerSizeToBytes(size: string | undefined): number {
  if (typeof size !== "string") return Number.NaN;
  const match = /^([\d.]+)\s*(B|kB|KB|MB|GB|TB)$/.exec(size.trim());
  if (match === null) return Number.NaN;
  const value = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(value)) return Number.NaN;
  const factors: Record<string, number> = {
    B: 1,
    kB: 1_000,
    KB: 1_000,
    MB: 1_000_000,
    GB: 1_000_000_000,
    TB: 1_000_000_000_000,
  };
  const factor = factors[match[2] ?? ""];
  return factor === undefined ? Number.NaN : Math.round(value * factor);
}

/**
 * `"2026-10-02 09:49:06 +0800 CST"` → epoch ms. Docker prints a non-ISO
 * timestamp with a zone name; the numeric offset (when present) wins, absent
 * offsets are treated as UTC. NaN when unparseable.
 */
export function parseDockerCreatedAtMs(createdAt: string | undefined): number {
  if (typeof createdAt !== "string") return Number.NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: ([+-]\d{4}))?/.exec(createdAt);
  if (match === null) return Number.NaN;
  const [, year, month, day, hour, minute, second, offset] = match;
  const base = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (offset === undefined) return base;
  const sign = offset.startsWith("-") ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(3, 5));
  return base - sign * (hours * 60 + minutes) * 60_000;
}

/** `sha256:abcdef…` → the 12-char short id docker prints in `images` rows. */
function shortImageId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

/**
 * Lists the image catalog: `docker images --format json` filtered to our
 * namespace + the curated common bases, then enriched with one batched
 * `docker image inspect` for exact byte sizes, RFC3339 creation times and
 * full image ids (the `images` rows only carry human-rounded sizes and a
 * local-zone timestamp). Enrichment failures fall back to the row's own
 * values — a concurrent removal must never 500 the catalog.
 */
export async function listSandboxImages(
  options: SandboxImagesOptions = {},
): Promise<SandboxImageEntry[]> {
  const runner = options.runner ?? defaultDockerCliRunner;
  const listTimeoutMs = options.listTimeoutMs ?? 60_000;
  const result = await docker(["images", "--format", "json"], { runner, timeoutMs: listTimeoutMs });
  if (result.code !== 0) {
    if (isDaemonDown(result)) {
      throw new SandboxError(
        "SANDBOX_UNAVAILABLE",
        `cannot list images (docker daemon unreachable): ${stderrTail(result.stderr)}`,
      );
    }
    throw new SandboxError(
      "SANDBOX_EXEC_FAILED",
      `docker images failed: ${stderrTail(result.stderr)}`,
    );
  }

  const rows: DockerImagesRow[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      rows.push(JSON.parse(trimmed) as DockerImagesRow);
    } catch {
      // Skip malformed lines rather than failing the whole catalog.
    }
  }
  const catalogRows = rows.filter(isCatalogRow);
  if (catalogRows.length === 0) return [];

  // Batched enrichment: one inspect call for the whole catalog. Docker exits
  // non-zero when any ref vanished mid-flight but still prints the survivors.
  const exact = new Map<string, { id: string; sizeBytes: number; createdAt: number }>();
  const inspect = await docker(
    [
      "image",
      "inspect",
      "--format",
      "{{json .}}",
      ...catalogRows.map((row) => `${row.Repository}:${row.Tag}`),
    ],
    { runner, timeoutMs: listTimeoutMs },
  );
  if (inspect.stdout.trim() !== "") {
    for (const line of inspect.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const view = JSON.parse(trimmed) as DockerImageInspectView;
        const id = view.Id ?? "";
        const sizeBytes = typeof view.Size === "number" ? view.Size : Number.NaN;
        const createdAt = view.Created === undefined ? Number.NaN : Date.parse(view.Created);
        if (id === "") continue;
        exact.set(shortImageId(id), {
          id,
          sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : Number.NaN,
          createdAt: Number.isFinite(createdAt) ? createdAt : Number.NaN,
        });
      } catch {
        // One bad entry must not sink the rest.
      }
    }
  }

  return catalogRows.map((row) => {
    const enriched = exact.get(shortImageId(row.ID ?? ""));
    const sizeBytes =
      enriched !== undefined && Number.isFinite(enriched.sizeBytes)
        ? enriched.sizeBytes
        : parseDockerSizeToBytes(row.Size);
    const createdAt =
      enriched !== undefined && Number.isFinite(enriched.createdAt)
        ? enriched.createdAt
        : parseDockerCreatedAtMs(row.CreatedAt);
    return {
      repository: row.Repository ?? "",
      tag: row.Tag ?? "",
      id: enriched?.id ?? row.ID ?? "",
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      ours: (row.Repository ?? "").startsWith(OPENEULER_IMAGE_NAMESPACE),
    } satisfies SandboxImageEntry;
  });
}

/** Throws {@link SandboxError} (`SANDBOX_INVALID_SPEC`) for a bad pull ref. */
function assertValidRef(ref: string): void {
  const issue = imageRefIssue(ref);
  if (issue !== null) throw new SandboxError("SANDBOX_INVALID_SPEC", issue);
}

/**
 * Pulls one image (`docker pull <ref>`). Resolves on success; rejects with
 * `SANDBOX_IMAGE_MISSING` (unpullable ref), `SANDBOX_UNAVAILABLE` (daemon
 * down) or `SANDBOX_TIMEOUT`. The ref is passed to the CLI verbatim after
 * grammar validation (no shell — argv only).
 */
export async function pullSandboxImage(
  ref: string,
  options: SandboxImagesOptions = {},
): Promise<void> {
  assertValidRef(ref);
  const result = await docker(["pull", ref], {
    runner: options.runner ?? defaultDockerCliRunner,
    timeoutMs: options.pullTimeoutMs ?? 600_000,
  });
  if (result.code === 0) return;
  if (isDaemonDown(result)) {
    throw new SandboxError(
      "SANDBOX_UNAVAILABLE",
      `pull of "${ref}" failed (docker daemon unreachable): ${stderrTail(result.stderr)}`,
    );
  }
  throw new SandboxError(
    "SANDBOX_IMAGE_MISSING",
    `pull of "${ref}" failed: ${stderrTail(result.stderr)}`,
  );
}

/** Input of {@link buildSandboxImage}. */
export interface SandboxImageBuildInput {
  /** Flat image name; validated by {@link imageNameIssue}. */
  name: string;
  /**
   * Full Dockerfile text. Sent as the build's stdin with an EMPTY context —
   * v0.2 constraint: `COPY`/`ADD` have no files to copy and will fail.
   */
  dockerfileText: string;
}

/**
 * Builds `openeuler/<name>:latest` from Dockerfile text piped to
 * `docker build -` (no context directory — the stdin Dockerfile build). The
 * base image named in `FROM` is pulled by docker when missing. Rejects with
 * `SANDBOX_IMAGE_MISSING` when the base cannot be resolved.
 *
 * THREAT MODEL: a Dockerfile executes arbitrary code at BUILD time (RUN
 * steps) as the daemon user. This API is intended for trusted, authenticated
 * users of a local-first tool — it is NOT a safe surface for untrusted
 * input. The daemon route is gated by bearer auth and rate limits when
 * enabled.
 */
export async function buildSandboxImage(
  input: SandboxImageBuildInput,
  options: SandboxImagesOptions = {},
): Promise<{ tag: string }> {
  const nameIssue = imageNameIssue(input.name);
  if (nameIssue !== null) throw new SandboxError("SANDBOX_INVALID_SPEC", nameIssue);
  if (typeof input.dockerfileText !== "string" || input.dockerfileText.trim() === "") {
    throw new SandboxError("SANDBOX_INVALID_SPEC", "dockerfileText must be non-empty");
  }
  if (input.dockerfileText.length > 512_000) {
    throw new SandboxError("SANDBOX_INVALID_SPEC", "dockerfileText must be at most 512000 chars");
  }
  if (input.dockerfileText.includes("\0")) {
    throw new SandboxError("SANDBOX_INVALID_SPEC", "dockerfileText must not contain NUL bytes");
  }
  const tag = imageBuildTag(input.name);
  const result = await (options.stdinRunner ?? defaultDockerStdinCliRunner)(
    ["build", "-t", tag, "-"],
    input.dockerfileText,
    { timeoutMs: options.buildTimeoutMs ?? 600_000 },
  );
  if (result.code === 0) return { tag };
  if (isDaemonDown(result)) {
    throw new SandboxError(
      "SANDBOX_UNAVAILABLE",
      `build of "${tag}" failed (docker daemon unreachable): ${stderrTail(result.stderr)}`,
    );
  }
  if (isImageMissingText(`${result.stderr}\n${result.stdout}`)) {
    throw new SandboxError(
      "SANDBOX_IMAGE_MISSING",
      `build of "${tag}" failed (base image not available): ${
        stderrTail(result.stderr) || stderrTail(result.stdout)
      }`,
    );
  }
  throw new SandboxError(
    "SANDBOX_EXEC_FAILED",
    `build of "${tag}" failed: ${stderrTail(result.stderr) || stderrTail(result.stdout)}`,
  );
}

/** True when `docker rmi` stderr says the image is held (container/multi-tag). */
function isImageHeldText(stderr: string): boolean {
  return (
    /is being used by (?:a )?(?:stopped|running) container/i.test(stderr) ||
    /image is referenced in (?:multiple|one or more) repositories/i.test(stderr) ||
    /cannot be forced/i.test(stderr) ||
    (/conflict/i.test(stderr) && /unable to delete/i.test(stderr))
  );
}

/**
 * Removes one image by ref. Rejects with `SANDBOX_IMAGE_MISSING` (unknown
 * ref, verified via `docker image inspect` first), `SANDBOX_IMAGE_IN_USE`
 * (docker reports a container or sibling tag holding it) or
 * `SANDBOX_UNAVAILABLE`.
 */
export async function removeSandboxImage(
  ref: string,
  options: SandboxImagesOptions = {},
): Promise<void> {
  assertValidRef(ref);
  const runner = options.runner ?? defaultDockerCliRunner;
  const opTimeoutMs = options.listTimeoutMs ?? 60_000;
  const inspect = await docker(["image", "inspect", ref], { runner, timeoutMs: opTimeoutMs });
  if (inspect.code !== 0) {
    if (isDaemonDown(inspect)) {
      throw new SandboxError(
        "SANDBOX_UNAVAILABLE",
        `cannot inspect image "${ref}" (docker daemon unreachable)`,
      );
    }
    if (isImageMissingText(inspect.stderr)) {
      throw new SandboxError("SANDBOX_IMAGE_MISSING", `image "${ref}" does not exist`);
    }
    throw new SandboxError(
      "SANDBOX_EXEC_FAILED",
      `cannot inspect image "${ref}": ${stderrTail(inspect.stderr)}`,
    );
  }
  const rmi = await docker(["rmi", ref], { runner, timeoutMs: opTimeoutMs });
  if (rmi.code === 0) return;
  if (isDaemonDown(rmi)) {
    throw new SandboxError(
      "SANDBOX_UNAVAILABLE",
      `removal of "${ref}" failed (docker daemon unreachable): ${stderrTail(rmi.stderr)}`,
    );
  }
  if (isImageHeldText(rmi.stderr)) {
    throw new SandboxError(
      "SANDBOX_IMAGE_IN_USE",
      `image "${ref}" is in use (a container references it or multiple tags share it): ${stderrTail(rmi.stderr)}`,
    );
  }
  if (isImageMissingText(rmi.stderr)) {
    throw new SandboxError("SANDBOX_IMAGE_MISSING", `image "${ref}" does not exist`);
  }
  throw new SandboxError(
    "SANDBOX_EXEC_FAILED",
    `removal of "${ref}" failed: ${stderrTail(rmi.stderr)}`,
  );
}
