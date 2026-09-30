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
