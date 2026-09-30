"use client";

import nextDynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { StepRun } from "@openeuler/core";
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
  loading: () => <p className="px-4 py-3 text-xs text-slate-400">Loading diff viewer…</p>,
});

const sectionId = (index: number): string => `diff-file-${index}`;

/**
 * Diffs tab of the run detail page (issue #20): scope switch (cumulative vs
 * per-step with iteration), a file sidebar parsed from the patch (+/- counts,
 * click to jump), side-by-side syntax-highlighted rendering, and a
 * truncation banner for server-capped huge diffs.
 */
export function DiffsTab({ runId, steps }: { runId: string; steps: readonly StepRun[] }) {
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
        <label className="text-xs font-medium text-slate-500" htmlFor="diff-scope">
          Scope
        </label>
        <select
          id="diff-scope"
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
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
        </select>
        <button
          type="button"
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
          onClick={() => setSplit((prev) => !prev)}
        >
          {split ? "Side-by-side" : "Unified"}
        </button>
        {state.phase === "ready" ? (
          <span className="text-xs text-slate-400">
            {entries.length} file{entries.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {state.phase === "loading" ? (
        <p className="py-6 text-sm text-slate-400">Loading diff…</p>
      ) : null}

      {state.phase === "error" ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>{state.message}</p>
          <button
            type="button"
            className="mt-2 text-xs font-medium underline"
            onClick={() => setScope({ ...scope })}
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.phase === "gone" ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p>
            The run&apos;s worktree no longer exists, so the cumulative diff cannot be computed.
            Per-step diffs remain available — pick a step from the scope switch above.
          </p>
        </div>
      ) : null}

      {state.phase === "ready" ? (
        state.diff.patch.length === 0 ? (
          <p className="py-6 text-sm text-slate-400">
            No changes recorded for this scope
            {state.diff.scope === "step" ? " (step made no file changes)" : ""}.
          </p>
        ) : (
          <>
            {state.diff.truncated ? (
              <div
                className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800"
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
                className="w-full shrink-0 rounded-lg border border-slate-200 bg-slate-50 p-2 lg:max-h-[40rem] lg:w-72 lg:overflow-y-auto"
              >
                <ul className="flex flex-col gap-0.5">
                  {entries.map((entry, index) => (
                    <li key={entry.key}>
                      <button
                        type="button"
                        onClick={() => jumpTo(index)}
                        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left font-mono text-xs text-slate-700 hover:bg-slate-200"
                        title={entry.path}
                      >
                        <span className="truncate">{entry.path}</span>
                        <span className="shrink-0 tabular-nums">
                          <span className="text-emerald-600">+{entry.additions}</span>{" "}
                          <span className="text-red-500">−{entry.deletions}</span>
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
                    className="scroll-mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white"
                  >
                    <header className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
                      <span className="truncate font-mono text-xs font-semibold text-slate-800">
                        {entry.isNew ? "A " : entry.isDeleted ? "D " : entry.isRename ? "R " : "M "}
                        {entry.path}
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums">
                        <span className="text-emerald-600">+{entry.additions}</span>{" "}
                        <span className="text-red-500">−{entry.deletions}</span>
                      </span>
                    </header>
                    <DiffFileView entry={entry} split={split} useDarkTheme={false} />
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
