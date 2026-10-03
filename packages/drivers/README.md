# @openeuler/drivers

Pluggable agent backends for openeuler. This package defines the `AgentDriver`
contract — the seam where real agents (e.g. opencode) plug in — plus a registry
and a scripted `fake` driver that makes the engine and API testable without a
real agent.

> This README is the "add a new agent driver" guide.

## The contract

```ts
import type { AgentEvent } from "@openeuler/core";

interface AgentDriver {
  id: string; // unique registry id, e.g. "opencode"
  start(opts: AgentStartOpts): AgentHandle;
}

interface AgentStartOpts {
  cwd: string; // working directory for the run
  prompt: string; // instruction for the run
  model?: string; // model override
  agent?: string; // agent/subagent selection
  mode: "auto" | "ask"; // auto-act vs. confirm-before-act
  sessionId?: string; // continue a previous session
  env?: Record<string, string>; // extra environment variables
}

interface AgentHandle {
  events: AsyncIterable<AgentEvent>; // lifecycle events (see below)
  abort(): Promise<void>; // stop the run; no-op after completion
  exited: Promise<AgentExit>; // resolves exactly once; never rejects
}

interface AgentExit {
  code: number | null; // exit code, or null when aborted/errored
  reason: "exit" | "aborted" | "error";
  output: string; // final output (or output-so-far on abort)
}
```

`AgentEvent` is the zod-validated union from `@openeuler/core`:
`started`, `session` (`sessionId`), `message-delta`, `tool-call`,
`tool-output`, `done`, `error` — every variant carries a monotonic `seq`.

### Sandbox exec seam (#102 / #104)

`opts.exec`, when present, moves the agent command INSIDE the run's sandbox:

```ts
interface AgentExecSeam {
  kind: "sandbox";
  run(cmd: string[], opts?: AgentExecOptions): Promise<AgentExecResult>;
  runStream?(cmd: string[], opts?: AgentExecOptions): AgentExecStream; // #104, live
  stop?(): void | Promise<void>; // abort path
}

interface AgentExecStream {
  events: AsyncIterable<{ stream: "stdout" | "stderr"; chunk: string }>;
  exited: Promise<{ code: number }>; // rejects on failure/cancel
}
```

Drivers that can consume incremental output SHOULD prefer `runStream` (the
opencode driver parses NDJSON as chunks arrive, so agent events — and the
`session` id — stream live mid-node instead of batching at completion) and
MUST fall back to `run` when the seam does not provide it. `cwd` is a
CONTAINER path under the seam (e.g. `/workspace`); never host-resolve it.

## Lifecycle

1. `start(opts)` spawns one run and returns its handle. `start` must be
   side-effect-free apart from launching the run.
2. The handle's `events` stream is consumed by the engine. Drivers must emit
   events in `seq` order; the first event should be `started` (and a `session`
   event as soon as the session id is known).
3. `exited` resolves exactly once when the run ends — after the event stream
   ends (`reason: "exit"`), after `abort()` (`reason: "aborted"`), or on a
   driver-level failure (`reason: "error"`). It never rejects.
4. `abort()` requests termination. After the run has ended it is a no-op.

## Event stream semantics

- `events` is lazy: nothing is emitted until a consumer iterates it.
- Each handle supports a **single consumer**. Iterating `events` twice throws a
  `DriverError` with code `DRIVER_EVENTS_ALREADY_CONSUMED` (this mirrors real
  process-backed drivers, which cannot replay a live stream). We chose a clear
  error over silent buffering.
- If the consumer breaks out of the loop early, the run is treated as
  terminated early (`exited` resolves with `reason: "aborted"`).

## Abort semantics

- `abort()` stops the run; no further events are delivered and pending
  inter-event delays are cut short.
- `exited` resolves with `{ code: null, reason: "aborted", output }` where
  `output` is the output accumulated so far.
- `abort()` after the run has ended resolves without effect.
- A driver that cannot abort rejects `abort()` with a `DriverError`
  (code `DRIVER_ABORT_FAILED`).

## Registry

```ts
import { createDriverRegistry } from "@openeuler/drivers";

const registry = createDriverRegistry();
registry.registerDriver(driver); // duplicate id → DriverError
registry.getDriver("opencode"); // unknown id → DriverError
registry.listDrivers(); // registration order
```

The daemon composes a registry at boot. A process-wide `defaultDriverRegistry`
plus standalone `registerDriver` / `getDriver` / `listDrivers` helpers are also
exported for convenience.

### Error codes

| Code                             | Meaning                                           |
| -------------------------------- | ------------------------------------------------- |
| `DRIVER_ALREADY_REGISTERED`      | a driver with the same `id` is already registered |
| `DRIVER_NOT_FOUND`               | no driver registered with the requested id        |
| `DRIVER_EVENTS_ALREADY_CONSUMED` | the handle's `events` stream was iterated twice   |
| `DRIVER_ABORT_FAILED`            | the driver failed to abort the run                |

## Fake driver

```ts
import { createFakeDriver } from "@openeuler/drivers";

const driver = createFakeDriver({
  id: "fake",          // optional, default "fake"
  events: [            // optional script; a started event (seq 0) is
    ...                // prepended when missing
  ],
  delayMs: 0,          // delay between events; 0 = immediate
  output: "final",     // exited.output on normal completion
  outputs: [           // optional per-start outputs, cycling by call count
    "WIP", "DONE",     // (start n reports outputs[n % outputs.length];
  ],                   //  wins over `output` when set — useful for loops)
  exitCode: 0,         // exited.code on normal completion
  failOnAbort: false,  // reject abort() with DriverError when true
});

const handle = driver.start({ cwd, prompt, mode: "auto" });
for await (const event of handle.events) { /* ... */ }
const exit = await handle.exited;
```

Behavior:

- Replays `events` in order (waiting `delayMs` between them), then resolves
  `exited` with `{ code: exitCode ?? 0, reason: "exit", output }`.
- If `output` is omitted, the final output is the text accumulated from
  `message-delta` deltas and `tool-output` outputs. This accumulated text is
  also what `exited` reports as `output` when a run is aborted mid-stream.
- Records every `AgentStartOpts` in `driver.calls` for test assertions.
- Note: the auto-prepended `started` event uses `seq: 0`; scripts that don't
  start with `started` should therefore number their events from 1.

## Adding a new agent driver

1. Implement `AgentDriver` (id + `start`), returning a handle that streams
   `AgentEvent`s from the underlying agent, maps termination to `AgentExit`,
   and honors `abort()`.
2. Register it with the registry composed at daemon boot (or the default one).
3. Reuse `@openeuler/core`'s `AgentEvent` schemas when parsing/validating the
   agent's output, and throw `DriverError` for driver-level failures.

## OpenCodeDriver

```ts
import { createOpenCodeDriver } from "@openeuler/drivers";

const driver = createOpenCodeDriver({ binary: "opencode" });
const handle = driver.start({
  cwd: "/repo/worktree",
  prompt: "fix the failing tests",
  mode: "auto", // or "ask" (see below)
  model: "zai/glm-4.6", // optional → -m provider/model
  agent: "build", // optional → --agent build
  sessionId: "ses_...", // optional → --session (continuation)
  env: { OPENCODE_LOG_LEVEL: "debug" }, // merged over process.env
});
for await (const event of handle.events) {
  /* ... */
}
const exit = await handle.exited; // { code, reason, output }
```

Spawns one `opencode run` child per `start()` via `child_process.spawn`
(execFile-style argv, **never** a shell string), `detached: true` so the child
owns its process group (pgid === pid), with piped stdout/stderr and `cwd` set
to `opts.cwd`.

### CLI mapping

| `AgentStartOpts` | argv                                    |
| ---------------- | --------------------------------------- |
| `prompt`         | `run "<prompt>"` (single positional)    |
| — (always)       | `--format json --dir <absolute cwd>`    |
| `mode: "auto"`   | `--auto`                                |
| `mode: "ask"`    | _(nothing; see note)_                   |
| `model`          | `-m <model>` (expects `provider/model`) |
| `agent`          | `--agent <agent>`                       |
| `sessionId`      | `--session <id>`                        |
| `env`            | merged over `process.env` for the child |

> `mode: "ask"` is accepted in v1 but maps to a non-interactive run without
> `--auto` (opencode fails fast on prompts it cannot answer). Interactive
> permission prompting arrives with the serve-based driver.

### NDJSON → AgentEvent mapping

Each stdout line is a JSON envelope `{ type, timestamp, sessionID, part }`.
The line parser is a pure function, `parseOpencodeLine(line, state)`, and is
tolerant: malformed lines are logged (via the optional `log` constructor
option) and skipped; unknown envelope types are skipped; nothing crashes the
stream.

| Envelope `type` | Condition                                                               | AgentEvent(s)                                                         |
| --------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `step_start`    | first `sessionID`                                                       | `session` (`sessionId`; emitted exactly once per run)                 |
| `step_start`    | otherwise                                                               | — (state only)                                                        |
| `text`          | `part.text`                                                             | `message-delta` (`delta: part.text`; one delta per text part)         |
| `tool_use`      | `state.status` ∈ {`running`, `pending`}, or first sight of the `callID` | `tool-call` (`tool`, `input: state.input`)                            |
| `tool_use`      | `state.status` ∈ {`completed`, `error`}                                 | `tool-output` (`output: state.output`/`state.error`, stringified)     |
| `step_finish`   | —                                                                       | — (accumulates `part.cost` + envelope timestamps into `handle.usage`) |
| `error`         | `error.data.message`                                                    | `error` (`message`, `code: error.name`)                               |
| `reasoning`     | —                                                                       | skipped (`unmapped-type`)                                             |
| anything else   | —                                                                       | skipped (`unknown-type`)                                              |

Driver-synthesized events: `started` (seq 0, emitted immediately) and
`done`/`error` on termination:

- clean exit (code 0, no `error` envelope) → `done` with `output` = accumulated
  `message-delta` + `tool-output` text
- nonzero exit / kill signal without an `error` envelope → synthetic `error`
  (`code: "OPENCODE_NONZERO_EXIT"`, message includes the stderr tail)

`seq` is **0-based** and monotonically increasing per run (`started` = 0),
matching the fake driver's numbering.

### Termination semantics

- `exited` is driven by the child process lifecycle (`exit`/`close`/spawn
  `error`), **not** by the events iterator being consumed. It resolves even if
  nobody ever iterates `events`, and it never rejects.
- Consumer abandonment (breaking out of the `for await`) does **not** stop the
  run — unlike the fake driver, which treats it as an abort. The child keeps
  running until it exits on its own or `abort()` is called.
- Because the child may outlive interest in its events, the buffer is bounded:
  at most `eventBufferCap` (default **1000**) events are retained per run,
  drop-oldest. `handle.droppedEvents` reports how many were dropped.
- Clean exit → `{ code: 0, reason: "exit", output }`.
- Nonzero exit → `{ code, reason: "error", output }` where `output` is the
  output so far plus a `[stderr] …` tail section when stderr was captured.
- Spawn/startup failures resolve `exited` with `{ reason: "error" }` (and emit
  an `error` event) — `start()` itself never throws for these.

### Abort semantics

- `abort()` sends SIGTERM to the child's **process group**
  (`process.kill(-pid)`), so grandchildren (e.g. shells/tools opencode spawned)
  die too, then escalates to SIGKILL after `killGraceMs` (default **5000 ms**).
- `abort()` resolves only after the run has actually ended; it is idempotent
  and a no-op once the run finished.
- Aborted runs resolve `exited` as `{ code: null, reason: "aborted", output }`
  with the output accumulated so far. If abort races a natural exit, abort
  wins (the run is reported as aborted).

### Error semantics

Startup and run failures surface through both an `error` event and
`exited.reason === "error"` — never a throw out of `start()`. The missing-binary
path is a typed, actionable `OpenCodeDriverError`:

| Code                    | Meaning                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_NOT_FOUND`    | `opencode` binary missing from `PATH` (or `--version` preflight failed). Message tells the user to install opencode and run `opencode auth login`. |
| `OPENCODE_SPAWN_FAILED` | other spawn failure (e.g. `cwd` does not exist)                                                                                                    |
| `OPENCODE_NONZERO_EXIT` | synthetic event code when the child exits nonzero without its own `error` envelope                                                                 |

`OpenCodeDriverError` is its own class (the `DriverError` code union stays
registry-generic); `checkOpenCodeInstalled()` runs the `opencode --version`
preflight for callers that want to fail fast (e.g. daemon boot) — `start()`
does not invoke it, so it stays synchronous-safe.

### Handle extras (beyond `AgentHandle`)

- `handle.pid` / `handle.pgid` — child process id and process-group id
  (`null` when the run never spawned); kept for crash-recovery (#19).
- `handle.usage: Promise<{ cost, durationMs } | null>` — cost summed from
  `step-finish` envelopes and the first→last envelope timestamp span; `null`
  when the run produced no envelopes. (The core `done` event schema is
  strict, so cost/duration cannot travel on the event itself.)
- `handle.lastStderr` — last `stderrTailBytes` (default 4096) of stderr.
- `handle.droppedEvents` — events dropped by the bounded buffer.

### Testing

- Unit tests parse checked-in fixture recordings in `src/fixtures/`
  (`opencode-normal.jsonl`, `opencode-tool-calls.jsonl`, `opencode-error.jsonl`
  are verbatim recordings of `opencode run --format json` v1.18.33;
  `opencode-tolerance.jsonl` is synthetic). Process-level tests spawn a stub
  `opencode` node script from a temp dir with an augmented `PATH`.
- The real-binary smoke test is gated behind `AGENT_E2E=1` and skipped
  otherwise (CI never runs it).
