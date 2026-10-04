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
    │              │ 1──1 workflow_webhooks 1──* webhook_deliveries (ring, no FKs)
    │              └──────────────────────────────────* runs 1──* step_runs
    └──* agent_presets (project-scoped "team" roster)
runs 1──* events        activity (dashboard feed, no FKs)
```

- **`projects`** — a registered local repo: `path` (repo root), `name`, `defaultBranch`, optional `remoteUrl`/`dirty` snapshot, `createdAt`.
- **`workflows`** — `projectId` FK, `name`, `steps` + `loopBack` (the legacy mirror, refreshed on graph saves that round-trip), `latestRevisionNumber` (nullable; maintained by the revision repo).
- **`workflow_revisions`** — immutable graph snapshots: `workflowId` FK, per-workflow `number` (unique, starting 1), `graph` (JSON `WorkflowGraph`), `createdAt`. Every save — canvas `PUT /graph` or a legacy steps write (auto-snapshotted) — appends the next revision; nothing ever mutates an existing row.
- **`runs`** — `projectId` FK, nullable `workflowId` FK (absent = ad-hoc run driven by `task`), nullable `workflowRevisionId` FK (the snapshot the run is pinned to at creation; editing the workflow afterwards never affects it), `status` (`queued|running|success|failed|aborted|interrupted`), `branch` (always `agentloop/<runId>`), `iteration` (**0-based** current pass), `breadcrumb` (ordered graph-execution trail, see below), nullable `ports`/`detectedPorts` (JSON int[] for #107: declared-at-creation / auto-detected-from-output ports), nullable `hosting` (JSON for #110: `{enabled, keepAliveMinutes?}` requested at creation) and `hostedUntil` (ISO expiry while the run is hosted, #110), optional `task`/`output`/`error`.
- **`step_runs`** — one row per (node, pass): `runId` FK, `stepId` (the **node id** on graph runs, `"adhoc"` for ad-hoc runs), `iteration` (**1-based**, matching `{{iterations}}`), nullable `sessionId` (agent session, recorded from the driver's `session` event), `status`, `output`, nullable `diff` (`stat\npatch`, see below).
- **`events`** — append-only event log per run: `runId` FK, `seq`, `type`, `payload` (full event JSON without `seq`), `createdAt`.
- **`agent_presets`** — the per-project roster (#49): `projectId` FK, `name`, `description`, optional `icon`, `config` (a full `StepConfig`), `builtin` flag, timestamps.
- **`activity`** — dashboard feed rows (project/workflow created, run started/terminal); plain-text ids, no FKs, auto-increment `id` as the descending feed cursor.

### Graph workflows & revisions

The canonical workflow shape is a **graph** (`WorkflowGraph` in `core/graph.ts`): agent nodes (a full `StepConfig` each), `exit` marker nodes and `join` synchronizer nodes (#115), connected by edges carrying an `ExitCondition` (default `always`). A node's outgoing edges form one of three shapes: a **router** (conditional edges evaluate in `order`, first match wins, an optional single `always` edge is the fallback, no match without fallback ends the run), a **fan-out** (ALL outgoing edges `always` — each starts a parallel branch, #115), or a terminal (no outgoing edges). Mixing the two — multiple `always` edges next to conditionals — is rejected. Schema validation (`validateWorkflowGraph`, enforced at save time) rejects unknown entry/edge endpoints, unreachable nodes, unconditional cycles (fan-out/join cycles included), fan-out/router mixing, fan-out edges that do not target distinct agent nodes, agent nodes receiving `always` edges from parallel branches (fan-in is a join's job; serial loop shapes stay valid), join nodes with fewer than two incoming or more than one non-`always` outgoing edge, duplicate router `order`s, exit nodes with outgoing edges, and `{{output:<nodeId>}}` template references to non-upstream nodes. On save the schema also normalizes: router siblings missing `order` get their edges-array index, and edges participating in a cycle get the default cycle guard (`maxIterations 3`).

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
  - **graph runs**: `node.queued` / `node.started` / `node.completed`, `edge.taken`, `edge.cap-reached` — **no** `step.*` / `loop.*` events (pinned by the graph-engine test "runs a chain start to exit: node events instead of step events, chained prompts, per-node StepRuns"). `node.queued` fires at SCHEDULING time (a capped-out fan-out branch shows as queued while waiting for an inner slot), and parallel branch executions carry the fan-out branch `edgeId` (#115, additive); fan-out traversal itself emits no `edge.taken` — routers/chain edges do;
  - **legacy runs**: `step.started`, `step.completed`, `loop.iteration` (verdict: `continue` / `exit-condition-met` / `max-iterations` / `hard-cap`).
  - **sandboxed runs** (#104): `sandbox.log {sandboxId, stream, line}` — the run's container stdout/stderr tailed by the executor (one event per line, in emission order, secret-redacted) while the run's sandbox exists; bounded to the last 2,000 lines per run (drop-oldest ring implemented via `events.deleteOldestByType`), with ONE terminal `sandbox.log-truncated {dropped, kept}` marker appended when the tailer stops. The web feed renders them as mono gray lines under "All" only; the graph fold and timeline ignore them (seq-cursor only).
- Replaying `node.completed` + `edge.taken` in `seq` order reconstructs the persisted run `breadcrumb` exactly (asserted by `replayBreadcrumb` in every graph-engine test).

## Engine semantics

Entry point: `executeRun(runId, control, opts)` — never throws; every failure lands in the run row (`failed` + `error`).

### Two executors, one entry point

`executeRun` creates the worktree (or reuses it on resume), then dispatches: a run with a `workflowRevisionId` goes to the **graph executor** (`executeGraphRun`, `graph-engine.ts` — parallel fan-out + join since #115); everything else (ad-hoc task runs, revision-less legacy workflow rows) runs through the **linear flow/loop executor**. Both share the per-step machinery (StepRun lifecycle, diff capture, event persistence, run finalization) injected from `flow-engine.ts`, so behavior like "diff failures never fail the run" is identical.

### Graph execution semantics (v0.2 — parallel fan-out + join)

Everything below is pinned by `packages/engine/src/graph-engine.test.ts`; test names are quoted so this section and the tests drift together.

**Routing — chain/router stays SERIAL.** Execution starts at `entryNodeId`. A router/chain node follows exactly one outgoing edge per completion: the engine evaluates the node's conditional outgoing edges in `order` (first match wins; `invert` negates the match result) against the node's **final output**; the first matching edge is taken. When none matches, the node's single `always` fallback edge is taken. No outgoing edges at all — or an `exit` node reached — ends that branch; the run finalizes `success` once every branch settles ("runs a chain start to exit…" and "ends successfully at a dead-end node with no outgoing edges (no exit node needed)"). Test citations: "takes the TRUE conditional path when the condition matches", "takes the always fallback when no conditional edge matches (FALSE path)", "honors router order: first matching conditional wins, later ones never evaluate", "flips the taken path when the router order is swapped (reorder changes first-match)", "negates the match result on inverted edges (invert flag)". The chosen edge is recorded as an `edge.taken` event carrying `edgeId`, `source`, `target`, `matchedCondition`, and the source node's execution number.

**Fan-out (#115).** A node whose outgoing edges are ALL `always` starts one parallel branch per edge: every branch target is scheduled (a queued StepRun row + a `node.queued` event carrying the branch `edgeId`), and executions start up to the run's inner concurrency cap (`DEFAULT_INNER_CONCURRENCY = 3`, configurable via `FlowEngineOptions.graphInnerConcurrency`; `MAX_INNER_CONCURRENCY = 25` clamps it). Fan-out emits no `edge.taken` — the branches are reported by their `node.queued`/`node.started`/`node.completed` events carrying the branch `edgeId` — and fan-out edges are never cycle-guarded (`always` edges are unguarded, per the v0.1 rule). Each branch's `{{prevOutput}}` is the fan-out source's output. Branches count against the run-INTERNAL semaphore only, never against `MAX_CONCURRENT_RUNS` (one run with three live branches still occupies exactly one global scheduler slot, so a busy fan-out run cannot starve other runs) — pinned by "inner concurrency cap: fan-out of 5 runs at most 3 node executions at once (default)".

**Join/merge (#115).** A `join` node is the fan-in counterpart: it waits for its incoming edges to be traversed and then "executes" instantly — no driver, no StepRun row — emitting `node.queued`/`node.started`/`node.completed` with `durationMs: 0` and, as its output, the JSON map `{<branchSourceNodeId>: <output>}` of the ARRIVED branches. Downstream nodes render that map via `{{output:<joinId>}}` while the branch outputs stay directly addressable as `{{output:<branchNodeId>}}`; the node after a join receives the map as `{{prevOutput}}`. `config.mode: "all"` (default) triggers when EVERY incoming edge arrived; `"any"` triggers on the FIRST arrival and cancels the losing sibling branches still in flight (their drivers abort, their StepRuns settle `aborted`). A join has at most one outgoing edge and it is `always` — a join synchronizes branches, it never routes. A join re-arms after each trigger, so a guarded parallel loop (a conditional back-edge after the join) fans out and merges once per round ("a guarded parallel loop re-enters the fan-out: join triggers once per round"). The single-trigger-per-round guard keys deliveries on their FEEDING fan-out round — the deepest fan-out ancestor from which every incoming source of the join is reachable — so a late loser (nested fan-outs and inner loops included) can never re-trigger a join that already fired for its round ("nested any-join with an inner loop: the outer join triggers exactly once per round").

**Sub-workflow nodes (#117).** A `subworkflow` node (`config: {workflowId, revision: 'latest' | number}`) composes teams of teams: executing it spawns a CHILD RUN of the referenced workflow and waits for its completion. The node behaves like an agent node for graph-shape rules (it can be the entry, sit on branches, feed joins; its output is addressable downstream as `{{output:<id>}}`), but has no driver or prompt of its own. Save-time validation (`PUT /:id/graph`, `POST /api/workflows`) refuses unresolvable references with a 422: an unknown `workflowId` or a pinned `revision` number that does not exist ("sub-workflow graph validation (#117)"); `'latest'` is re-resolved at every execution so it always validates. At run time the engine creates the child run row (`parentRunId` set, pinned to the resolved revision, same project, own branch/worktree/event log/StepRuns) and executes it **inline within the parent's execution context** — the scheduler is never involved and the child counts as part of its parent's global `MAX_CONCURRENT_RUNS` slot, so a capped daemon can never deadlock against its own children ("completes a parent + child chain with MAX_CONCURRENT_RUNS=1"). The node's output is the child run's final output; `node.completed` carries `childRunId` (the run detail graph view links into the child). Child failure fails the node (v0.2 strict — no continue-on-fail) with child attribution; a parent abort propagates through the child's abort chain (both settle `aborted`). Nesting is capped at `MAX_SUBWORKFLOW_DEPTH = 3` levels of child runs: a spawn one level deeper fails its node with a clear cap error BEFORE creating a row, so self- or mutually-referencing workflow chains terminate ("depth cap: a 4-deep chain stops with a clear nesting error and no runaway runs").

**Failure policy (#115).** A failed node execution fails the run immediately (fail-fast; all in-flight branches cancel before the run row turns `failed`) UNLESS the failing node sits on a parallel branch of a `mode: "any"` join — its nearest join reachable through a fan-out sibling path: there the failure is tolerated while another incoming branch can still arrive, and the run succeeds if a sibling arrives ("mode-any join: a branch failure is tolerated when another branch succeeds"). If every incoming branch of an engaged join fails or routes away, the run fails with join attribution ("mode-any join: when EVERY branch fails the run fails with join attribution"); a serial prefix failure of an `any` join is NOT tolerated (no sibling alternate path — it starves every branch; "a failure in a SERIAL prefix of an any-join is NOT tolerated"). Fail-fast and abort both cancel every in-flight branch ("fail-fast on a mode-all join" and "abort mid-branch cancels every in-flight sibling").

**Iterations & cycle guards.** Each node **execution** counts, per node: a node re-entered by a back-edge runs as execution 1, 2, 3… (join triggers count the same way, one per trigger), and that number is what its StepRun row, its `node.*` events and its `{{iterations}}` template variable carry ("exits on the condition at iteration 3: exactly 3 executions, loop edge taken twice, per-node {{iterations}}"). A conditional edge whose target can reach its source (a back-edge; self-loops included) is guarded by `maxIterations` — **counted as edge TAKES**: the edge may be taken at most `min(maxIterations, 25)` times per run (`MAX_EDGE_ITERATIONS = 25` is a hard cap that clamps any larger configuration; the default is 3, stamped onto cycle edges by schema normalization). When a guarded edge's condition matches but the edge is already at its cap, the engine emits `edge.cap-reached` and follows the source node's `always` fallback — the run continues, typically to `success`; with no fallback edge the run **fails** with a reason naming the edge, the cap and the missing fallback ("takes the always fallback when the per-edge cap is reached (run continues to success)" and "fails the run at the hard cap when there is no fallback edge", which also pins the clamp: configured 100 → cap 25 → 26 executions → failure). `always` edges are never guarded; non-back-edge conditional edges cannot cycle so they need no guard. A defensive bound of 5,000 total node executions per run protects against bugs.

**Node retry policies (#119).** An agent node's `config.retry` (`{maxAttempts: 1..5, backoffMs: 0..60000, retryOn: 'failure' | 'always'}`) lets a flaky agent heal itself: the engine re-executes a failed attempt (`retryOn: 'failure'`) — or any outcome (`'always'`) — up to `maxAttempts` total, waiting `backoffMs * 2^(attempt-1) + jitter(0..backoffMs)` between attempts. Each retried attempt emits an ordered `node.retry` event (`{attempt, nextInMs}`); the settled `node.completed` event and StepRun row carry the final `attempt` count (absent = 1, pre-#119 shape), and an exhausted policy fails the run with `(attempt N/max)` attribution. Retries live **inside one node execution**: no new `node.started`, one StepRun row (its `attempt` field bumps in place), no edge traversal — so **retries never consume edge iteration/cycle caps or the 5,000-execution bound** (only whole executions do). A `continueSession` node keeps its session across attempts; run/branch aborts are never retried and wake the backoff wait early ("abort during the backoff settles the node and run aborted").

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

### Run artifacts (#122)

A workflow graph may declare `artifacts: string[]` — safe, ordered globs (`dist/**`, `reports/**/coverage.*`, `*.log`; leading `!` negates, last match wins, a pattern naming a directory includes its subtree, slash-free patterns match at any depth). Patterns are validated at save time (`packages/core/src/artifacts.ts`: relative POSIX globs, only `*`/`**`/`?` wildcards, no `..`/absolute/brace forms) and snapshotted with the graph revision, so a run's patterns are frozen at creation.

When a run turns **terminal** (success/failed/aborted/interrupted), the flow engine copies every matching regular file out of the run's worktree into the artifact store — `data/artifacts/<runId>/` next to the daemon db, with a `manifest.json` (`runStatus`, `patterns`, `files: [{path, size}]`, `totalBytes`, `truncated` + partial-capture `warning`). Because the copy happens before anyone prunes the worktree, **artifacts survive worktree cleanup** — that is the point — and re-capture (a resumed run finishing again) replaces the set wholesale. Hard caps bound the capture: **200 files / 50 MiB total** per run, deterministic path-order truncation, and the manifest's `warning` records what was left behind. Symlinks are never followed (walk or download), `.git` is skipped, and capture failures only log — they never change a run's outcome. Ad-hoc runs and pre-#122 revisions capture nothing (byte-identical behavior).

Garbage collection rides along with worktree cleanup: `POST /api/system/maintenance {action: prune-worktrees}` and the orphan paths of `POST /api/projects/:id/worktrees/prune` also drop artifact sets whose run row no longer exists; sets of known runs always survive.

The API (daemon `routes/runs.ts`) is terminal-only:

- `GET /api/runs/:id/artifacts` — the manifest (`409 RUN_NOT_TERMINAL` while live, `404 ARTIFACTS_NOT_FOUND` when nothing was captured, `503 ARTIFACTS_UNAVAILABLE` without a store).
- `GET /api/runs/:id/artifacts/:file` — authenticated octet-stream download of one captured file (Content-Disposition attachment). Path-escape protection mirrors the project files API: lexical containment (`resolveWithinRoot` → `403 PATH_ESCAPE`), realpath containment (a symlink inside the store → `403 PATH_ESCAPE`), manifest membership (`404 ARTIFACT_NOT_FOUND` for anything the capture did not record).

The web run-detail page gains an **Artifacts** tab (`components/run/ArtifactsTab.tsx`): list with sizes/totals, truncated banner, authenticated blob download (the daemon token cannot ride a plain link), and a copy-path affordance.

## Daemon internals

### Hardening middleware (#97)

Middleware order in `createApp` (app.ts): **security headers** → CORS → request logger → **rate limit** → **payload cap** → auth (#92) → context → routes. Hardening layers run ahead of auth so brute-force and oversized requests are shed cheaply (they still burn the offender's own bucket).

- **Rate limits** (`rate-limit.ts`): in-memory token buckets keyed `class:ip`. Classes: `mutate` (POST/PUT/PATCH/DELETE on `/api/*`, default 120/min burst 30), `read` (GET/HEAD/OPTIONS on `/api/*`, default 600/min, capacity = per-minute rate), `stream` (the routes in `STREAM_ROUTE_PATTERNS` — both SSE streams, previews, `/metrics`) and `other` (non-`/api`) are exempt. `429 RATE_LIMITED` + `Retry-After` seconds + `X-RateLimit-Remaining` (also sent on allowed requests). IPs come from the node-server socket (`c.env.incoming`); `X-Forwarded-For` only with `TRUST_PROXY=1`. `TokenBucketStore` takes an injected clock (`take(key, config, nowMs)`), bounds memory at 10k keys (Map order doubles as LRU touch order) and sweeps idle buckets on an unref'd 60s interval.
- **Payload cap** (`security.ts`): `/api/*` bodies > `MAX_BODY_BYTES` (default 1 MiB) → `413 PAYLOAD_TOO_LARGE`. Fast path: declared `Content-Length`; fallback for missing lengths buffers the body once via hono's cached body read (`c.req.arrayBuffer()` — later `c.req.json()` in handlers reuses the cache). Stream routes exempt.
- **CORS allowlist**: `parseCorsOrigins` splits `CORS_ORIGIN` on commas (trim/dedupe; `*` → wildcard). Hono's cors middleware does exact matching for both string and array origins — unmatched origins get no ACAO header at all, including preflights.
- **Security headers** (`security.ts`): nosniff / Referrer-Policy `no-referrer` / minimal Permissions-Policy / CSP `frame-ancestors` + optional `X-Frame-Options: DENY` on **every** response (mounted before CORS so preflight 204s carry them; set after `next()` so error and 404 responses are covered too). Framing policy resolution (`resolveFramePolicy`): explicit `FRAME_ANCESTORS` wins (XFO only when the sources are `'none'`); else `PREVIEW_IFRAME=1` allows `'self'` + CORS allowlist (XFO dropped — it can't express lists, M7 previews placeholder); else deny. `/api/*` gets `Cache-Control: no-store` unless the handler set its own (SSE sends `no-cache`).

Tests: `rate-limit.test.ts` (classification, env resolution, bucket refill/LRU/sweep with an injected clock, 429 + headers, stream exemptions, per-IP buckets with/without `TRUST_PROXY`) and `security.test.ts` (413 via declared and measured lengths, graph PUT coverage, CORS multi-origin + foreign-origin no-header, headers on `/health` / `/api` / 404 / 500, cache-control, frame-policy modes).

### Scheduler (two layers, lock order gate → slot)

- **Per-project gate** — only one active run per project (worktrees branch from the same HEAD, so siblings must not race). Later runs for the same project wait FIFO, staying `queued` in the db.
- **Global semaphore** — `p-limit(MAX_CONCURRENT_RUNS)` (default 2, integer ≥ 1, echoed in `/health` as `maxConcurrentRuns`). Runs for _different_ projects execute in parallel up to the cap.
- **Sandbox cap** (#105) — a sandbox-mode run dequeued while the provider sits at `MAX_SANDBOXES` (default 8, integer ≥ 2) live containers stays `queued` and re-enters the scheduler after 30s (delay-requeue; abort/shutdown cancel the retry). Local runs are never blocked.
- A run stays `queued` until it holds both its project's turn and a slot; the engine flips it to `running` only when execution actually starts. Queued rows carry a computed `queuePosition` in list/detail responses (not persisted). `POST /api/runs/:id/abort` drops a queued run directly; aborting a running run frees the slot/turn for the next queued run.
- **Sub-workflow child runs never touch the scheduler** (#117) — a `subworkflow` node executes its child run INLINE within the parent's execution context (recursive engine execution with the child's own worktree/branch/event log). Children are ordinary rows in every other respect (own `projectId`, `parentRunId` link, visible in the runs table), but they never enter `active`, never queue behind the project gate or the global semaphore, and count as part of their parent's slot — a `MAX_CONCURRENT_RUNS=1` daemon runs a parent + child chain without deadlock. The executor disposes child sandboxes together with the parent.

### Sandbox GC (boot sweep + every 10 minutes, #105)

After the boot recovery sweep (before serving), and then every 10 minutes, `runSandboxGc` reconciles `provider.list()` (the docker provider scopes to its `openeuler.sandbox=1` label) with the run rows:

- run **active** (in this executor, or row `queued`/`running`) → keep;
- run **hosted** (`hostedUntil` set, #110) → keep — the hosting TTL sweeper owns that sandbox's destruction, never this pass;
- run **terminal** → destroy once the terminal age crosses the grace — 1h default, 4h for `keepForDebug` sandboxes (the feed's `ops.sandbox-kept` entry extends the grace too);
- **no `run` label or unknown run** → orphan → destroy;
- **orphan cache volumes** — named `openeuler-cache-*` volumes (engine `cacheVolumeName`) whose project no longer exists are pruned (they are never freed by run teardown). Project **delete** removes its cache volumes eagerly (best-effort).

Each pass appends one `ops.gc` feed event with `{destroyed, kept, orphans, cacheVolumesPruned}` (boot sweeps always; periodic passes only when something was collected). The periodic tick also parses `docker system df` against the docker root filesystem: above 85% data usage it records an `ops.gc` **warning** event (no auto action). The interval timer is unref'd and cleared via the shutdown registry; provider failures degrade to zero counts and never throw.

### Boot recovery sweep

Before serving, `sweepInterruptedRuns` marks any run left `queued`/`running` by a **previous** daemon process as `interrupted` (steps too), persists a `run.status` event so SSE replay shows the transition, and prunes git worktree metadata across every referenced repo — orphaned worktree paths are **reported, not deleted** (a later `remove(runId)` can still clean the branch).

### Metrics (`GET /metrics`) & ops events

- Hand-rolled Prometheus text exposition (0.0.4, no client dep), refreshed **on scrape** from cheap sqlite counts + in-memory state — no counters wired into the executor funnel; the db rows the funnel writes are the counter state. Families: `openeuler_runs_total{status}` (all six statuses, zeros included), `openeuler_runs_active` (executor's in-memory active set), `openeuler_queue_depth` (rows sitting in `queued`), `openeuler_event_log_rows`, `openeuler_worktrees_active` (live worktree metadata on disk), `openeuler_uptime_seconds`, `openeuler_info{version}`, and `openeuler_sandboxes_active` (`provider.list()` count; reflects the GC's post-pass reality, #102/#105).
- Auth: `/metrics` sits **outside** `/api` but follows the same mode — open when `OPENEULER_TOKEN` is unset; bearer header or `?token=` (GET only, like SSE) when set.
- Ops events reuse the `activity` table with `ops.*` types (no project/run): `ops.daemon-boot {version}` (written by `main()`), `ops.recovery-sweep {interrupted, orphanedWorktrees}` (written by the sweep), `ops.gc` (sandbox GC counts `{destroyed, kept, orphans, cacheVolumesPruned}` or a `disk-pressure` warning, #105). The feed API passes them through; the web renders them as small gray system lines.

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

### Workflow webhooks (`POST /api/hooks/:id`, #120)

Per-workflow inbound triggers. Management lives on the workflow resource (`POST/GET/PATCH/DELETE /api/workflows/:id/webhook`, one webhook per workflow — unique index); the trigger is a separate mount so it can carry its own auth. Storage: `workflow_webhooks` (id, workflow FK, `secret_enc` AES-256-GCM envelope under the secrets master key, optional `default_task`) and `webhook_deliveries` (ring, newest 50 per webhook kept atomically with each append — plain-text webhook id, no FK, same shape as `activity`).

- **Auth (either/or)**: an HMAC-SHA256 signature — `X-Openeuler-Signature: sha256=<hex>` over `<timestamp>.<nonce>.<raw body>`, with `X-Openeuler-Timestamp` (unix seconds) and `X-Openeuler-Nonce` — or, when `OPENEULER_TOKEN` is set, the normal bearer token. The bearer gate exempts `/api/hooks/*` (`HOOKS_PATH_PREFIX` in `auth.ts`) because the router re-implements it: in open mode the signature is the _only_ accepted credential; anonymous triggers always 401.
- **Verification order** (nothing runs before it fully passes): hook exists (404) → timestamp parse (401 `HOOK_TIMESTAMP_INVALID`) → ±300s window (401 `HOOK_TIMESTAMP_STALE`) → nonce shape → constant-time HMAC compare over timestamp+nonce+body (401 `HOOK_SIGNATURE_INVALID`; both hex digests are sha256-hashed first so `timingSafeEqual` sees equal lengths) → replay cache (409 `HOOK_NONCE_REPLAYED`) → JSON/zod body (422) → run creation via the same `createAndStartWorkflowRun` helper as `POST /api/workflows/:id/runs` (revision pinning + #93 redaction identical). The raw body is read exactly once (`arrayBuffer`) — signatures cover those exact bytes, the parse reuses the buffer.
- **Nonce cache**: in-memory `${webhookId}:${nonce}` → expiry, written _only_ after a valid signature (unauthenticated callers cannot flood it) and expiring exactly when the timestamp can no longer pass the window (+5s margin) — a nonce never needs to outlive its own freshness. The nonce is inside the HMAC, so a captured request cannot swap it for a fresh one inside the window. Swept opportunistically past 10k entries; restart clears it (single-process v0.2 cut).
- **Delivery log**: every attempt that reaches the trigger handler appends a row — `accepted` (with `runId`) or `rejected` (with `errorCode`), plus `statusCode` and `authMode` (`signature`/`token`). The body and signature are deliberately NOT stored (no secret leakage surface). 404s for unknown hook ids log nothing (nowhere to log against); requests refused by earlier global middleware (e.g. 429) likewise never reach the ring.
- **Secrets hygiene**: the plaintext secret exists in exactly two responses — create (201) and rotate (200) — and never in `GET`, logs, or the delivery ring. Rotation (`PATCH {rotateSecret: true}`) mints a fresh 48-hex-char secret; ids are 12-char base64url.
- **Middleware interplay**: the trigger sits under the global `/api` rate limits (mutate class) and the payload cap; `apps/daemon/src/routes/webhooks.test.ts` covers the 429. Deleting a workflow cascades its webhook + delivery ring (after the existing no-runs guard). Web UI: canvas editor header → **webhook** chip opens `WebhookDrawer` (create/rotate with one-time secret + curl snippet, default task, delivery ring).

### Workflow schedules (cron ticker, #121)

Per-workflow cron triggers. Management lives on the workflow resource (`GET/PUT/DELETE /api/workflows/:id/schedule`; `PUT` is a full-config upsert — one schedule row per workflow, unique `workflow_id`, so duplicates are impossible by construction). Storage: `workflow_schedules` (id, workflow FK, `enabled`, `cron`, `task_template`, `timezone`, `last_fired_at` cursor). The body validates through the core `WorkflowScheduleConfigSchema` — strict 5-field cron (field-attributed 422s, no `?`/`L`/`@macros`), non-empty task, `Intl`-checked IANA timezone.

- **Cron engine** (`packages/core/src/cron.ts`, dependency-free): strict parser (`*`, lists, ranges, steps, `JAN`/`MON` names, dow `7`=Sunday, Vixie dom/dow OR rule when both fields are restricted) + next-run computation that matches the schedule timezone's wall clock via cached `Intl.DateTimeFormat` formatters. Wall times inside a DST spring-forward gap simply don't resolve (`wallClockToUtc` → null) and are skipped; an ambiguous fall-back wall time resolves to the first occurrence. The day-level scan is bounded (8 years — enough for Feb-29-only expressions).
- **Ticker** (`apps/daemon/src/scheduler.ts`, started in `index.ts`, 1min interval, unref'd, overlapping ticks skipped, `stop()` registered on shutdown): per enabled schedule it finds the NEWEST scheduled minute in `(cursor, now]` — the cursor is `last_fired_at`, else the schedule's `created_at` (fresh schedules never backfill). No slot due → idle. Slot due → active-run check first (`queued`/`running` of that workflow — an approval-gated run counts as active): a blocking run drops the slot with an `ops.schedule-skipped` activity row (workflow, minute, cron, blocking run id) AND still advances the cursor; otherwise the run is minted via the same `createAndStartWorkflowRun` helper as the run modal and webhooks (latest-revision pinning + #93 task redaction identical) and the cursor advances. One malformed schedule row (only reachable by hand-editing the db) degrades to idle and never breaks the tick.
- **Missed-tick semantics** (deliberate): several slots missed while the daemon was down fire ONCE — for the newest missed slot — on the next tick; older slots are dropped, no catch-up storm. `last_fired_at` is persisted, so a restart resumes exactly where the previous process stopped; `stop()` only clears the timer (runs already handed to the executor are ordinary runs and the boot recovery sweep covers a crash mid-run).
- **Web UI**: canvas editor header → **schedule** chip opens `ScheduleDrawer` — cron + timezone (defaults to the browser's zone) + task template fields, live humanized cron (`humanizeCron` from core), the next 5 runs previewed **client-side** (`nextCronRuns` — same core code the daemon ticks, so the preview can't drift), a pause toggle (PUT with `enabled` inverted), delete with confirm. The workflows list badges `scheduled` / `schedule paused` from the `schedule` summary the workflow list API now carries. Tests: `apps/daemon/src/scheduler.test.ts` (fake-clock firing/skip/coalesce/DST), `routes/schedules.test.ts` (validation + cascade + auth), `packages/core/src/cron.test.ts` (parser/timezone/humanizer), `apps/web/.../ScheduleDrawer.test.tsx` (round-trip).

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

### Settings hub (`GET /api/system/settings` + `POST /api/system/maintenance`)

Read-only daemon facts for the settings page (#95), plus its danger-zone actions. Both auth-gated like every other `/api` route (only `auth-status` is exempt).

- `GET /api/system/settings` → `{version, dbPath, dbBytes, worktreeRoot, worktreeBytes, drivers: [{id}], defaultDriver (first registered), maxConcurrentRuns, authEnabled, uptimeSeconds}`. `worktreeBytes` comes from `du -sb` over the store, cached 60s (`?refresh=1` bypasses); `du` missing/failing reports `null`, never 500s.
- `POST /api/system/maintenance {action}` — idempotent, count-based results, typed errors only (`422` bad action/days, `503` missing db/worktree manager, `500 MAINTENANCE_FAILED` wrapping underlying failures):
  - `prune-worktrees` → `{removed, remaining}`: runs `WorktreeManager.pruneAll` (git-side prune + orphan report), then deletes the reported orphan directories — store-root-confined (`relative()` check). Orphan metadata files are kept so a later `remove(runId)` can still drop the branch.
  - `purge-events {days?}` (default 30) → `{deleted, dbBytes}`: deletes events of **terminal** runs whose `updated_at` is older than the cutoff (non-terminal and fresh runs untouched), then `wal_checkpoint(TRUNCATE)` so the space is actually returned.
  - `vacuum` → `{dbBytes}`: rebuilds the SQLite file in place.

The web renders these as the settings hub cards (System / Drivers / Concurrency / Storage with shared-scale usage bars, Danger zone); destructive actions confirm in a dialog — type-to-confirm (`purge`) plus a days input only for the purge — and report counts as toasts before refetching.

### Sandbox image management (`/api/sandbox/*`, #100)

What sandboxes run on, from the settings page's Sandbox section. The daemon composes a `DockerSandboxProvider` at boot and registers it on the sandbox package's default registry; image operations go through the same argv-only `docker` CLI wrapper (no shell, injectable runners for tests).

- `GET /api/sandbox/images` → `{images: [{repository, tag, id, sizeBytes, createdAt, ours}]}` — the catalog is NOT every local image: only repositories under the `openeuler/` namespace (`ours: true`, the ownership marker — docker cannot label images) plus a curated common-base list (`node:22-alpine`, `python:3.12-slim`, `golang:1.23`, `alpine:3.20`, `busybox:musl`, `denoland/deno:2`, `ours: false`). Sizes/creation times are enriched by one batched `docker image inspect` (exact bytes + RFC3339), falling back to parsing the `docker images` rows (decimal size strings, offset-timestamps) when an image vanishes mid-listing.
- `POST /api/sandbox/images/pull {ref}` → `202 {jobId}` — async; refs are grammar-validated first (`422`, same conservative rules as sandbox specs: no flags/whitespace/uppercase/host-port registries) then passed verbatim to `docker pull`. One completion event `ops.image-pull {ref, done, error?}` lands in the activity feed — no per-line progress events. Concurrent pulls of the same ref dedupe onto one job.
- `POST /api/sandbox/images/build {name, dockerfileText?, baseRef?}` → `202 {jobId, tag}` — builds `openeuler/<name>:latest` (`name` must match `^[a-z0-9._-]+$`) by piping the Dockerfile to `docker build -` with an **empty context** (v0.2 constraint: `COPY`/`ADD` have no files and fail). An empty `dockerfileText` + `baseRef` synthesizes `FROM <baseRef>`. Completion emits `ops.image-build {ref, name, done, error?}`.
- `DELETE /api/sandbox/images/:ref` (percent-encoded) → `{deleted}` — checks the provider's sandboxes first (`409 IMAGE_IN_USE` with `details.sandboxes` when one runs the image; refs normalize `:latest` before comparing), then `docker image inspect` (`404 IMAGE_NOT_FOUND`) and `docker rmi` (docker-side conflicts also map to `409`).
- `GET /api/sandbox/jobs/:id` → `{id, kind, ref, status: running|done|failed, error?, createdAt, finishedAt}` — in-memory job registry; jobs are lost on daemon restart (a vanished job is a 404, the image operation itself already completed or never started).

The web client (`lib/sandbox-api.ts`) wraps these with `waitForSandboxJob` (1s poll loop); the Sandbox settings card renders the catalog table (repo:tag, size, age, ours/base badge), inline progress rows per running job, confirm-dialog deletes that surface 409s as danger toasts, and the pull/build forms (client-side name rule mirrored from the daemon).

### Docker availability + local fallback (`GET /api/sandbox/status`, #106)

Docker missing must not brick the product. A daemon-side service (`sandbox-status.ts`) resolves availability with the sandbox package's cached `dockerAvailable()` probe (one `docker info`, 30s internal cache) plus `docker --version` (answers without a daemon; a missing CLI just omits `version`), caches the combined payload for **60s**, and warms once at boot (fire-and-forget — a boot never blocks or fails on docker). `?refresh=1` bypasses the cache and forces the probe.

- `GET /api/sandbox/status` → `{available, version?, mode: "docker"|"unavailable", checkedAt}`.
- `GET /api/sandbox/status?projectId=<id>` adds `{projectMode, effective}` — the project's policy `executionMode` (`"local"` when no policy was saved) and the **same** `resolveExecutionMode` the executor applies at run time, so hints never disagree with actual placement. Unknown projects answer `404 PROJECT_NOT_FOUND`.

The tradeoff: `executionMode: "auto"` trades isolation for availability — with docker down, auto runs execute **locally on the daemon host** (no sandboxing) instead of failing; explicit `"sandbox"` still fails fast with the typed `SANDBOX_UNAVAILABLE` error. The web makes the fallback visible instead of silent: a **Docker pill** next to the daemon health pill (60s poll; "Docker ready" / "Docker unavailable", muted while checking/unknown), a subtle **"Running locally — Docker unavailable"** banner on the run detail (only when the run has no live sandbox info, the policy is auto/sandbox, and docker is currently down — decision unit-tested in `lib/sandbox-api.ts`), and a live **effective-mode hint** under the execution-mode select in the project settings drawer (follows unsaved form state) and in the run-workflow modal (reflects the saved policy before launch).

### Sandboxes dashboard (`/api/sandbox/instances`, #112)

The dashboard's active-containers view: every provider sandbox (`provider.list()`, newest first) with run joins and live usage, plus stop/destroy actions behind confirms.

- `GET /api/sandbox/instances` → `{instances: [{id, runId, image, status: running|exited|stopped, startedAt, usage?, run?}], checkedAt}` — `runId` comes from the sandbox's `run` label (`null` for unlabeled sandboxes); `run` joins the labeled run row when it still exists (`{id, status, project: {id, name}, hosted?}` — hosted runs from #110 included); `usage` is one `provider.stats()` snapshot when the provider supports it (`{cpuPercent, memMb, memLimitMb}` — a stats hiccup omits the field, never fails the listing; `memLimitMb` is the project policy's memory cap, engine default fallback, as the soft reference for usage bars).
- `POST /api/sandbox/instances/:id/stop` → `{stopped}` — graceful `docker stop` by `list()` id (new optional `SandboxProvider.stop(id)`; the fake and docker providers implement it, idempotent like destroy-by-id). The sandbox is KEPT: still listed (as `exited` — by-id stop cannot set the handle-level `stopped` marker) and inspectable. `404 SANDBOX_NOT_FOUND` for ids the provider does not list, `501 SANDBOX_STOP_UNSUPPORTED` for providers without stop-by-id.
- `DELETE /api/sandbox/instances/:id` → `{deleted}` — typed destroy by id (#105's `provider.destroy`), idempotent; same 404/501 semantics.

The web (`components/dashboard/SandboxesSection.tsx`) renders this between the project cards and the runs table: a card grid (image chip, status badge, run link, relative start age, live cpu/mem usage bars) with arm-confirm Stop/Destroy actions that update optimistically and surface failures as toasts; the header shows the running/total count next to the Docker pill. Polling lives in `lib/sandbox-instances.ts` (`startSandboxInstancesPolling`): 5s while the page is visible, paused on `visibilitychange` hidden, immediate refresh on return, full cleanup on unmount — docker-gated integration tests cover the real-provider path. The sidebar adds a cheap `SandboxCountChip` ("Sandboxes: N active", 30s poll, hidden at zero) linking to the dashboard's `#sandboxes` anchor.

### Port declaration + detection (#107)

To preview agent-built servers the daemon must know their ports. Two sources, one run-row view:

- **Declaration** — run creation accepts `ports: number[]` (`POST /api/runs` and `POST /api/workflows/:id/runs` alike): unique integers 1..65535, at most 3 (`RunPortsSchema` in core, shared by both bodies and the stored row; workflow-level defaults are deliberately absent — run-level only). Declared ports persist on the run row (`runs.ports`, JSON int[]) and are carried over by retry. When the run executes sandboxed, `buildRunSandboxSpec` puts them in `SandboxSpec.ports`, so the container publishes them (`-p 127.0.0.1::port`) for its lifetime — `handle.hostPorts()` maps container→ephemeral host.
- **Detection** — the pure `detectPorts(text)` lib (`packages/engine/src/port-detect.ts`) scans each completed node/step's **final output** for real dev-server lines (Next `ready on http://localhost:3000`, Vite `Local: http://localhost:5173/`, Flask/Uvicorn `Running on http://127.0.0.1:5000`, Puma `Listening on tcp://0.0.0.0:3000`, `Serving HTTP on 0.0.0.0 port 8000`, `PORT=3000`, bare `:3000` after serving/running/started). Guards: ports 0/80/443 never count; the generic `port NNNN` phrase needs 3-5 digits; dates/timestamps/paths/exit codes match nothing. Runs **on sandboxed runs only** (local runs have no preview surface); the executor-side flow engine merges findings into `runs.detectedPorts` (dedup, cap 3) after every successful step/node completion.

`GET /api/runs/:id` renders the merged view as `ports: [{container, host?, declared, hint?}]` — declared ports first (declaration order), then detected extras, capped at 3. `host` is present only while the run's sandbox is alive and published the port (the live mapping comes from the executor's `sandboxInfo`, which reads `hostPorts()`); after terminal the same list renders host-less.

> **Documented v0.2 cut:** only **declared** ports are published. A port found by detection but not declared is recorded on the row and rendered with `hint: "detected in run output; declare ports on the run to preview it…"` — the sandbox cannot publish it retroactively (recreating the container mid-run to add a `-p` mapping was judged too heavy for v0.2). Detection of undeclared ports therefore reports the number and tells the user to declare it on the next run. Pinned by the docker-gated e2e (`executor.sandbox.integration.test.ts`, #107 tests: declared → mapped + HTTP-reachable + recorded; undeclared → detected, `docker port` empty).

### Preview proxy (`/previews/:runId/…`, #108)

Declared ports get a live reverse proxy while the sandbox runs. `preview-proxy.ts` holds the framework-free pieces (path parsing, port resolution, hop-by-hop filtering, the streaming `fetch`); `routes/previews.ts` is the hono wiring mounted at **both** `/previews` and `/api/previews` (method passthrough: GET/HEAD/POST/PUT/PATCH/DELETE).

- **Port resolution** (path form wins): `/previews/:runId/:port/*` → `?port=` → the run's first declared port. The path form is canonical because naive relative links (`/app.js`) drop query params — with `?port=` the iframe must re-append it to every subresource. A non-numeric first path segment is treated as the subpath of the DEFAULT port, so default-port apps work with plain relative links. `?token=`/`?port=` are consumed by the proxy and never forwarded.
- **Resolution matrix**: unknown run → `404 RUN_NOT_FOUND`; no live sandbox → `410 PREVIEW_GONE` (terminal vs local message); bad port → `422 INVALID_PORT`; undeclared port or declared-nothing-but-detected → `403 PREVIEW_PORT_NOT_DECLARED` (body carries the declare-to-preview hint, `details.detected`/`details.containerPort`); declared + live sandbox but mapping gone (stopping/exited) → `502 PREVIEW_UPSTREAM_UNAVAILABLE`. Resolution is the pure `resolvePreviewTarget(run, sandboxInfo, explicitPort)`.
- **Streaming**: one `fetch` per request to `http://127.0.0.1:<hostPort><encoded path>` — request body forwarded as a stream (`duplex: "half"`), response status/headers/body passed through with **no content-length recompute**; multi-value `set-cookie` survives via `getSetCookie()`. Hop-by-hop headers (connection, keep-alive, te, trailer, transfer-encoding, upgrade, proxy-*; plus anything `Connection:` names; `host` on requests) are stripped both ways. `redirect: "manual"`: app redirects pass through for the iframe to follow (link rewriting is OFF — absolute-path redirects like `/dashboard` escape `/previews/:runId`; document the caveat, fix in v0.3 if ever).
- **Timeouts**: 10s connect/headers window (an AbortController that fires unless headers arrive) composed with `AbortSignal.timeout(120s)` as the pragmatic overall cap (the ideal 60s idle-between-chunks needs undici dispatcher knobs the global fetch does not expose). Failures — connection refused (published port with no listener), timeout, mid-flight abort — synthesize `502` with `details {runId, containerPort, hostPort, reason, hint}` pointing at `GET /api/runs/:id` and the sandbox log.
- **Smuggling**: the proxy never decodes the subpath — it is re-attached percent-encoded to the upstream request line (`parsePreviewPath` + `forwardableSearch` keep raw bytes; `?a=%20x` is forwarded byte-identical). Pinned by tests: `%0d%0a` reaches the target still encoded, no raw CR/LF anywhere.
- **Auth/exemptions**: `/api/previews` sits behind the global `/api/*` gate; the bare `/previews` mount gets the same middleware in `app.ts`. `?token=` is GET-scoped (the iframe load); POST/PUT/… need `Authorization: Bearer`. Preview paths are stream routes (#97): exempt from rate limits and payload caps — proxied bodies are bounded by the sandbox, not the daemon.
- **Frame headers**: nothing preview-specific — the global security middleware already handles `PREVIEW_IFRAME=1` (`frame-ancestors 'self' <CORS allowlist>`, no `X-Frame-Options`), which overrides the target app's own CSP on proxied responses (a v0.2-accepted consequence; without the flag previews are DENY-framed and only useful via direct navigation).
- **Cuts**: WebSocket upgrades (v0.2 is plain HTTP; the browser console will show a failed `wss://` — noted as best-effort), link rewriting, per-run resolution caching (each proxied request does a live `sandboxInfo()`; cheap at iframe rates). Pinned by `routes/previews.test.ts` (matrix + stripping + smuggling + auth + load + timeouts, local echo target) and the docker-gated `routes/previews.integration.test.ts` (busybox `httpd` + CGI echo round-trip through the real published port, 404 passthrough, published-but-not-listening 502, stopped-container 502, post-terminal 410).

### Hosted runs (#110)

Server-type workflows get a keep-alive option: a successful run's sandbox stays up (previews live) on a TTL instead of dying with the run.

- **Option** — run creation (`POST /api/runs` and `POST /api/workflows/:id/runs` alike) accepts `hosting: {enabled: boolean, keepAliveMinutes?: int 5..1440}` (default 60; `RunHostingOptionsSchema` in core, 422 outside the window). Persisted on the row (`runs.hosting` JSON); retry carries the request over.
- **Hosting starts** — at the executor's sandbox dispose: a run that turns **`success`** with `hosting.enabled` AND sandboxed execution AND declared ports keeps its sandbox (the log tailer gets its final flush; the entry stays in the executor's sandbox map so `sandboxInfo()` — and therefore the preview proxy and the detail's port views — keeps resolving), and `hostedUntil = now + keepAliveMinutes` lands on the row. The run status stays `success` — hosted-ness is the extra `hosting` view, not a status. **Aborted and failed runs NEVER host** (hosting applies to success only); hosting without declared ports, or on a local run, is silently ignored (nothing to preview). `keepForDebug` and hosting are mutually exclusive by construction (hosting wins when both apply).
- **TTL sweeper** (`hosting.ts`, 1-minute interval, unref'd, overlap-guarded): every run whose `hostedUntil` passed gets its sandbox destroyed (executor handle first; provider-label destroy as the fallback for hosting that outlived a daemon restart), `hostedUntil` cleared (run stays `success`), and one `ops.hosting-expired {runId, until}` feed event recorded.
- **API** — `GET /api/runs/:id` adds `hosting: {until, ports: [{container, host}], extendable} | null` (live host mappings while the sandbox is alive; `ports` is empty when this daemon holds no handle, e.g. after a restart). `POST /api/runs/:id/hosting/stop` destroys now (409 `RUN_NOT_HOSTED` when not hosted); `POST /api/runs/:id/hosting/extend {minutes: int 1..1440}` bumps `hostedUntil += minutes`, capped 24h from "now" and never shrinking (409 when not hosted, 422 on bad minutes). Both sit behind the usual `/api/*` auth.
- **Restart semantics** — hosted sandboxes survive a daemon stop by design (shutdown leaves them running). At boot, `reattachHostedRuns` checks each hosted run's container by label: alive → hosting continues with a FRESH window (`hostedUntil = now + keepAliveMinutes` — the simple restart rule), dead → `hostedUntil` cleared (run stays `success`). Live port mappings degrade until expiry in the reattached case (the new process holds no handle); the TTL sweeper and Stop hosting (label destroy) keep working. A run that was merely **interrupted** by the restart re-hosts the normal way: resume → success → the dispose path arms hosting again.
- **GC** — hosted sandboxes are exempt from the sandbox GC's terminal grace while `hostedUntil` is set (see above); once hosting ends, the normal grace applies.
- **Web** — the run detail shows a hosted banner ("Hosted — preview live · expires in Xm", ticking) with **+30m** (quick extend) and **Stop hosting** (inline confirm); the preview tab stays fully functional while hosted (its terminal-run teardown note is replaced by the banner), and the runs tables badge hosted rows with a small `hosted` chip.
- Pinned by `hosting.test.ts` (fake provider + fake clock: host-on-success matrix, stop/extend, expiry + ops event, label fallback, reattach, sweeper tick), `routes/runs.hosting.test.ts` (API shapes + 409/422s, both creation APIs, retry carry-over) and the docker-gated `hosting.e2e.test.ts` (busybox `httpd` served through the preview proxy AFTER success; extend; stop → 410 + 409; forced-past TTL sweep destroys + records the ops event).

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
