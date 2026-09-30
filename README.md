# Openeuler — Agent Loop Manager

A local-first web app for defining and running **workflows (flows & loops) of coding agents** in the background.

- **Open a project** like VSCode/Zed: point it at a local git repo
- **Define workflows**: an ordered list of fully user-defined agent steps (e.g. opencode in auto-approve mode), with optional loop-back edges and exit conditions (`flow` or `loop`)
- **Run in background**: each run executes in an isolated git worktree on its own branch; multiple runs concurrently
- **Watch live**: streaming agent events, per-step diffs, iteration counts, stop/retry

**Status: planning.** See the [issue board](https://github.com/OpenEulerAgent/Openeuler/issues) for the build plan — each issue specifies implementation approach, branch (`feat/<name>`), blockers, and verification.

## Stack

TypeScript monorepo (pnpm): Next.js web app + background daemon (Hono), Drizzle/SQLite, a workflow engine, and a pluggable agent-driver layer (opencode first).
