"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Project, Run, StepRun, TerminalRunStatus } from "@openeuler/core";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { apiFetch, ApiError } from "@/lib/api";
import { connectRunEvents, type RunStreamEvent, type RunStreamState } from "@/lib/run-events";
import {
  appendFeedEvent,
  isLiveRun,
  isTerminalRunStatus,
  terminalEndMs,
  type FeedEntry,
} from "@/lib/run-feed";
import { DiffPanel } from "./DiffPanel";
import { EventFeed } from "./EventFeed";
import { InterruptedRunBanner } from "./InterruptedRunBanner";
import { OutputPanel } from "./OutputPanel";
import { RunHeader } from "./RunHeader";

interface RunDetail {
  run: Run;
  steps: StepRun[];
  summary: { eventCount: number };
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; detail: RunDetail; project: Project | null }
  | { phase: "notfound" }
  | { phase: "error"; message: string };

/** Fetch the run detail (and its project); every failure collapses to a LoadState. */
async function fetchRunDetail(runId: string): Promise<LoadState> {
  try {
    const detail = await apiFetch<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
    let project: Project | null = null;
    try {
      project = (
        await apiFetch<{ project: Project }>(
          `/api/projects/${encodeURIComponent(detail.run.projectId)}`,
        )
      ).project;
    } catch {
      // Project name is cosmetic; a missing project must not break the page.
    }
    return { phase: "ready", detail, project };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return { phase: "notfound" };
    return {
      phase: "error",
      message: cause instanceof ApiError ? cause.message : "Failed to load run",
    };
  }
}

/**
 * The run detail surface: header (project/branch/status/elapsed/stop), the
 * live SSE event feed (with full replay for completed runs), final output and
 * diff panels. All daemon traffic and the SSE lifecycle live here so the feed
 * components stay purely presentational.
 */
export function RunDetailView({ runId }: { runId: string }) {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [streamState, setStreamState] = useState<RunStreamState>("connecting");
  const [terminalStatus, setTerminalStatus] = useState<TerminalRunStatus | null>(null);
  const [endedMs, setEndedMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const runRef = useRef<Run | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoad(await fetchRunDetail(runId));
  }, [runId]);

  // Load on mount / run switch; reset per-run feed state so client-side
  // navigation between runs never shows the previous run's events.
  useEffect(() => {
    setLoad({ phase: "loading" });
    setEntries([]);
    setTerminalStatus(null);
    setEndedMs(null);
    setStreamState("connecting");
    void refresh();
  }, [refresh]);

  // Live stream: connects for every run — for terminal runs the daemon
  // replays persisted events through the terminal run.status and closes.
  const streamRunId = load.phase === "ready" ? load.detail.run.id : null;
  const streamHandleRef = useRef<ReturnType<typeof connectRunEvents> | null>(null);
  useEffect(() => {
    if (!streamRunId) return;
    const handle = connectRunEvents({
      runId: streamRunId,
      onEvent: (event: RunStreamEvent) => {
        setEntries((prev) => appendFeedEvent(prev, event));
        if (event.type === "run.status" && isTerminalRunStatus(event.status)) {
          setTerminalStatus(event.status);
          // A run row that is already terminal carries the authoritative end
          // time; Date.now() only approximates a live→terminal transition
          // observed before the row was refetched.
          setEndedMs(terminalEndMs(runRef.current, Date.now()));
        }
      },
      onStateChange: setStreamState,
    });
    streamHandleRef.current = handle;
    return () => {
      streamHandleRef.current = null;
      handle.close();
    };
  }, [streamRunId]);

  const run = load.phase === "ready" ? load.detail.run : null;
  runRef.current = run;
  const effectiveStatus = terminalStatus ?? run?.status;
  const live = effectiveStatus === undefined ? false : isLiveRun(effectiveStatus);

  // Elapsed time keeps ticking while the run is live.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  // Terminal event landed: pull the final run row (output, diff, status).
  useEffect(() => {
    if (terminalStatus === null) return;
    void refresh();
  }, [terminalStatus, refresh]);

  if (load.phase === "loading") {
    return (
      <Card title="Loading run…" description={`Fetching run ${runId} from the daemon.`}>
        <p className="py-6 text-sm text-slate-400">This should only take a moment.</p>
      </Card>
    );
  }

  if (load.phase === "notfound") {
    return (
      <Card title="Run not found" description="The daemon has no record of this run.">
        <div className="flex flex-col items-start gap-3 py-4 text-sm text-slate-500">
          <p>
            Run <span className="font-mono text-slate-700">{runId}</span> does not exist — it may
            have been removed, or the link is stale.
          </p>
          <Button variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      </Card>
    );
  }

  if (load.phase === "error") {
    return (
      <Card title="Could not load run" description="The daemon did not answer as expected.">
        <div className="flex flex-col items-start gap-3 py-4 text-sm text-slate-500">
          <p className="text-red-600">{load.message}</p>
          <Button variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  const { detail, project } = load;
  const steps = detail.steps;
  const lastOutput = steps.length > 0 ? (steps[steps.length - 1]?.output ?? "") : "";
  const output = lastOutput.length > 0 ? lastOutput : (detail.run.output ?? "");
  const diff = steps
    .map((step) => step.diff ?? "")
    .filter((part) => part.length > 0)
    .join("\n\n");
  const showPanels = effectiveStatus !== undefined && !live;
  const shownRun: Run =
    terminalStatus !== null ? { ...detail.run, status: terminalStatus } : detail.run;

  return (
    <div className="flex flex-col gap-6">
      <RunHeader
        run={shownRun}
        projectName={project?.name ?? null}
        nowMs={nowMs}
        endedMs={endedMs}
        onAborted={() => void refresh()}
      />

      <InterruptedRunBanner run={shownRun} steps={steps} onChanged={() => void refresh()} />

      <EventFeed
        entries={entries}
        streamState={streamState}
        onReconnect={() => streamHandleRef.current?.reconnect()}
      />

      {showPanels && output.length > 0 ? <OutputPanel output={output} /> : null}
      {showPanels && diff.length > 0 ? <DiffPanel diff={diff} /> : null}
    </div>
  );
}
