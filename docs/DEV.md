# Developer guide

How the pieces fit, the semantics the MVP is built on, and how to extend it.
For the agent-driver contract itself see [packages/drivers/README.md](../packages/drivers/README.md) — this guide links into it rather than duplicating it.

## Package responsibilities

| Package            | Responsibility                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`    | Zod-validated domain schemas: `Project`, `Workflow`/`Step`/`LoopBack`, `Run`/`StepRun`, agent + run event unions, prompt-template rendering. No I/O.                                                                                                                                             |
| `packages/db`      | Drizzle ORM over better-sqlite3 (WAL, FK enforcement). Schema + shipped migrations + typed repositories (`projects`, `workflows`, `runs`, `stepRuns`, `events`). `createDatabase()` opens/migrates and returns a `Db`.                                                                           |
| `packages/engine`  | The flow engine (`flow-engine.ts`): drives a queued run to a terminal state. Also the `WorktreeManager` (`worktree.ts`): one isolated worktree + branch per run. Pure with respect to db/drivers — everything is injected.                                                                       |
| `packages/drivers` | The `AgentDriver` contract, driver registry, the scripted `fake` driver, and the `opencode` driver (spawns `opencode run --format json`). See its [README](../packages/drivers/README.md).                                                                                                       |
| `apps/daemon`      | Hono server on :8787 — REST routers (`projects`, `files`, `workflows`, `runs`, `drivers`), the executor (scheduler), boot recovery sweep, SSE streaming, health, graceful shutdown.                                                                                                              |
| `apps/web`         | Next.js 15 App Router UI on :3000 — dashboard (`/`), projects list/workspace (`/projects/[id]`, file browser tab), workflows (`/projects/[id]/workflows`, builder), runs list and run detail (`/runs/[id]`, live SSE feed, diffs tab). All daemon access goes through `lib/api.ts` (`apiFetch`). |

Composition happens in `apps/daemon/src/index.ts`: database → driver registry (fake + opencode registered at boot) → `WorktreeManager` → executor → recovery sweep → `createApp`. Shutdown unwinds LIFO (http-server → executor → db).

## Data model

Five SQLite tables (`packages/db/src/schema.ts`), all timestamps ISO-8601 TEXT:

```
projects 1──* workflows 1──* runs 1──* step_runs
    └──────────────────────* runs 1──* events
workflows 1──* workflow_revisions *──1 runs (runs.workflow_revision_id pins a snapshot)
```

- **`projects`** — a registered local repo: `path` (repo root), `name`, `defaultBranch`, optional `remoteUrl`/`dirty` snapshot, `createdAt`.
- **`workflows`** — `projectId` FK, `name`, `steps` (JSON array of `Step`), `loopBack` (JSON `LoopBack` or null), `latestRevisionNumber` (nullable; maintained by the revision repo).
- **`workflow_revisions`** — immutable graph snapshots: `workflowId` FK, per-workflow `number` (unique, starting 1), `graph` (JSON `WorkflowGraph`), `createdAt`. Every save — canvas `PUT /graph` or a legacy steps write (auto-snapshotted) — appends the next revision.
- **`runs`** — `projectId` FK, nullable `workflowId` FK (absent = ad-hoc run driven by `task`), nullable `workflowRevisionId` FK (the snapshot the run is pinned to at creation; editing the workflow afterwards never affects it), `status` (`queued|running|success|failed|aborted|interrupted`), `branch` (always `agentloop/<runId>`), `iteration` (**0-based** current pass), optional `task`/`output`/`error`.
- **`step_runs`** — one row per (step, pass): `runId` FK, `stepId` (`"adhoc"` for ad-hoc runs), `iteration` (**1-based**, matching `{{iterations}}`), nullable `sessionId` (agent session, recorded from the driver's `session` event), `status`, `output`, nullable `diff` (`stat\npatch`, see below).
- **`events`** — append-only event log per run: `runId` FK, `seq`, `type`, `payload` (full event JSON without `seq`), `createdAt`.

### Graph workflows & revisions

The canonical workflow shape is a **graph** (`WorkflowGraph` in `core/graph.ts`): agent nodes (the existing step config) plus `exit` marker nodes, connected by edges carrying an `ExitCondition` (default `always`). A node mixing conditional edges with (at most one) `always` edge is a **router**: conditions evaluate in `order` (first match wins; #45), the `always` edge is the fallback, and no matching edge ends the run. Schema validation (`validateWorkflowGraph`, enforced at save time) rejects unknown entry/edge endpoints, unreachable nodes, unconditional cycles, multiple `always` outgoing edges, duplicate router `order`s, and `{{output:<nodeId>}}` template references to non-upstream nodes. Edge `maxIterations` is the cycle guard (default 3, normalized onto cycle edges).

`steps` + `loopBack` remains the legacy mirror: `linearToGraph` translates it into an equivalent chain (one node per step, `always` edges, an `exit` node, and — for a loopBack — a conditional loop edge carrying the **negated** exit condition: `contains↔notContains` directly, `invert: true` for `outputMatches`/`always`, plus the loop's `maxIterations`), and `graphToLinear` recognizes exactly that chain+loop shape back. At boot the daemon snapshots every revision-less workflow as revision 1 (idempotent). Until the graph engine lands (#45), pinned revision runs execute through a shim that converts the graph back to steps+loopBack — identical behavior for migrated workflows; richer routers fail fast with an actionable error.

### Event log & `seq` semantics

- `seq` is assigned **per run** by the repository as `max(seq)+1` inside the insert transaction; `(runId, seq)` is unique-indexed. It is the SSE resume cursor.
- Anything persistable goes in the log (`PersistedEvent` union in `core/run-event.ts`): streamed **driver events** (`started`, `session`, `message-delta`, `tool-call`, `tool-output`, `done`, `error`) plus **engine-emitted lifecycle events** — `run.status` (every transition, exactly one terminal one per execution), `step.started`, `step.completed`, `loop.iteration` (verdict: `continue` / `exit-condition-met` / `max-iterations` / `hard-cap`).

## Engine semantics

Entry point: `executeRun(runId, control, opts)` — never throws; every failure lands in the run row (`failed` + `error`).

### Flow vs loop

- Steps run in workflow order, each invoked through its step's driver inside the run's worktree.
- Without a `loopBack` edge it is a **flow**: one pass, then the run finalizes with the last step's output.
- With a `loopBack` (`{ toStepIndex, when, maxIterations }`) it is a **loop**: after each full pass the exit condition `when` is evaluated against the **final step's output**; unmet → jump back to `steps[toStepIndex]` and run another pass; met or out of iterations → finish `success`. Each verdict is persisted as a `loop.iteration` event.
- `maxIterations` is **hard-capped at 25** (`MAX_LOOP_ITERATIONS`): the engine clamps `min(configured, 25)`, and the verdict records `hard-cap` when the clamp fired.

### Exit conditions (`when`)

`always` | `outputContains: pattern` | `outputNotContains: pattern` | `outputMatches: regex (+flags)` — substring checks, or a regex compiled once per run (validated at save time; `lastIndex` is reset so `g`/`y` flags stay stateless).

### Prompt templating

`promptTemplate` supports `{{task}}` (the run's task), `{{prevOutput}}` (previous step's output this pass), `{{iterations}}` (current pass, 1-based), and — in graph workflows — `{{output:<nodeId>}}` (any upstream node's final output; referencing a non-upstream node is rejected at save time, a missing output is an error at render time). Unknown variables are an error at render time. Ad-hoc runs execute a single transient step (`stepId: "adhoc"`) whose template is the literal task.

### Session continuation

- A step with `continueSession: true` is started with a previous `sessionId` (driver `--session`): across loop passes the **same step's** previous-iteration session wins (the reviewer keeps its own context); otherwise the previous step's session in flow order (linear chaining).
- `sessionId`s are recorded on the StepRun row from the driver's `session` event; a step that continued a session but did not re-emit `session` keeps the inherited one.

### Iteration & prevOutput rules

- After a loop-back jump the first re-run step receives the **last step's output from the previous iteration** as `{{prevOutput}}` — context flows across the jump.
- `Run.iteration` (0-based) is the persisted current pass; `StepRun.iteration` (1-based) matches `{{iterations}}`. Exactly one StepRun row exists per (stepId, iteration), even across resumes.

### Per-step diff snapshots

After every step the engine snapshots the worktree: `git add -A` → `diff` vs the previous snapshot tree + `git write-tree` for the next base (starts at `HEAD`). So each StepRun's stored `diff` is **only that step's changes** (`stat\npatch` combined). Diff-capture failures never fail the run — the step just stores no diff.

### Resume (and its degradation)

On resume the engine reconstructs position from StepRun rows: the first non-successful step in the latest iteration restarts **with its recorded sessionId**, the existing worktree is reused (uncommitted agent changes included). Snapshot trees are not persisted, so the diff base resets to `HEAD`: the **first step after a resume captures everything since HEAD** (later steps are incremental again); the cumulative diff view is unaffected.

## Daemon internals

### Scheduler (two layers, lock order gate → slot)

- **Per-project gate** — only one active run per project (worktrees branch from the same HEAD, so siblings must not race). Later runs for the same project wait FIFO, staying `queued` in the db.
- **Global semaphore** — `p-limit(MAX_CONCURRENT_RUNS)` (default 2, integer ≥ 1, echoed in `/health` as `maxConcurrentRuns`). Runs for _different_ projects execute in parallel up to the cap.
- A run stays `queued` until it holds both its project's turn and a slot; the engine flips it to `running` only when execution actually starts. Queued rows carry a computed `queuePosition` in list/detail responses (not persisted). `POST /api/runs/:id/abort` drops a queued run directly; aborting a running run frees the slot/turn for the next queued run.

### Boot recovery sweep

Before serving, `sweepInterruptedRuns` marks any run left `queued`/`running` by a **previous** daemon process as `interrupted` (steps too), persists a `run.status` event so SSE replay shows the transition, and prunes git worktree metadata across every referenced repo — orphaned worktree paths are **reported, not deleted** (a later `remove(runId)` can still clean the branch).

### Resume & retry

- `POST /api/runs/:id/resume` — interrupted runs only, and only when **every started StepRun recorded a sessionId** (`409 RUN_RESUME_NOT_POSSIBLE` otherwise: the agent context is gone). Re-queues the run in place; the engine continues as above.
- `POST /api/runs/:id/retry` — any finished run; creates a **new** run (fresh id → fresh `agentloop/<id>` branch and worktree) with the same workflow/task, through the normal scheduler. A retried workflow run pins the workflow's **current** latest revision (same rule as a fresh run).

### Workflow & revision API

- `POST /api/workflows` — `{ projectId, name, graph }` (canonical; creates revision 1) or the legacy `{ projectId, name, steps, loopBack? }` (auto-snapshotted as revision 1).
- `PATCH /api/workflows/:id` — legacy field edits; shape changes are auto-snapshotted as a new revision.
- `PUT /api/workflows/:id/graph` — `{ graph }`; validates (422 with node/edge-attributed `details`) and snapshots the next immutable revision. Refreshes the legacy steps mirror when the graph round-trips.
- `GET /api/workflows/:id/revisions` — list (`id`, `number`, `createdAt`; no graph blobs); `GET /api/workflows/:id/revisions/:number` — the full snapshot.
- `POST /api/workflows/:id/runs` — pins the latest revision on the run (`runs.workflowRevisionId`; run responses carry `workflowRevision: { id, number }`).

### SSE protocol (`GET /api/runs/:id/events`)

- Frames: `id: <seq>` / `event: <type>` / `data: <full event JSON>`.
- Replay-then-tail from a cursor: `?afterSeq=` (wins) or the `Last-Event-ID` header — the browser's built-in reconnect resume.
- The stream **closes itself on a terminal `run.status` event** (the engine persists its own closing event); a synthetic terminal event remains only as a fallback for legacy rows/aborts outside the engine.
- Idle heartbeat `: ping` comment every 15s (poll interval 100ms); max 5 concurrent streams per run (`429 TOO_MANY_STREAMS`).

## Adding a new agent driver

The full contract (lifecycle, event-stream and abort semantics, error codes) lives in [packages/drivers/README.md](../packages/drivers/README.md). The short path:

1. **Implement the contract** — create `packages/drivers/src/<id>.ts` exporting `create<Id>Driver(): AgentDriver` (`{ id, start(opts): AgentHandle }`). The handle streams `AgentEvent`s (monotonic `seq`, first event `started`), maps termination to `AgentExit`, honors `abort()`, and never lets `exited` reject. Reuse `@openeuler/core`'s `AgentEvent` schemas when parsing the agent's output; throw `DriverError` for driver-level failures.
2. **Export it** from `packages/drivers/src/index.ts`.
3. **Register it at daemon boot** — in `apps/daemon/src/index.ts`, next to the existing `drivers.registerDriver(createFakeDriver())` / `createOpenCodeDriver()` calls. This is what makes it appear in `GET /api/drivers` (and thus the workflow builder's driver dropdown) and resolvable for `step.driver` / `OPENEULER_DRIVER`.
4. **Test it** — unit tests with a stub binary (see `opencode.test.ts`'s PATH-augmented stub) or pure parser fixtures in `src/fixtures/`; gate any real-binary smoke test behind `AGENT_E2E=1`.
5. **Smoke it** — `curl localhost:8787/api/drivers`, then run a one-step workflow with `driver: "<id>"`.

## Web design system (issue #50)

- **Tokens** — semantic CSS variables in `apps/web/app/globals.css` (`bg/surface/elevated/border/fg/muted-fg/accent(+hover/-fg)/link` + `success/warning/danger/info` each with a `-subtle` bg, plus typography scale `display/title/body/small/mono`, `--radius-*`, `--shadow-1/2/3`). Tailwind v4 `@theme inline` maps them to utilities (`bg-surface`, `text-muted-fg`, `shadow-1`…). Never use raw palette classes (`slate-*`, `red-*`…) in app code — only semantic tokens.
- **Theming** — dark is the default (`:root`); light opts in via `<html data-theme="light">`. The persisted choice (`localStorage["openeuler-theme"]`, see `lib/theme.ts`) is applied before first paint by an inline script in the root layout, so there is no flash and no hydration mismatch. `lib/contrast.test.ts` hardcodes the token RGBs and asserts WCAG AA (≥4.5:1) for the core pairs in both themes — keep it in sync with globals.css.
- **Primitives** — `components/ui/*` (Button, Card, Badge + status map, Dialog, Drawer, Tabs, Table, Toast, Skeleton, EmptyState, Input/Field). `components/StatusBadge.tsx` is a thin wrapper over `ui/badge` mapping every run/step/node status; modals (NewRunModal, RunWorkflowModal, ⌘K palette) build on the Dialog primitive's focus trap.
- **App shell** — `components/shell/` (Sidebar, TopBar, CommandPalette, icons) replaces the old TopNav in the root layout. Sidebar collapse (`localStorage["openeuler-sidebar"]`) and the ⌘K palette state machine (`lib/command-palette.ts`, fuzzy scoring in `lib/fuzzy.ts`) are pure modules unit-tested without a browser.

## Testing conventions

- **Vitest per package** (`pnpm -r test`; `pnpm test` from the root runs all). Colocated `*.test.ts` next to sources; no separate test tree.
- **The fake driver is the seam** — engine/daemon/web tests script agent behavior with `createFakeDriver({ events, outputs, delayMs, failOnAbort })` instead of a real agent. Per-start `outputs` (cycling by call count) drive loop-exit tests.
- **Temp repos for git code** — worktree/daemon tests build throwaway git repos in temp dirs (init → commit) and point `OPENEULER_WORKTREES`/db paths at temp stores; nothing touches the developer's checkout.
- **Real binaries are opt-in** — `opencode.e2e.test.ts` skips unless `AGENT_E2E=1`; CI never runs it.
- Web UI logic (graph canvas ops, run feed, diff parsing) is extracted into pure `lib/*.ts` modules unit-tested without a browser; page components render-markup assertions cover the rest.
- Lint/format/typecheck: `pnpm lint` (eslint), `pnpm format:check` (prettier), `pnpm typecheck` (tsc per package).
