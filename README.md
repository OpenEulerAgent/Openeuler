# Openeuler — Agent Loop Manager

A local-first web app for defining and running **workflows (flows & loops) of coding agents** in the background.

- **Open a project** like VSCode/Zed: point it at a local git repo
- **Define workflows**: an ordered list of fully user-defined agent steps (e.g. opencode in auto-approve mode), with optional loop-back edges and exit conditions (`flow` or `loop`)
- **Run in background**: each run executes in an isolated git worktree on its own branch; multiple runs concurrently
- **Watch live**: streaming agent events, per-step diffs, iteration counts, stop/retry

**Status: planning.** See the [issue board](https://github.com/OpenEulerAgent/Openeuler/issues) for the build plan — each issue specifies implementation approach, branch (`feat/<name>`), blockers, and verification.

## Concurrency & queueing

Runs execute in the background under two scheduling layers (daemon `executor`):

- **Global semaphore** — at most `MAX_CONCURRENT_RUNS` runs execute at once (default `2`; any integer ≥ 1, read once at boot and surfaced in `/health` as `maxConcurrentRuns`). Runs awaiting a slot stay `queued` in the db; the engine flips them to `running` only when the slot is acquired and execution starts.
- **Per-project serialization** — only one active run per project at a time: worktrees branch from the same repo HEAD, so a second run for the same project waits (`queued`) until the current one is terminal. Runs for _different_ projects execute in parallel up to the global cap. (A project-level toggle for this may arrive later.)

API surface:

- `GET /api/runs` and `GET /api/runs/:id` attach a computed `queuePosition` field to queued runs — the number of queued runs created before it (global `(createdAt, id)` order; `0` = next to start). The field disappears once the run starts; it is not part of the persisted Run schema.
- `GET /api/runs/stats` → `{ "queued": n, "running": n }` for dashboards.
- `POST /api/runs/:id/abort` on a queued (not yet started) run aborts it directly and drops it from the queue; aborting a running run frees the slot/project turn for the next queued run.

## Stack

TypeScript monorepo (pnpm): Next.js web app + background daemon (Hono), Drizzle/SQLite, a workflow engine, and a pluggable agent-driver layer (opencode first).
