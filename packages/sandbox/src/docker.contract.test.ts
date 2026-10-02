import { afterAll, beforeAll, describe } from "vitest";
import { randomBytes } from "node:crypto";
import { SandboxError } from "./error.js";
import { createDockerAvailabilityProbe, docker } from "./docker-cli.js";
import { createDockerSandboxProvider } from "./docker.js";
import { runSandboxContractTests, type SandboxContractScript } from "./contract.js";
import type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxLogEntry,
  SandboxProvider,
  SandboxSpec,
} from "./types.js";

/** Small real image used for every contract container. */
const BUSYBOX = "busybox:1.36";
/** Label injected into every container this file creates (afterAll sweep key). */
const TEST_TAG = "docker-contract";

// DOCKER_E2E=0 forces the suite off; otherwise it runs when a live daemon
// answers `docker info`, and auto-skips (exit-non-zero / CLI missing) otherwise.
const dockerLive =
  process.env.DOCKER_E2E === "0"
    ? false
    : await createDockerAvailabilityProbe().check({ force: true });

/** Single-quote a value for `sh -c` composition. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Compiles a scripted exec outcome into a real `sh -c` command. */
function compileResultScript(want: { code: number; stdout: string; stderr: string }): string {
  const parts: string[] = [];
  if (want.stdout !== "") parts.push(`printf %s ${shQuote(want.stdout)}`);
  if (want.stderr !== "") parts.push(`printf %s ${shQuote(want.stderr)} 1>&2`);
  parts.push(`exit ${want.code}`);
  return parts.join("; ");
}

/** Compiles scripted log lines into the container's idle command. */
function compileLogScript(lines: SandboxLogEntry[]): string {
  const parts = lines.map(
    (entry) => `printf '%s\\n' ${shQuote(entry.line)}${entry.stream === "stderr" ? " 1>&2" : ""}`,
  );
  parts.push("exec tail -f /dev/null");
  return parts.join("; ");
}

/** A busybox tag that is guaranteed absent (fails the real pull path fast). */
function missingImage(): string {
  return `busybox:1.36-no-such-tag-${randomBytes(4).toString("hex")}`;
}

interface ScriptedState {
  queue: Array<Partial<SandboxExecResult> | SandboxError>;
  failOnStop: boolean;
}

function wrapHandle(
  handle: SandboxHandle,
  logicalImage: string,
  state: ScriptedState,
): SandboxHandle {
  return {
    id: handle.id,
    meta: { ...handle.meta, image: logicalImage },
    status: () => handle.status(),
    async exec(cmd: string[], opts?: SandboxExecOptions): Promise<SandboxExecResult> {
      const next = state.queue.shift();
      if (next instanceof SandboxError) throw next;
      if (next !== undefined) {
        const want = { code: 0, stdout: "", stderr: "", ...next };
        // Run the scripted outcome as a REAL container command; report the
        // scripted values with the measured duration.
        const result = await handle.exec(["sh", "-c", compileResultScript(want)], opts);
        return { ...want, durationMs: result.durationMs };
      }
      return handle.exec(cmd, opts);
    },
    logs: (opts) => handle.logs(opts),
    hostPorts: () => handle.hostPorts(),
    async stop(timeoutMs?: number): Promise<void> {
      if (state.failOnStop) {
        throw new SandboxError("SANDBOX_STOP_FAILED", `scripted stop failure for "${handle.id}"`);
      }
      await handle.stop(timeoutMs);
    },
    destroy: () => handle.destroy(),
  };
}

/**
 * Real-docker contract maker: compiles the script's exec outcomes into real
 * `sh -c` commands, its log lines into the container CMD, and aliases the
 * contract's fake image names onto busybox (rewriting meta/list image back).
 */
function makeDockerContractProvider(script: SandboxContractScript): SandboxProvider {
  const provider = createDockerSandboxProvider({
    idleCommand: script.logLines ? ["sh", "-c", compileLogScript(script.logLines)] : undefined,
  });
  const state: ScriptedState = {
    queue: [...(script.execResults ?? [])],
    failOnStop: script.failOnStop ?? false,
  };
  const imageById = new Map<string, string>();
  const known = script.knownImages;
  return {
    id: provider.id,
    async create(spec: SandboxSpec): Promise<SandboxHandle> {
      if (script.failOnCreate) {
        throw new SandboxError("SANDBOX_UNAVAILABLE", "scripted create failure");
      }
      // Contract image names are symbolic: alias them onto the real image,
      // except non-members of knownImages, which must fail the pull.
      const image = known === undefined || known.includes(spec.image) ? BUSYBOX : missingImage();
      const handle = await provider.create({
        ...spec,
        image,
        labels: { ...spec.labels, "openeuler-test": TEST_TAG },
      });
      imageById.set(handle.id, spec.image);
      return wrapHandle(handle, spec.image, state);
    },
    async list(labelSelector?: Record<string, string>) {
      const summaries = await provider.list(labelSelector);
      return summaries.map((summary) =>
        imageById.has(summary.id)
          ? { ...summary, image: imageById.get(summary.id) as string }
          : summary,
      );
    },
    stats: provider.stats.bind(provider),
  };
}

describe.skipIf(!dockerLive)("docker provider contract (real daemon)", () => {
  beforeAll(async () => {
    // Pull once up front so scenario creates never race a cold pull.
    const present = await docker(["image", "inspect", BUSYBOX], { timeoutMs: 30_000 });
    if (present.code !== 0) {
      const pull = await docker(["pull", BUSYBOX], { timeoutMs: 300_000 });
      if (pull.code !== 0) throw new Error(`failed to pull ${BUSYBOX}: ${pull.stderr}`);
    }
  });

  runSandboxContractTests(makeDockerContractProvider);

  afterAll(async () => {
    // Sweep every container this file created; the suite must leave none.
    const leftovers = await docker(["ps", "-aq", "--filter", `label=openeuler-test=${TEST_TAG}`], {
      timeoutMs: 30_000,
    });
    const ids = leftovers.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const id of ids) {
      await docker(["rm", "-f", id], { timeoutMs: 30_000 });
    }
    const after = await docker(["ps", "-aq", "--filter", `label=openeuler-test=${TEST_TAG}`], {
      timeoutMs: 30_000,
    });
    if (after.stdout.trim() !== "") {
      throw new Error(`docker contract suite left containers behind: ${after.stdout}`);
    }
  });
});
