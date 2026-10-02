# @openeuler/sandbox

Pluggable sandbox backends for openeuler. This package defines the
`SandboxProvider` contract — the seam where isolated execution environments
plug in — plus a registry, a scripted `fake` provider that makes the engine
and API testable without a container runtime, and a real `docker` provider
(CLI-over-execFile) for actual isolation.

> This README is the "add a new sandbox provider" guide.

## The contract

```ts
interface SandboxProvider {
  id: string; // unique registry id, e.g. "docker"
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  list(labelSelector?: Record<string, string>): Promise<SandboxSummary[]>;
  stats?(): Promise<SandboxUsage[]>; // optional per-sandbox usage
}

interface SandboxSpec {
  runId: string; // run this sandbox belongs to
  image: string; // container image, e.g. "openeuler/worker:latest"
  mounts: SandboxMount[]; // { hostPath, containerPath, readonly? }
  env: Record<string, string>;
  ports?: number[]; // published container ports
  resources?: { cpus?: number; memoryMb?: number };
  network?: "none" | "limited" | "default";
  labels?: Record<string, string>; // discovery/filtering via list()
  workingDir?: string;
}

interface SandboxHandle {
  id: string;
  status(): Promise<"running" | "exited" | "stopped">;
  exec(cmd: string[], opts?: SandboxExecOptions): Promise<SandboxExecResult>;
  logs(opts?: SandboxLogOptions): AsyncIterable<SandboxLogEntry>;
  hostPorts(): Promise<Record<number, number>>; // container → host
  stop(timeoutMs?: number): Promise<void>;
  destroy(): Promise<void>;
  meta: { createdAt: number; image: string; ports: number[] };
}
```

## Lifecycle

1. `create(spec)` validates the spec and starts one sandbox. An empty image
   (or one the provider cannot pull) rejects with `SANDBOX_IMAGE_MISSING`;
   provider-level startup failures reject with `SANDBOX_UNAVAILABLE`.
2. `status()` reports `"running"`, `"exited"` (ended on its own), or
   `"stopped"` (stopped via `stop()`).
3. `stop(timeoutMs?)` gracefully stops the sandbox. It is **idempotent** —
   calling it on an already stopped/exited sandbox resolves without effect.
   Provider failures reject with `SANDBOX_STOP_FAILED`.
4. `destroy()` stops and removes the sandbox. It is idempotent. After it
   resolves the sandbox is gone:

| Operation     | After `destroy()`           |
| ------------- | --------------------------- |
| `list()`      | no longer includes it       |
| `status()`    | `"stopped"` (never running) |
| `exec()`      | `SANDBOX_UNAVAILABLE`       |
| `logs()`      | empty stream                |
| `hostPorts()` | `{}`                        |

## Exec semantics

- `exec` runs a command **inside** the sandbox and resolves with
  `{ code, stdout, stderr, durationMs }`. A non-zero `code` is a _result_,
  not an error — matching container exec semantics.
- `opts.timeoutMs` bounds the command; on expiry `exec` rejects with
  `SANDBOX_TIMEOUT`.
- `exec` on a sandbox that is not running (stopped/exited/destroyed) rejects
  with `SANDBOX_UNAVAILABLE`.
- Infrastructure-level failures (command could not be spawned at all) reject
  with `SANDBOX_EXEC_FAILED`.

## Log streaming semantics

- `logs()` yields entries in emission order, preserving stdout/stderr
  interleaving.
- `opts.tail` limits the stream to the last N entries (after `since`
  filtering); `opts.since` (epoch ms) drops older entries.
- `follow` is reserved for future live tailing; only `false` (or omitted) is
  valid in v1.
- Unlike agent event streams, `logs()` **may be called multiple times** — it
  is a query over the sandbox's logs, and each call returns a fresh iterable.

## Ports

`spec.ports` lists container ports to publish. `hostPorts()` returns the
container→host mapping; host sides are ephemeral and stable across calls
until `destroy()` (then `{}`). Sandboxes without `ports` report `{}`.

## Registry

```ts
import { createSandboxProviderRegistry } from "@openeuler/sandbox";

const registry = createSandboxProviderRegistry();
registry.registerSandboxProvider(provider); // duplicate id → SandboxError
registry.getSandboxProvider("docker"); // unknown id → SandboxError
registry.listSandboxProviders(); // registration order
```

The daemon composes a registry at boot. A process-wide
`defaultSandboxProviderRegistry` plus standalone `registerSandboxProvider` /
`getSandboxProvider` / `listSandboxProviders` helpers are also exported for
convenience.

### Error codes

| Code                         | Meaning                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `SANDBOX_PROVIDER_NOT_FOUND` | no provider registered with the requested id                  |
| `SANDBOX_ALREADY_REGISTERED` | a provider with the same `id` is registered                   |
| `SANDBOX_INVALID_SPEC`       | spec failed validation (relative mount path, bad port/env, …) |
| `SANDBOX_IMAGE_MISSING`      | image empty or not pullable                                   |
| `SANDBOX_UNAVAILABLE`        | sandbox not running / provider cannot serve it                |
| `SANDBOX_EXEC_FAILED`        | provider failed to execute the command                        |
| `SANDBOX_TIMEOUT`            | exec exceeded `opts.timeoutMs`                                |
| `SANDBOX_STOP_FAILED`        | provider failed to stop the sandbox                           |

## Fake provider

```ts
import { createFakeSandboxProvider } from "@openeuler/sandbox";

const provider = createFakeSandboxProvider({
  id: "fake", // optional, default "fake"
  execResults: [
    // optional FIFO queue, consumed across handles in call
    { code: 1, stdout: "boom" }, // order; Partial<SandboxExecResult> or
    new SandboxError("SANDBOX_EXEC_FAILED", "nope"), // a SandboxError to throw
  ], // empty queue → default echo result (code 0, stdout = joined cmd)
  execDelayMs: 0, // simulated command duration; > timeoutMs → SANDBOX_TIMEOUT
  logLines: [{ stream: "stdout", line: "l1" }], // replayed by logs()
  logDelayMs: 0, // delay between log lines
  knownImages: ["openeuler/test:latest"], // reject others with IMAGE_MISSING
  exitsAfterMs: 100, // running → exited on its own
  failOnCreate: false, // create() rejects with SANDBOX_UNAVAILABLE
  failOnStop: false, // stop() rejects with SANDBOX_STOP_FAILED
  now: Date.now, // clock for createdAt / measured durations
});

const sandbox = await provider.create({
  runId: "run_1",
  image: "openeuler/test:latest",
  mounts: [],
  env: {},
});
```

Behavior:

- `create()` validates the spec (non-empty image, `knownImages` when set) and
  records a **deep snapshot** in `provider.createdSpecs`; `provider.execCalls`,
  `provider.stopCalls`, and `provider.destroyCalls` record every call with
  snapshot `cmd`/`opts` for test assertions.
- Spec ports map to fake ephemeral host ports (allocated from 32768, unique
  across sandboxes).
- Log entries get synthetic timestamps (`createdAt + index` ms) so `since`
  filtering is deterministic in tests.
- `stats()` reports each sandbox's spec `resources` as its usage.

## Docker provider

`createDockerSandboxProvider()` (also exported as the `DockerSandboxProvider`
class) implements the contract over the **docker CLI** — every invocation is
`execFile("docker", [args])` with no shell anywhere and a hard SIGKILL timeout.
Docker does **not** need to be available at construction; availability is
probed lazily per call (`docker info`, cached 30s — also exported standalone
as `dockerAvailable()`).

```ts
import { createDockerSandboxProvider } from "@openeuler/sandbox";

const provider = createDockerSandboxProvider({
  id: "docker", // registry id (default "docker")
  pullTimeoutMs: 300_000, // docker pull budget when the image is missing
  execTimeoutMs: 300_000, // default exec timeout (caller timeoutMs wins)
  opTimeoutMs: 30_000, // control-plane calls (inspect/ps/stop/rm)
  stopGraceMs: 10_000, // default stop() grace before SIGKILL
  limitedNetworkName: "openeuler-limited", // dedicated bridge (see below)
  idleCommand: ["tail", "-f", "/dev/null"], // container CMD while idle
  publishHost: "127.0.0.1", // host IP published ports bind to (loopback-only default)
  logsCapBytes: 8 * 1024 * 1024, // per-stream logs() snapshot cap (truncation marker beyond)
  runner: undefined, // injectable CLI runner (tests)
  logsSpawner: undefined, // injectable dual-stream spawner (tests)
});
```

### What create() does

1. **Validates the spec** (typed `SANDBOX_INVALID_SPEC` errors): mount
   `hostPath`/`containerPath` must be **absolute** (docker would silently
   create relative bind sources — rejected instead) and must not contain `:`
   (the `-v` separator); ports must be integers in `[1, 65535]`; env keys
   (spec and exec-time) non-empty without `=`; `ports` + `network: "none"`
   is rejected (docker cannot publish ports without a network); label keys
   must not use the provider-reserved `openeuler.*` namespace; image refs
   must match a conservative grammar
   (`^[a-z0-9._/-]+(:[A-Za-z0-9._-]+)?(@\S+)?$`, no leading dash/whitespace)
   so flag-like refs such as `--privileged` can never reach docker's argument
   parser — note this also rejects registry refs with a port before the last
   path segment (`localhost:5000/img`) in v0.2.
2. **Image pull policy `never-if-exists`**: `docker image inspect` first; only
   when missing does it run one `docker pull` (bounded by `pullTimeoutMs`).
   Pull failure (including auth/manifest errors) surfaces as
   `SANDBOX_IMAGE_MISSING`.
3. Runs `docker run -d --init --name openeuler-<runId>-<rand6>` with:
   - labels `openeuler.sandbox=1`, `openeuler.run=<runId>`,
     `openeuler.image=<image>`, `openeuler.createdAt=<epochMs>` plus every
     `spec.labels` entry (`openeuler.*` keys are provider-reserved: rejected
     at `create()` and reported back stripped from `list()` summaries);
   - `--log-driver=json-file` so stdout/stderr stay demultiplexed (below);
   - `-w <workingDir>` — the spec value, defaulting to `/workspace` when
     mounts exist;
   - `-v host:container[:ro]` per mount, `-e K=V` per env (values may contain
     `=`), `-p 127.0.0.1::<port>` per spec port (ephemeral host side bound
     to `publishHost` — loopback by default, see "Ports" below);
   - `--memory=<memoryMb>m` and `--cpus=<cpus>` when `resources` is set;
   - `--network none` for `network: "none"`; `--network openeuler-limited`
     for `"limited"` (bridge created on demand, race-tolerant); no flag for
     `"default"`;
   - the idle command (`tail -f /dev/null`) — sandboxes are exec-driven:
     `create` starts an idle keeper and all work happens via `exec`.
4. `docker inspect` resolves the published host ports → `hostPorts()` (cached;
   stable across calls until `destroy()` → `{}`).

If the container started but the post-start `docker inspect` fails (or the
`docker run` invocation itself dies mid-flight, e.g. a timeout), `create()`
runs a best-effort `docker rm -f <name>` before rethrowing, so a failed
`create()` never leaks a running container under the provider's name.

`--init` (docker-init/tini as PID 1) matters: it forwards SIGTERM so
`stop()`'s grace period is honored instead of always burning into SIGKILL.

### Exec, stop, destroy

- `exec` → `docker exec [-w cwd] [-e K=V] <name> cmd…`. Non-zero exit codes
  are results; `SANDBOX_TIMEOUT` fires when execFile's timeout SIGKILLs the
  CLI (`timeoutMs` or `execTimeoutMs`). Note the kill targets the CLI process —
  a container-side process can outlive a timed-out exec until `destroy()`.
- `stop(timeoutMs = stopGraceMs)` → `docker stop -t <seconds>`; idempotent;
  failures (including daemon-down) map to `SANDBOX_STOP_FAILED`. Status maps
  docker's `exited` to the contract's `stopped` (the handle remembers who
  stopped it).
- `destroy()` → `docker rm -f` (idempotent; "No such container" is success).
  The handle is only marked destroyed once `rm` actually succeeded (or the
  container is already gone) — a failed `destroy()` stays retryable.
- `list()` filters `docker ps` by the `openeuler.sandbox=1` label; `stats()`
  is scoped the same way — it resolves the provider's sandbox ids first and
  runs `docker stats --no-stream <ids…>` against those only (empty list →
  `[]` without touching `docker stats`), so host containers unrelated to
  openeuler are never reported.

### Logs demux (v0.2 snapshot)

`logs()` spawns `docker logs --timestamps [--tail N] [--since <RFC3339>]` and
reads **both of the CLI's pipe streams line-by-line**: docker writes container
stdout to its stdout and container stderr to its stderr when the container is
not a TTY, so each line is tagged with its source stream; the `--timestamps`
prefix is stripped. Per-stream order is exact; cross-stream interleaving
follows pipe-arrival order (the contract pins per-stream order only). Being a
single-shot snapshot (follow is reserved), the iterator completes when `docker
logs` exits; a container that vanished externally resolves to an empty stream,
and destroyed handles return `[]` without spawning. Each stream is capped at
`logsCapBytes` (default 8 MiB): crossing the cap emits a `[openeuler] … log
snapshot truncated` marker line and stops reading that stream, so a container
writing unbounded output cannot grow memory without bound (the CLI's expected
broken-pipe exit after truncation is treated as success).

### Ports

`spec.ports` lists container ports to publish. `hostPorts()` returns the
container→host mapping; host sides are ephemeral and stable across calls
until `destroy()` (then `{}`). Sandboxes without `ports` report `{}`.

Published ports bind to the **host's loopback only** by default
(`-p 127.0.0.1::<containerPort>` — docker's `ip::containerPort` syntax with
an ephemeral host port). Plain `-p <port>` would bind `0.0.0.0` and expose
the port to every interface; set the provider option `publishHost` (e.g.
`"0.0.0.0"` or a specific address) when a sandbox port must be reachable
off-host.

### Network modes — honest approximation

- `none` → `--network none`: genuinely no networking (no egress, no DNS).
- `default` → no flag: the host's default bridge with full outbound access.
- `limited` → **approximation**: a dedicated bridge network
  (`openeuler-limited`, created on demand) whose embedded DNS works, but
  **egress is NOT actually filtered in v0.2** — containers on it can still
  reach the outside world. The dedicated bridge is the plumbing anchor; the
  actual allowlist enforcement (iptables/ICMP rules, or a per-run network)
  lands with the sandbox network policy work tracked in #101. Until then,
  treat `limited` as "separate bridge + DNS", not "restricted egress".

### Images

The provider runs any image, but exec-driven sandboxes need an idle-survivable
PID 1 (the default `tail -f /dev/null` needs coreutils/busybox `tail` —
`idleCommand` is injectable). Worker images for openeuler runs are expected to
carry the agent toolchain preinstalled — see the `opencode` driver notes in
[packages/drivers](../drivers/README.md) for what the CLI-based agent runtime
requires inside the image.

Docker-in-docker note: when the daemon itself runs inside a container, bind
mounts resolve against the **daemon's** filesystem, not the CLI caller's —
pass host paths as the daemon sees them.

### Testing

- `src/docker.test.ts` — unit tests with an injected fake runner + fake log
  spawner: exact argument construction, error mapping (daemon down →
  `SANDBOX_UNAVAILABLE`, image missing → `SANDBOX_IMAGE_MISSING`, other →
  `SANDBOX_EXEC_FAILED` with a stderr tail, timeouts), relative-mount
  rejection, probe caching, logs demux. No docker needed.
- `src/docker.contract.test.ts` / `src/docker.integration.test.ts` — real
  daemon suites (`busybox:1.36`, pulled once in `beforeAll`): the full
  `runSandboxContractTests` matrix via a maker that compiles scripts into real
  commands, plus lifecycle, mounts (read-only enforced), published ports
  (busybox `httpd` served over a mapped host port), resource flags asserted
  via `docker inspect`, all three network modes, orphan-label isolation, and a
  PATH-stripped unavailability check. Both suites **auto-skip when
  `docker info` fails** (set `DOCKER_E2E=0` to force-skip in CI), and their
  `afterAll` sweeps + asserts that zero labeled containers remain.

## Contract tests

`runSandboxContractTests(makeProvider)` (from the `@openeuler/sandbox/contract`
subpath, which keeps vitest out of the runtime entrypoint) runs the
provider-agnostic suite: lifecycle order, exec semantics (scripted queue,
timeout, post-stop), log order + tail, stop idempotency, destroy-clears,
ports mapping, list/label filtering, and error codes.

```ts
// your-provider.contract.test.ts
import { runSandboxContractTests } from "@openeuler/sandbox/contract";

runSandboxContractTests((script) =>
  createMyProvider({
    execResults: script.execResults, // map the script onto your backend
    execDelayMs: script.execDelayMs,
    logLines: script.logLines,
    logDelayMs: script.logDelayMs,
  }),
);
```

The `script` describes each scenario (exec outcomes, delays, log lines); a
real provider compiles it into actual commands/containers. The fake runs the
same suite in `src/contract.fake.test.ts`.

## Adding a new sandbox provider

1. Implement `SandboxProvider` (id + `create` + `list`, optionally `stats`),
   returning handles that honor the semantics above. Reuse `SandboxError`
   with the codes from the table for every failure path.
2. Register it with the registry composed at daemon boot (or the default one).
3. Run `runSandboxContractTests` against it (see above); all scenarios must
   pass before it ships.
