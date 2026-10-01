"use client";

import nextDynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { StepRun } from "@openeuler/core";
import { useThemeContext } from "@/components/ThemeProvider";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { parsePatch } from "@/lib/diff-parse";
import {
  diffLoadReducer,
  fetchRunDiff,
  stepScopeOptions,
  type DiffLoadState,
  type DiffScope,
} from "@/lib/diffs";

/**
 * The diff viewer (+ refractor grammars) is heavy; load it only when this
 * tab actually renders something, off the server-rendered bundle.
 */
const DiffFileView = nextDynamic(() => import("./DiffFileView"), {
  ssr: false,
  loading: () => <p className="px-4 py-3 text-xs text-muted-fg">Loading diff viewer…</p>,
});

const sectionId = (index: number): string => `diff-file-${index}`;

/**
 * Diffs tab of the run detail page (issue #20): scope switch (cumulative vs
 * per-step with iteration), a file sidebar parsed from the patch (+/- counts,
 * click to jump), side-by-side syntax-highlighted rendering, and a
 * truncation banner for server-capped huge diffs.
 */
export function DiffsTab({ runId, steps }: { runId: string; steps: readonly StepRun[] }) {
  const { theme } = useThemeContext();
  const [scope, setScope] = useState<DiffScope>({ kind: "cumulative" });
  const [state, dispatch] = useReducer(diffLoadReducer, { phase: "idle" } as DiffLoadState);
  const [split, setSplit] = useState(true);

  const stepOptions = useMemo(() => stepScopeOptions(steps), [steps]);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: "select", scope });
    void fetchRunDiff(runId, scope)
      .then((diff) => {
        if (!cancelled) dispatch({ type: "loaded", scope, diff });
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err !== null && typeof err === "object" && err.status === 410) {
          dispatch({ type: "gone", scope });
          return;
        }
        dispatch({
          type: "failed",
          scope,
          status: typeof err?.status === "number" ? err.status : 0,
          message: err?.message ?? "Failed to load diff",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [runId, scope]);

  const jumpTo = useCallback((index: number) => {
    document.getElementById(sectionId(index))?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, []);

  const entries = useMemo(
    () => (state.phase === "ready" ? parsePatch(state.diff.patch) : []),
    [state],
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Scope switch + view mode */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-muted-fg" htmlFor="diff-scope">
          Scope
        </label>
        <Select
          id="diff-scope"
          className="py-1 text-xs"
          value={scope.kind === "cumulative" ? "cumulative" : scope.stepRunId}
          onChange={(event) => {
            const value = event.target.value;
            setScope(
              value === "cumulative" ? { kind: "cumulative" } : { kind: "step", stepRunId: value },
            );
          }}
        >
          <option value="cumulative">Cumulative (whole run)</option>
          {stepOptions.map((option) => (
            <option key={option.stepRunId} value={option.stepRunId}>
              {option.label}
              {option.hasDiff ? "" : " (no diff)"}
            </option>
          ))}
        </Select>
        <Button variant="secondary" size="sm" onClick={() => setSplit((prev) => !prev)}>
          {split ? "Side-by-side" : "Unified"}
        </Button>
        {state.phase === "ready" ? (
          <span className="text-xs text-muted-fg">
            {entries.length} file{entries.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {state.phase === "loading" ? (
        <p className="py-6 text-sm text-muted-fg">Loading diff…</p>
      ) : null}

      {state.phase === "error" ? (
        <div className="rounded-lg border border-danger/40 bg-danger-subtle p-4 text-sm text-danger">
          <p>{state.message}</p>
          <button
            type="button"
            className="mt-2 rounded-sm text-xs font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => setScope({ ...scope })}
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.phase === "gone" ? (
        <div className="rounded-lg border border-warning/40 bg-warning-subtle p-4 text-sm text-warning">
          <p>
            The run&apos;s worktree no longer exists, so the cumulative diff cannot be computed.
            Per-step diffs remain available — pick a step from the scope switch above.
          </p>
        </div>
      ) : null}

      {state.phase === "ready" ? (
        state.diff.patch.length === 0 ? (
          <p className="py-6 text-sm text-muted-fg">
            No changes recorded for this scope
            {state.diff.scope === "step" ? " (step made no file changes)" : ""}.
          </p>
        ) : (
          <>
            {state.diff.truncated ? (
              <div
                className="rounded-lg border border-warning/40 bg-warning-subtle px-4 py-2 text-xs text-warning"
                data-testid="diff-truncated-banner"
              >
                Showing the first {state.diff.maxLines.toLocaleString()} of{" "}
                {state.diff.totalLines.toLocaleString()} patch lines — the rest was capped
                server-side to keep the page responsive. The file list below covers the capped
                portion only.
              </div>
            ) : null}
            <div className="flex flex-col gap-4 lg:flex-row">
              {/* File sidebar */}
              <nav
                aria-label="Changed files"
                className="w-full shrink-0 rounded-lg border border-border bg-elevated p-2 lg:max-h-[40rem] lg:w-72 lg:overflow-y-auto"
              >
                <ul className="flex flex-col gap-0.5">
                  {entries.map((entry, index) => (
                    <li key={entry.key}>
                      <button
                        type="button"
                        onClick={() => jumpTo(index)}
                        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left font-mono text-xs text-fg transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        title={entry.path}
                      >
                        <span className="truncate">{entry.path}</span>
                        <span className="shrink-0 tabular-nums">
                          <span className="text-success">+{entry.additions}</span>{" "}
                          <span className="text-danger">−{entry.deletions}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
              {/* File sections */}
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                {entries.map((entry, index) => (
                  <section
                    key={entry.key}
                    id={sectionId(index)}
                    className="scroll-mt-4 overflow-hidden rounded-lg border border-border bg-surface"
                  >
                    <header className="flex items-center justify-between gap-2 border-b border-border bg-elevated px-4 py-2">
                      <span className="truncate font-mono text-xs font-semibold text-fg">
                        {entry.isNew ? "A " : entry.isDeleted ? "D " : entry.isRename ? "R " : "M "}
                        {entry.path}
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums">
                        <span className="text-success">+{entry.additions}</span>{" "}
                        <span className="text-danger">−{entry.deletions}</span>
                      </span>
                    </header>
                    <DiffFileView entry={entry} split={split} useDarkTheme={theme === "dark"} />
                  </section>
                ))}
              </div>
            </div>
          </>
        )
      ) : null}
    </div>
  );
}
