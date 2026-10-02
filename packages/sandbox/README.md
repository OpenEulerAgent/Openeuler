# @openeuler/sandbox

Pluggable sandbox backends for openeuler. This package defines the
`SandboxProvider` contract — the seam where isolated execution environments
(e.g. docker containers) plug in — plus a registry and a scripted `fake`
provider that makes the engine and API testable without a container runtime.

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

| Code                         | Meaning                                        |
| ---------------------------- | ---------------------------------------------- |
| `SANDBOX_PROVIDER_NOT_FOUND` | no provider registered with the requested id   |
| `SANDBOX_ALREADY_REGISTERED` | a provider with the same `id` is registered    |
| `SANDBOX_IMAGE_MISSING`      | image empty or not pullable                    |
| `SANDBOX_UNAVAILABLE`        | sandbox not running / provider cannot serve it |
| `SANDBOX_EXEC_FAILED`        | provider failed to execute the command         |
| `SANDBOX_TIMEOUT`            | exec exceeded `opts.timeoutMs`                 |
| `SANDBOX_STOP_FAILED`        | provider failed to stop the sandbox            |

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
