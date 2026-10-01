# Developer guide

How the pieces fit, the semantics the graph era is built on, and how to extend it.
For the agent-driver contract itself see [packages/drivers/README.md](../packages/drivers/README.md) — this guide links into it rather than duplicating it.

## Package responsibilities

| Package            | Responsibility                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`    | Zod-validated domain schemas: `WorkflowGraph` (nodes/edges + cross-field validation), legacy `Workflow`/`Step`/`LoopBack`, `AgentPreset`, `Project`, `Run`/`StepRun`, agent + run event unions, prompt-template rendering. No I/O.                                                                                                                                           |
| `packages/db`      | Drizzle ORM over better-sqlite3 (WAL, FK enforcement). Schema + shipped migrations + typed repositories (`projects`, `workflows`, `workflowRevisions`, `runs`, `stepRuns`, `events`, `agentPresets`, `activity`). `createDatabase()` opens/migrates and returns a `Db`.                                                                                                      |
| `packages/engine`  | Two executors behind one entry point (`flow-engine.ts`): the **serial graph executor** (`graph-engine.ts`) for revision-pinned runs, and the linear flow/loop executor for legacy/ad-hoc runs. Also the `WorktreeManager` (`worktree.ts`): one isolated worktree + branch per run. Pure with respect to db/drivers — everything is injected.                                 |
| `packages/drivers` | The `AgentDriver` contract, driver registry, the scripted `fake` driver, and the `opencode` driver (spawns `opencode run --format json`). See its [README](../packages/drivers/README.md).                                                                                                                                                                                   |
| `apps/daemon`      | Hono server on :8787 — REST routers (`projects`, `files`, `workflows`, `runs`, `presets`, `drivers`, `system`, `activity`), the executor (scheduler), boot recovery sweep, SSE streaming (per-run events + global run-status), health, graceful shutdown.                                                                                                                    |
| `apps/web`         | Next.js 15 App Router UI on :3000 — dashboard (`/`), projects list/workspace (`/projects/[id]`, Files/Workflows/Runs tabs), the graph canvas editor (`/projects/[id]/workflows/[workflowId]/edit`), run detail (`/runs/[id]`, Graph/Events/Diff/Timeline tabs), setup wizard (`/welcome`), settings (`/settings`). All daemon access goes through `lib/api.ts` (`apiFetch`). |

Composition happens in `apps/daemon/src/index.ts`: database → driver registry (fake + opencode registered at boot) → `WorktreeManager` → executor → recovery sweep → `createApp`. Shutdown unwinds LIFO (http-server → executor → db).

## Data model

SQLite tables (`packages/db/src/schema.ts`), all timestamps ISO-8601 TEXT:

```
projects 1──* workflows 1──* workflow_revisions *──1 runs (runs.workflow_revision_id pins a snapshot)
    │              └──────────────────────────────────* runs 1──* step_runs
    └──* agent_presets (project-scoped "team" roster)
runs 1──* events        activity (dashboard feed, no FKs)
```

- **`projects`** — a registered local repo: `path` (repo root), `name`, `defaultBranch`, optional `remoteUrl`/`dirty` snapshot, `createdAt`.
- **`workflows`** — `projectId` FK, `name`, `steps` + `loopBack` (the legacy mirror, refreshed on graph saves that round-trip), `latestRevisionNumber` (nullable; maintained by the revision repo).
- **`workflow_revisions`** — immutable graph snapshots: `workflowId` FK, per-workflow `number` (unique, starting 1), `graph` (JSON `WorkflowGraph`), `createdAt`. Every save — canvas `PUT /graph` or a legacy steps write (auto-snapshotted) — appends the next revision; nothing ever mutates an existing row.
- **`runs`** — `projectId` FK, nullable `workflowId` FK (absent = ad-hoc run driven by `task`), nullable `workflowRevisionId` FK (the snapshot the run is pinned to at creation; editing the workflow afterwards never affects it), `status` (`queued|running|success|failed|aborted|interrupted`), `branch` (always `agentloop/<runId>`), `iteration` (**0-based** current pass), `breadcrumb` (ordered graph-execution trail, see below), optional `task`/`output`/`error`.
- **`step_runs`** — one row per (node, pass): `runId` FK, `stepId` (the **node id** on graph runs, `"adhoc"` for ad-hoc runs), `iteration` (**1-based**, matching `{{iterations}}`), nullable `sessionId` (agent session, recorded from the driver's `session` event), `status`, `output`, nullable `diff` (`stat\npatch`, see below).
- **`events`** — append-only event log per run: `runId` FK, `seq`, `type`, `payload` (full event JSON without `seq`), `createdAt`.
- **`agent_presets`** — the per-project roster (#49): `projectId` FK, `name`, `description`, optional `icon`, `config` (a full `StepConfig`), `builtin` flag, timestamps.
- **`activity`** — dashboard feed rows (project/workflow created, run started/terminal); plain-text ids, no FKs, auto-increment `id` as the descending feed cursor.

### Graph workflows & revisions

The canonical workflow shape is a **graph** (`WorkflowGraph` in `core/graph.ts`): agent nodes (a full `StepConfig` each) plus `exit` marker nodes, connected by edges carrying an `ExitCondition` (default `always`). A node mixing conditional edges with (at most one) `always` edge is a **router**: conditions evaluate in `order` (first match wins), the `always` edge is the fallback, and no matching edge ends the run. Schema validation (`validateWorkflowGraph`, enforced at save time) rejects unknown entry/edge endpoints, unreachable nodes, unconditional cycles, multiple `always` outgoing edges, duplicate router `order`s, exit nodes with outgoing edges, and `{{output:<nodeId>}}` template references to non-upstream nodes. On save the schema also normalizes: router siblings missing `order` get their edges-array index, and edges participating in a cycle get the default cycle guard (`maxIterations 3`).

`steps` + `loopBack` remains the legacy mirror: `linearToGraph` translates it into an equivalent chain (one node per step, `always` edges, an `exit` node, and — for a loopBack — a conditional loop edge carrying the **negated** exit condition: `contains↔notContains` directly, `invert: true` for `outputMatches`/`always`, plus the loop's `maxIterations`), and `graphToLinear` recognizes exactly that chain+loop shape back. At boot the daemon snapshots every revision-less workflow as revision 1 (idempotent).

**Revision pinning behavior** (core rule pinned by `apps/daemon/src/routes/workflows.test.ts` — "pins each run to the revision latest at creation; later saves never mutate it"):

- Every graph save appends the next immutable revision (`1→2→3…`); the API test "saves graphs as new revisions (1→2→3) with 422 node/edge-attributed details" pins the 422 shape.
- `POST /api/workflows/:id/runs` pins the revision that is latest **at run creation** (`runs.workflowRevisionId`; run responses carry `workflowRevision: { id, number }`).
- Editing the workflow afterwards (new revisions) never re-runs or re-shapes an existing run — resume continues the pinned snapshot too.
- `POST /api/runs/:id/retry` creates a new run and pins the workflow's **current** latest revision (same rule as a fresh run — `ensureLatestRevision` in `routes/runs.ts`), not the original run's snapshot (retry itself is covered by `runs.test.ts` — "copies the workflowId for workflow runs and executes it").
- The run detail page renders the pinned snapshot's graph (fetched via `GET /api/workflows/:id/revisions/:number`) and badges it `pinned revision N`; runs from before revisions fall back to the workflow's current shape with a `legacy workflow` badge.

### Event log & `seq` semantics

- `seq` is assigned **per run** by the repository as `max(seq)+1` inside the insert transaction; `(runId, seq)` is unique-indexed. It is the SSE resume cursor.
- Anything persistable goes in the log (`PersistedEvent` union in `core/run-event.ts`): streamed **driver events** (`started`, `session`, `message-delta`, `tool-call`, `tool-output`, `done`, `error`) plus **engine-emitted lifecycle events** — `run.status` (every transition, exactly one terminal one per execution), and per executor:
  - **graph runs**: `node.queued` / `node.started` / `node.completed`, `edge.taken`, `edge.cap-reached` — **no** `step.*` / `loop.*` events (pinned by the graph-engine test "runs a chain start to exit: node events instead of step events, chained prompts, per-node StepRuns");
  - **legacy runs**: `step.started`, `step.completed`, `loop.iteration` (verdict: `continue` / `exit-condition-met` / `max-iterations` / `hard-cap`).
- Replaying `node.completed` + `edge.taken` in `seq` order reconstructs the persisted run `breadcrumb` exactly (asserted by `replayBreadcrumb` in every graph-engine test).

## Engine semantics

Entry point: `executeRun(runId, control, opts)` — never throws; every failure lands in the run row (`failed` + `error`).

### Two executors, one entry point

`executeRun` creates the worktree (or reuses it on resume), then dispatches: a run with a `workflowRevisionId` goes to the **serial graph executor** (`executeGraphRun`, `graph-engine.ts`); everything else (ad-hoc task runs, revision-less legacy workflow rows) runs through the **linear flow/loop executor**. Both share the per-step machinery (StepRun lifecycle, diff capture, event persistence, run finalization) injected from `flow-engine.ts`, so behavior like "diff failures never fail the run" is identical.

### Graph execution semantics (v0.1 — serial)

Everything below is pinned by `packages/engine/src/graph-engine.test.ts`; test names are quoted so this section and the tests drift together.

**Routing — ONE edge per completion.** Execution starts at `entryNodeId` and follows exactly one outgoing edge per node completion: drawing multiple conditional edges from a node models if/else-style paths, **not** concurrency — parallel fan-out with join/merge is explicitly v0.2. On completion the engine evaluates the node's conditional outgoing edges in `order` (first match wins; `invert` negates the match result) against the node's **final output**; the first matching edge is taken. When none matches, the node's single `always` fallback edge is taken. No outgoing edges at all — or an `exit` node reached — ends the run `success` ("runs a chain start to exit…" and "ends successfully at a dead-end node with no outgoing edges (no exit node needed)"). Test citations: "takes the TRUE conditional path when the condition matches", "takes the always fallback when no conditional edge matches (FALSE path)", "honors router order: first matching conditional wins, later ones never evaluate", "flips the taken path when the router order is swapped (reorder changes first-match)", "negates the match result on inverted edges (invert flag)". The chosen edge is recorded as an `edge.taken` event carrying `edgeId`, `source`, `target`, `matchedCondition`, and the source node's execution number.

**Iterations & cycle guards.** Each node **execution** counts, per node: a node re-entered by a back-edge runs as execution 1, 2, 3…, and that number is what its StepRun row, its `node.*` events and its `{{iterations}}` template variable carry ("exits on the condition at iteration 3: exactly 3 executions, loop edge taken twice, per-node {{iterations}}"). A conditional edge whose target can reach its source (a back-edge; self-loops included) is guarded by `maxIterations` — **counted as edge TAKES**: the edge may be taken at most `min(maxIterations, 25)` times per run (`MAX_EDGE_ITERATIONS = 25` is a hard cap that clamps any larger configuration; the default is 3, stamped onto cycle edges by schema normalization). When a guarded edge's condition matches but the edge is already at its cap, the engine emits `edge.cap-reached` and follows the source node's `always` fallback — the run continues, typically to `success`; with no fallback edge the run **fails** with a reason naming the edge, the cap and the missing fallback ("takes the always fallback when the per-edge cap is reached (run continues to success)" and "fails the run at the hard cap when there is no fallback edge", which also pins the clamp: configured 100 → cap 25 → 26 executions → failure). `always` edges are never guarded; non-back-edge conditional edges cannot cycle so they need no guard. A defensive bound of 5,000 total node executions per run protects against bugs.

> **Documented deviation vs legacy loops:** the legacy `loopBack.maxIterations` counted **passes** (a never-satisfied loop with `maxIterations: 3` ran 3 passes — `flow-engine.test.ts` "stops at maxIterations when the condition is never satisfied (run still success)"), while the graph cap counts **edge takes** (the same shape runs **4** passes: the loop edge is taken after passes 1–3, then the guard blocks the 4th take and the fallback fires). A cap-hit graph loop therefore runs one extra pass compared to the equivalent legacy loop with the same number — including migrated legacy workflows, since `linearToGraph` carries `loopBack.maxIterations` onto the loop edge verbatim.

**Prompt templating.** `promptTemplate` supports:

- `{{task}}` — the run's task;
- `{{prevOutput}}` — the output of the node that **routed into** this execution (the taken edge's source; `""` at the entry). Across a back-edge jump the earlier node receives the routing node's previous output — context flows across the jump ("re-enters via a back-edge to an EARLIER node: prevOutput flows across the jump");
- `{{iterations}}` — this node's own 1-based execution count;
- `{{output:<nodeId>}}` — the referenced node's **most recent completed output** from any earlier point of the run, adjacent or not ("resolves {{output:<nodeId>}} from NON-adjacent upstream nodes (most recent output)"). Save-time validation only allows references to **upstream** nodes (a node with a path to the referencing node); on a run where a diamond routing skipped the referenced node, the missing output is a **node failure** with an actionable message, not a run crash ("fails the node with an actionable message when a referenced node never ran on this path").

Unknown variables are an error at render time (a node failure). Ad-hoc runs execute a single transient step (`stepId: "adhoc"`) whose template is the literal task.

**Sessions.** A `continueSession: true` node reuses its **own** previous execution's session across re-entries (first entry continues the routing source node's session) — "continueSession nodes reuse their own session across re-entries (like #16 same-step reuse)". `sessionId`s are recorded on StepRun rows from the driver's `session` event; an execution that continued a session but did not re-emit `session` keeps the inherited one.

**Failures & aborts.** A failing node fails the run with node attribution (`node "<name>" (<id>) failed: …`); prior StepRuns stay readable, later nodes never start ("fails mid-graph with node attribution; prior StepRuns stay readable, later nodes never start"). Abort mid-node settles the run `aborted` with exactly one terminal `run.status` event ("aborts mid-node: run aborted, earlier nodes stay successful, one terminal run.status").

**Breadcrumb.** The run row carries an ordered `breadcrumb` (JSON column): one `{kind: "node", nodeId, iteration}` entry per completed node execution and one `{kind: "edge", edgeId, iteration}` entry per taken edge (`iteration` = the source node's execution number). It is appended synchronously as execution proceeds, powers the run view's replay, and together with the StepRun rows reconstructs the resume position.

**Resume.** On resume the engine reconstructs position from StepRun rows + the persisted breadcrumb: the latest non-terminal StepRun restarts **with its recorded sessionId** as its recorded execution number; a trailing `edge` breadcrumb entry means the next node is its target (the traversal is not re-emitted); a trailing `node` entry means routing never persisted and is re-derived deterministically from the recorded output; a fully-completed graph finalizes without re-running anything. Guard state (per-edge take counts) and per-node execution counters are reconstructed too. Pinned by the `graph engine (resume after interruption — #19 interplay)` tests: "resumes an interrupted revision-pinned run: restarts the node with its sessionId, no re-runs", "resumes from a persisted edge traversal without re-emitting it (crash between edge and node start)", "resumes a loop mid-flight: reconstructs per-node execution counts and guard state", "finalizes a fully completed graph run on resume without re-running anything". Runs executed by the pre-#45 shim (rows but no breadcrumb) get a fallback breadcrumb replayed from the rows.

### Legacy linear semantics (flows & loops)

Kept for ad-hoc runs and pre-revision workflow rows; a migrated workflow's runs now execute as graphs (above).

- Steps run in workflow order, each invoked through its step's driver inside the run's worktree.
- Without a `loopBack` edge it is a **flow**: one pass, then the run finalizes with the last step's output.
- With a `loopBack` (`{ toStepIndex, when, maxIterations }`) it is a **loop**: after each full pass the exit condition `when` is evaluated against the **final step's output**; unmet → jump back to `steps[toStepIndex]` and run another pass; met or out of iterations → finish `success`. Each verdict is persisted as a `loop.iteration` event.
- `maxIterations` counts **passes**, hard-capped at 25 (`MAX_LOOP_ITERATIONS`); the verdict records `hard-cap` when the clamp fired. (See the deviation note above for the graph-era difference.)

### Exit conditions (`when` / edge `condition`)

`always` | `outputContains: pattern` | `outputNotContains: pattern` | `outputMatches: regex (+flags)` — substring checks, or a regex compiled once per run (validated at save time; `lastIndex` is reset so `g`/`y` flags stay stateless). Graph edges additionally carry the `invert` flag (negate the match at evaluation time) and the router `order`.

### Per-step diff snapshots

After every node/step the engine snapshots the worktree: `git add -A` → `diff` vs the previous snapshot tree + `git write-tree` for the next base (starts at `HEAD`). So each StepRun's stored `diff` is **only that step's changes** (`stat\npatch` combined). Diff-capture failures never fail the run — the step just stores no diff. Snapshot trees are not persisted, so on a resume the diff base resets to `HEAD`: the first step after a resume captures everything since HEAD (later steps are incremental again); the cumulative diff view is unaffected.

## Daemon internals

### Scheduler (two layers, lock order gate → slot)

- **Per-project gate** — only one active run per project (worktrees branch from the same HEAD, so siblings must not race). Later runs for the same project wait FIFO, staying `queued` in the db.
- **Global semaphore** — `p-limit(MAX_CONCURRENT_RUNS)` (default 2, integer ≥ 1, echoed in `/health` as `maxConcurrentRuns`). Runs for _different_ projects execute in parallel up to the cap.
- A run stays `queued` until it holds both its project's turn and a slot; the engine flips it to `running` only when execution actually starts. Queued rows carry a computed `queuePosition` in list/detail responses (not persisted). `POST /api/runs/:id/abort` drops a queued run directly; aborting a running run frees the slot/turn for the next queued run.

### Boot recovery sweep

Before serving, `sweepInterruptedRuns` marks any run left `queued`/`running` by a **previous** daemon process as `interrupted` (steps too), persists a `run.status` event so SSE replay shows the transition, and prunes git worktree metadata across every referenced repo — orphaned worktree paths are **reported, not deleted** (a later `remove(runId)` can still clean the branch).

### Resume & retry

- `POST /api/runs/:id/resume` — interrupted runs only, and only when **every started StepRun recorded a sessionId** (`409 RUN_RESUME_NOT_POSSIBLE` otherwise: the agent context is gone). Re-queues the run in place; the engine continues against the **pinned revision** (graph runs reconstruct as above).
- `POST /api/runs/:id/retry` — any finished run; creates a **new** run (fresh id → fresh `agentloop/<id>` branch and worktree) with the same workflow/task, through the normal scheduler. A retried workflow run pins the workflow's **current** latest revision (same rule as a fresh run).

### Workflow, revision & preset APIs

- `POST /api/workflows` — `{ projectId, name, graph }` (canonical; creates revision 1) or the legacy `{ projectId, name, steps, loopBack? }` (auto-snapshotted as revision 1).
- `PATCH /api/workflows/:id` — legacy field edits; shape changes are auto-snapshotted as a new revision.
- `PUT /api/workflows/:id/graph` — `{ graph }`; validates (422 with node/edge-attributed `details`) and snapshots the next immutable revision. Refreshes the legacy steps mirror when the graph round-trips through `graphToLinear`.
- `GET /api/workflows/:id/revisions` — list (`id`, `number`, `createdAt`; no graph blobs); `GET /api/workflows/:id/revisions/:number` — the full snapshot.
- `POST /api/workflows/:id/runs` — pins the latest revision on the run (`runs.workflowRevisionId`; run responses carry `workflowRevision: { id, number }`).
- `GET/POST /api/projects/:id/presets`, `GET/PATCH/DELETE /api/projects/:id/presets/:presetId` — the agent-preset roster (see [Agent presets](#agent-presets-your-team)).

### SSE protocol (`GET /api/runs/:id/events`)

- Frames: `id: <seq>` / `event: <type>` / `data: <full event JSON>`.
- Replay-then-tail from a cursor: `?afterSeq=` (wins) or the `Last-Event-ID` header — the browser's built-in reconnect resume (tests: "resumes from Last-Event-ID without replaying the prefix", "accepts ?afterSeq= as a cursor alias").
- The stream **closes itself on a terminal `run.status` event** (the engine persists its own closing event); a synthetic terminal event remains only as a fallback for legacy rows/aborts outside the engine.
- Idle heartbeat `: ping` comment every 15s (poll interval 100ms); max 5 concurrent streams per run (`429 TOO_MANY_STREAMS`).

### Global run-status stream & activity feed

- `GET /api/runs/stream` (#51) — one SSE subscription covering **every** run on the daemon: a `run.status` frame whenever any run transitions (queued admission, running start, terminal). Live-only, no replay — latest state comes from the runs table; quiet connections get `: ping` heartbeats. The dashboard's live runs table subscribes to it.
- `GET /api/activity` — the dashboard's activity feed: aggregated `project.created` / `workflow.created` / `run.started` / `run.completed|failed|aborted|interrupted` rows, newest first, cursor-paginated (`cursor` = last item id, `limit` default 20).

### System check (`GET /api/system/check`)

The onboarding wizard's environment preflight (#53): probes git (`git --version`), the opencode CLI (`--version` + `opencode auth list`; exit 0 + non-empty output = authenticated) and the worktree store (created + writable), each with actionable hints. Results are cached for 30s (`?refresh=1` bypasses — the wizard's **Re-check** button); per-command timeout 5s. Tests: `system.test.ts` "caches probes: a second hit within the TTL does not re-spawn binaries", "?refresh=1 bypasses the cache and refreshes it", "unauthenticated opencode (auth list exits non-zero) surfaces the exact login command".

## The web canvas

### Canvas data flow (schema ⇄ React Flow serialization)

The editor's state is a `CanvasDocument` (`apps/web/lib/graph/canvas-document.ts`) — nodes/edges structurally compatible with React Flow's `Node`/`Edge`, deliberately free of React imports so the mapping is unit-testable without a browser:

- `WorkflowGraph → CanvasDocument` (`toCanvasDocument`): one canvas node/edge per graph node/edge; the entry node is marked with a canvas-only `isEntry` flag; agent node data carries `{kind, name, config, presetId?}` and edge data carries `{condition, order?, maxIterations?, invert?}`.
- `CanvasDocument → WorkflowGraph` (`fromCanvasDocument`): passthrough — `entryNodeId` from the `isEntry` node, conditions/inverts copied verbatim. The conversion is 1:1, so **Save** (`PUT …/graph`) snapshots exactly what the canvas shows (minus React Flow runtime keys).
- Legacy workflows (no revision) are converted on load via `linearToGraph` (`workflowToCanvasDocument`).
- The run view (#52) reuses the same conversion read-only: it renders the run's **pinned revision** snapshot (positions included), the workflow's current shape for pre-revision runs, or nothing for ad-hoc runs.

### Dirty state & undo/redo history model

- **Dirty check** — the "unsaved changes" badge compares the current document with the last saved one by their **serialized `WorkflowGraph` projections** (`canvasDocsEquivalent`), so React Flow runtime keys (`selected`, `measured`, `dragging`, …) never read as unsaved changes. Leaving with unsaved changes prompts (browser `beforeunload` + in-app confirm dialog).
- **History** — an immutable-document undo stack (`lib/graph/history.ts`): structural actions (add/connect/delete/auto-layout/preset actions) commit a snapshot; node drags commit one entry per drag (click-to-select without movement commits nothing); inspector edits are **debounced** (500ms) so a burst of keystrokes lands as one undo entry, and a pending edit is settled early when the inspected target changes, on undo/redo, or on save. Undo/redo prune dangling selections.

### Keyboard shortcuts

Available in the canvas editor (also listed by its `?` toolbar popover):

| Shortcut               | Action                                                      |
| ---------------------- | ----------------------------------------------------------- |
| `⌘/Ctrl + S`           | Save (new revision)                                         |
| `⌘/Ctrl + Z`           | Undo                                                        |
| `⇧⌘/Ctrl + Z`          | Redo                                                        |
| `Delete` / `Backspace` | Delete selection (nodes/edges; not while typing in a field) |
| `Space` + drag         | Pan the canvas                                              |
| Scroll                 | Zoom                                                        |
| Drag from handle       | Connect nodes                                               |
| `Shift`/`Meta`         | Multi-select modifier                                       |

### Editing UX

- **Palette** (left) — "Steps" section (Agent step, Exit node) + "Your team" (the project's presets; **Manage** opens the presets manager drawer). Items are click-to-add (auto-placed) or drag-and-drop.
- **Node inspector** (right drawer) — the agent node's config: name, promptTemplate with insert-variable buttons (the `{{output:…}}` picker lists upstream nodes only) and a live sample-data preview, driver (read-only badge — per-node driver picking is on the roadmap), optional model, `auto`/`ask` mode, `continueSession`; zod field errors inline. Preset provenance: "from preset: X" badge with **Detach** / **Update from preset**, plus **Save as preset…**. The entry node cannot be deleted.
- **Edge drawer** (right) — condition type + pattern/regex/flags, `invert` toggle, `maxIterations` (shown for back-edges), the source router's evaluation order (move up/down renumbers siblings), a sample-output matcher preview, and delete.
- **Validation** — client-side validation mirrors the daemon's (`lib/graph/validation.ts`); issues render as badges on the offending nodes/edges plus a bottom-left panel with click-to-focus. Save is blocked while issues remain; daemon-side 422s map onto the same badges. Router-without-fallback is an advisory warning (live, not save-gated).
- **Auto-layout** — deterministic dagre left-to-right layout (`lib/graph/layout.ts`), then fit-view.

### Run view

The run detail page folds the SSE stream into graph state through an idempotent reducer (`lib/run-graph/fold.ts`) applied by a throttled batcher (`lib/run-graph/batcher.ts`, ≤1 React state update per 125ms window — a 500-event replay burst cannot trigger 500 re-renders); unchanged nodes keep object identity so React Flow's memoized cards skip re-rendering. Finished runs get a replay scrubber (prev/next/play over the breadcrumb positions). The Events tab shows the raw feed with reconnect; the Diff tab per-step + cumulative diffs; the Timeline tab the execution list.

## Agent presets ("your team")

`AgentPreset` (`core/preset.ts`) = a named, described, optionally icon'd `StepConfig`, **project-scoped** in v0.1.

- **Copy-on-create** — creating a node from a preset deep-copies the config (name uniquified against taken node names) and carries `presetId` for the inspector badge only. Preset edits and deletes **never** mutate existing nodes; a deleted preset's nodes just render as plain nodes (the badge lookup misses — no doc mutation, no dangling anything).
- **Update from preset is explicit** — the inspector's "Update from preset" copies the preset's **current** config + name into the node as one undo snapshot; "Detach" drops the link and keeps the copy.
- **Builtins seeded per project** — registering a project seeds three ordinary preset rows (🛠️ Implementer, 🔍 Reviewer — `ask` mode, 🧪 Test Writer) whose prompts stick to graph-position-agnostic variables (`{{task}}`, `{{prevOutput}}`). They are deletable/editable like any other row, never sacred (`presets.test.ts` describe "builtin presets (seeded on project creation)").
- **"Save as preset…"** turns any configured node into a new roster entry (POST with the node's config copy).

## Template authoring (starter templates)

The wizard's starters live in `apps/web/lib/onboarding/templates.ts` as code — plain `WorkflowGraphShape` objects (importing only `@openeuler/core`, so daemon integration tests round-trip the exact graphs users get). Exactly two ship, plus the implicit "blank canvas" (a single entry agent prompted with `{{task}}`, `starterGraph()` in `lib/graph/canvas-document.ts`):

- **`implement-review-fix`** — Implement → Reviewer(router) → Fix: `e-reviewer-approve` (`outputContains "LGTM"`, order 0) → exit; `e-reviewer-fix` (`outputNotContains "LGTM"`, order 1, `maxIterations: 3`) → fix → always back to reviewer. The reviewer/fixer prompts read `{{output:implement}}` / `{{output:reviewer}}`.
- **`feature-pipeline`** — implement → tests → docs → exit, a linear `always` chain passing `{{output:<node>}}` context.

Authoring guidance:

- The graph JSON shape is exactly `WorkflowGraph`: `{ entryNodeId, nodes, edges }`; agent nodes are `{ id, type: "agent", name, position, config: StepConfig }`, exit nodes `{ id, type: "exit", name, position }`; edges `{ id, source, target, condition, order?, maxIterations?, invert? }` with `condition` an `ExitCondition` (`{ type: "always" }` | `outputContains/outputNotContains: { type, pattern }` | `outputMatches: { type, regex, flags? }`). `position` is canvas layout, semantics-free.
- Validation is `validateWorkflowGraph` (the same rules the daemon enforces on save — see [Graph workflows & revisions](#graph-workflows--revisions)). Templates that violate them fail the wizard launch with a 422, so author against the schema: unique ids, referenced endpoints exist, exactly one agent `entryNodeId`, every node reachable from the entry, no unconditional cycles, ≤1 `always` out-edge per node, unique router `order`s, exit nodes terminal, `{{output:<nodeId>}}` references upstream-only.
- Give every node a stable, readable id — `{{output:<nodeId>}}` prompts and edge ids read better (`e-<source>-<target>`).
- Back-edges (cycles) need an explicit `maxIterations` (schema normalization would default it to 3 anyway) and a conditional first edge; the loop's exit path should be the `always` fallback so a cap-hit run still succeeds.
- Defaults: the starters' nodes use `opencode`; new palette nodes default to the first registered driver (the daemon registers `fake` first). The canvas shows a node's driver as a read-only badge for now, so switch drivers in the graph JSON before importing (or change the registration order).

## Onboarding wizard

Route `/welcome` (`apps/web/app/welcome/page.tsx`), state machine in `lib/onboarding/wizard.ts` (pure reducer, headless-testable):

- **Fresh-DB auto-start** — the dashboard mounts `FreshInstallWizardRedirect`: when the daemon reports **no projects AND no workflows** and completion is not remembered (`localStorage["onboarding.completed"]`), it replaces the URL with `/welcome`. Any non-fresh state is a no-op.
- **Four steps** — Environment (system check, polled every 5s while visible; git + writable worktree store required, opencode problems warn only) → Project (open by absolute path or pick existing) → Starter (the two templates + blank canvas cards) → Launch (task text). "Continue" gating and blocked reasons are computed by `canContinue`/`continueBlockedReason`.
- **Skip / re-run** — **Skip setup** marks completion and returns to the dashboard; the wizard stays reachable at `/welcome` and Settings offers **Re-run setup wizard**.
- **Launch** (`lib/onboarding/launch.ts`) — `createWorkflowWithGraph` (revision 1 snapshots the starter) → `startWorkflowRun` (pins revision 1) → navigate to `/runs/<runId>`.

## Adding a new agent driver

The full contract (lifecycle, event-stream and abort semantics, error codes) lives in [packages/drivers/README.md](../packages/drivers/README.md). The short path:

1. **Implement the contract** — create `packages/drivers/src/<id>.ts` exporting `create<Id>Driver(): AgentDriver` (`{ id, start(opts): AgentHandle }`). The handle streams `AgentEvent`s (monotonic `seq`, first event `started`), maps termination to `AgentExit`, honors `abort()`, and never lets `exited` reject. Reuse `@openeuler/core`'s `AgentEvent` schemas when parsing the agent's output; throw `DriverError` for driver-level failures.
2. **Export it** from `packages/drivers/src/index.ts`.
3. **Register it at daemon boot** — in `apps/daemon/src/index.ts`, next to the existing `drivers.registerDriver(createFakeDriver())` / `createOpenCodeDriver()` calls. This is what makes it appear in `GET /api/drivers` (and thus selectable for node configs) and resolvable for `config.driver` / `OPENEULER_DRIVER`.
4. **Test it** — unit tests with a stub binary (see `opencode.test.ts`'s PATH-augmented stub) or pure parser fixtures in `src/fixtures/`; gate any real-binary smoke test behind `AGENT_E2E=1`.
5. **Smoke it** — `curl localhost:8787/api/drivers`, then run a one-node workflow with `driver: "<id>"`.

## Web design system (issue #50)

- **Tokens** — semantic CSS variables in `apps/web/app/globals.css` (`bg/surface/elevated/border/fg/muted-fg/accent(+hover/-fg)/link` + `success/warning/danger/info` each with a `-subtle` bg, plus typography scale `display/title/body/small/mono`, `--radius-*`, `--shadow-1/2/3`). Tailwind v4 `@theme inline` maps them to utilities (`bg-surface`, `text-muted-fg`, `shadow-1`…). Never use raw palette classes (`slate-*`, `red-*`…) in app code — only semantic tokens.
- **Theming** — dark is the default (`:root`); light opts in via `<html data-theme="light">`. The persisted choice (`localStorage["openeuler-theme"]`, see `lib/theme.ts`) is applied before first paint by an inline script in the root layout, so there is no flash and no hydration mismatch. `lib/contrast.test.ts` hardcodes the token RGBs and asserts WCAG AA (≥4.5:1) for the core pairs in both themes — keep it in sync with globals.css.
- **Primitives** — `components/ui/*` (Button, Card, Badge + status map, Dialog, Drawer, Tabs, Table, Toast, Skeleton, EmptyState, Input/Field). `components/StatusBadge.tsx` is a thin wrapper over `ui/badge` mapping every run/step/node status; modals (NewRunModal, RunWorkflowModal, ⌘K palette) build on the Dialog primitive's focus trap.
- **App shell** — `components/shell/` (Sidebar, TopBar, CommandPalette, icons, HealthPill) in the root layout. Sidebar collapse (`localStorage["openeuler-sidebar"]`) and the ⌘K palette state machine (`lib/command-palette.ts`, fuzzy scoring in `lib/fuzzy.ts`) are pure modules unit-tested without a browser.

## Testing conventions

- **Vitest per package** (`pnpm -r test`; `pnpm test` from the root runs all). Colocated `*.test.ts` next to sources; no separate test tree.
- **The fake driver is the seam** — engine/daemon/web tests script agent behavior with `createFakeDriver({ events, outputs, delayMs, failOnAbort })` instead of a real agent. Per-start `outputs` (cycling by call count) drive router/loop tests.
- **Temp repos for git code** — worktree/daemon tests build throwaway git repos in temp dirs (init → commit) and point `OPENEULER_WORKTREES`/db paths at temp stores; nothing touches the developer's checkout.
- **Real binaries are opt-in** — `opencode.e2e.test.ts` skips unless `AGENT_E2E=1`; CI never runs it.
- **Web UI logic is extracted into pure modules** — canvas document ops, validation, history, edge inspector rules, run feed, run-graph fold/replay, wizard reducer — all unit-tested without a browser; page components add render-markup assertions.
- **Semantics are pinned in `packages/engine/src/graph-engine.test.ts`** — when touching the graph engine, keep the quoted test names in this guide's [graph execution section](#graph-execution-semantics-v01--serial) in sync.
- Lint/format/typecheck: `pnpm lint` (eslint), `pnpm format:check` (prettier), `pnpm typecheck` (tsc per package).

## Troubleshooting

- **Old runs vs edited workflows (revision mismatch)** — runs pin the revision latest at creation, so an old run's Graph tab can legitimately look different from the canvas. What users see: the tab badges `pinned revision N` (the run's snapshot — always accurate) or `legacy workflow` (pre-revision run: the graph is folded from the workflow's **current** legacy mirror, so nodes renamed/deleted since show without status; the Events/Timeline tabs remain authoritative). Ad-hoc runs or deleted workflows show "Graph unavailable" with a pointer to Events. Fix nothing — re-run the workflow to pick up the latest revision (retry also re-pins latest).
- **Cap semantics: cap-hit loops run one extra pass** — a loop edge with `maxIterations: 3` whose condition never stops matching executes the node **4** times (the edge is taken 3 times, then the guard blocks the 4th take and the `always` fallback fires), emitting one `edge.cap-reached`. Legacy loops with the same number ran 3 passes. This is the documented edge-takes vs passes counting difference (see the deviation note above); with no fallback edge the run fails with `cycle guard reached on edge …` instead.
- **Canvas performance with large graphs** — the run view batches graph re-renders (one per 125ms window) and preserves node object identity, so event bursts (including a full SSE replay) don't thrash React; the editor's undo history keeps immutable document snapshots in memory (bounded by edits this session) and its dirty check is a JSON projection compare per edit — fine into the hundreds of nodes. Very large graphs are still DOM-bound through React Flow: prefer auto-layout, and note per-run SSE streams are capped at 5 concurrent per run (429 otherwise).
- **opencode auth issues** — run the wizard's environment check (`/welcome` step 1, or `curl localhost:8787/api/system/check`): it reports the CLI version, whether `opencode auth list` shows a provider, and the exact fix (`opencode auth login`). Unauthenticated opencode never blocks the wizard — only real `opencode`-driver runs fail (with `OPENCODE_NOT_FOUND` at spawn/auth time); switch nodes to the `fake` driver to keep moving.
- **`opencode` not found / not authenticated (runs)** — a run using the `opencode` driver fails with error code `OPENCODE_NOT_FOUND` ("opencode CLI not found on PATH … authenticate with `opencode auth login`"). Install from <https://opencode.ai/docs/install>, run `opencode auth login`, then retry the run.
- **Worktree errors on empty repos** — opening a repo with no commits returns a warning ("repository has no commits yet; branch creation will fail…"); the run then fails at worktree creation with `EMPTY_REPO`. Fix: `git commit --allow-empty -m init` in the repo. A non-repo path is rejected at open time with `NOT_A_GIT_REPOSITORY`.
- **Daemon down** — the health pill in the top bar shows _Daemon unreachable_ and API calls surface `NETWORK_ERROR`. Restart with `pnpm dev`.
- **Interrupted runs after a crash** — on boot the daemon sweeps runs left `queued`/`running` by a dead process and marks them `interrupted`. Their detail page offers **Resume** (only when every started node recorded a session id) or **Retry as new run** (always available; fresh run id/branch/worktree, pinned to the current latest revision).
