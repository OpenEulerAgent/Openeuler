"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Project, Run, StepRun, TerminalRunStatus } from "@openeuler/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { SkeletonLines } from "@/components/ui/skeleton";
import { apiFetch, ApiError } from "@/lib/api";
import { connectRunEvents, type RunStreamEvent, type RunStreamState } from "@/lib/run-events";
import {
  appendFeedEvent,
  isLiveRun,
  isTerminalRunStatus,
  terminalEndMs,
  type FeedEntry,
} from "@/lib/run-feed";
import { EMPTY_RUN_GRAPH_STATE, type RunGraphFoldState } from "@/lib/run-graph/fold";
import { RunGraphFoldBatcher } from "@/lib/run-graph/batcher";
import { resolveRunGraphDocument, type RunGraphDocument } from "@/lib/run-graph/document";
import { fetchWorkflow } from "@/lib/workflows-api";
import {
  parseRunDetailQuery,
  runDetailQuery,
  RUN_DETAIL_TABS,
  type RunDetailTab,
} from "@/lib/run-detail-query";
import { DiffsTab } from "./DiffsTab";
import { EventFeed } from "./EventFeed";
import { InterruptedRunBanner } from "./InterruptedRunBanner";
import { OutputPanel } from "./OutputPanel";
import { RetryRunButton } from "./RetryRunButton";
import { RunHeader } from "./RunHeader";
import { RunGraphTab } from "./graph/RunGraphTab";
import { TimelineTab } from "./TimelineTab";

interface RunDetail {
  run: Run & { workflowRevision?: { id: string; number: number } };
  steps: StepRun[];
  summary: { eventCount: number };
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; detail: RunDetail; project: Project | null; graph: RunGraphDocument }
  | { phase: "notfound" }
  | { phase: "error"; message: string };

/** Fetch the run detail, its project and the graph document to render. */
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
    const graph = await resolveRunGraphDocument(detail.run, (workflowId) =>
      fetchWorkflow(workflowId),
    );
    return { phase: "ready", detail, project, graph };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return { phase: "notfound" };
    return {
      phase: "error",
      message: cause instanceof ApiError ? cause.message : "Failed to load run",
    };
  }
}

/**
 * The run detail surface, 2.0 (#52): header (status, executions, duration,
 * Stop/Retry) over tabs **Graph | Events | Diff | Timeline**. All daemon
 * traffic and the SSE lifecycle live here; the fold batches graph-state
 * updates (≤1 per interval window) so event bursts never thrash the canvas,
 * while the fold itself stays an idempotent reducer — an SSE replay rebuilds
 * the identical graph state.
 */
export function RunDetailView({ runId }: { runId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = parseRunDetailQuery(searchParams.toString());

  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [foldState, setFoldState] = useState<RunGraphFoldState>(EMPTY_RUN_GRAPH_STATE);
  const [streamState, setStreamState] = useState<RunStreamState>("connecting");
  const [terminalStatus, setTerminalStatus] = useState<TerminalRunStatus | null>(null);
  const [endedMs, setEndedMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [graphVisited, setGraphVisited] = useState(false);
  const runRef = useRef<Run | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoad(await fetchRunDetail(runId));
  }, [runId]);

  // Load on mount / run switch; reset per-run state so client-side
  // navigation between runs never shows the previous run's data.
  useEffect(() => {
    setLoad({ phase: "loading" });
    setEntries([]);
    setFoldState(EMPTY_RUN_GRAPH_STATE);
    setTerminalStatus(null);
    setEndedMs(null);
    setGraphVisited(false);
    setStreamState("connecting");
    void refresh();
  }, [refresh]);

  // Live stream: connects for every run — for terminal runs the daemon
  // replays persisted events through the terminal run.status and closes.
  // Graph state folds through a throttled batcher (#52 performance).
  const streamRunId = load.phase === "ready" ? load.detail.run.id : null;
  const streamHandleRef = useRef<ReturnType<typeof connectRunEvents> | null>(null);
  useEffect(() => {
    if (!streamRunId) return;
    const batcher = new RunGraphFoldBatcher({ onState: setFoldState });
    const handle = connectRunEvents({
      runId: streamRunId,
      onEvent: (event: RunStreamEvent) => {
        setEntries((prev) => appendFeedEvent(prev, event));
        batcher.push(event);
        if (event.type === "run.status" && isTerminalRunStatus(event.status)) {
          setTerminalStatus(event.status);
          batcher.flush();
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
      batcher.dispose();
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
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Loading run…</CardTitle>
            <CardDescription>Fetching run {runId} from the daemon.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <SkeletonLines rows={3} />
        </CardContent>
      </Card>
    );
  }

  if (load.phase === "notfound") {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Run not found</CardTitle>
            <CardDescription>The daemon has no record of this run.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-start gap-3 py-2 text-sm text-muted-fg">
            <p>
              Run <span className="font-mono text-fg">{runId}</span> does not exist — it may have
              been removed, or the link is stale.
            </p>
            <Button variant="secondary" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (load.phase === "error") {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Could not load run</CardTitle>
            <CardDescription>The daemon did not answer as expected.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-start gap-3 py-2 text-sm">
            <p className="text-danger">{load.message}</p>
            <Button variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { detail, project, graph } = load;
  const steps = detail.steps;
  const lastOutput = steps.length > 0 ? (steps[steps.length - 1]?.output ?? "") : "";
  const output = lastOutput.length > 0 ? lastOutput : (detail.run.output ?? "");
  const showPanels = effectiveStatus !== undefined && !live;
  const shownRun: Run =
    terminalStatus !== null ? { ...detail.run, status: terminalStatus } : detail.run;

  // Tabs: Graph leads whenever the run has a workflow behind it (pinned
  // revision or legacy chain); ad-hoc task runs start on Events. The URL is
  // the source of truth (`?tab=` deep links; `?stepRunId=` scopes Diff).
  const graphAvailable = detail.run.workflowId !== undefined;
  const defaultTab: RunDetailTab = graphAvailable ? "graph" : "events";
  // Guard: `?tab=graph` on an ad-hoc run (no workflow) falls back to Events.
  const activeTab: RunDetailTab =
    query.tab === null || (query.tab === "graph" && !graphAvailable) ? defaultTab : query.tab;
  const tabs: ReadonlyArray<TabItem<RunDetailTab>> = RUN_DETAIL_TABS.filter((tab) =>
    tab.id === "graph" ? graphAvailable : true,
  );

  const selectTab = (tab: RunDetailTab, stepRunId?: string): void => {
    const nextStepRunId = tab === "diff" ? (stepRunId ?? null) : null;
    const href = `${pathname}${runDetailQuery({ tab, stepRunId: nextStepRunId })}`;
    if (tab === "graph") setGraphVisited(true);
    router.replace(href, { scroll: false });
  };

  const graphMounted = graphVisited || activeTab === "graph";

  return (
    <div className="flex flex-col gap-6">
      <RunHeader
        run={shownRun}
        projectName={project?.name ?? null}
        nowMs={nowMs}
        endedMs={endedMs}
        executions={foldState.totalExecutions}
        extraActions={
          !live && shownRun.status !== "success" ? <RetryRunButton runId={shownRun.id} /> : null
        }
        onAborted={() => void refresh()}
      />

      <InterruptedRunBanner run={shownRun} steps={steps} onChanged={() => void refresh()} />

      <div className="flex flex-col gap-4" data-run-tabs>
        <Tabs
          tabs={tabs}
          active={activeTab}
          onChange={(tab) => selectTab(tab)}
          label="Run detail"
        />

        {graphAvailable && graphMounted ? (
          <div className={activeTab === "graph" ? "" : "hidden"}>
            <RunGraphTab
              graph={graph}
              state={foldState}
              live={live}
              steps={steps}
              onOpenDiff={(stepRunId) => selectTab("diff", stepRunId)}
            />
          </div>
        ) : null}

        {activeTab === "events" ? (
          <EventFeed
            entries={entries}
            streamState={streamState}
            onReconnect={() => streamHandleRef.current?.reconnect()}
          />
        ) : null}

        {activeTab === "diff" ? (
          <DiffsTab runId={detail.run.id} steps={steps} initialStepRunId={query.stepRunId} />
        ) : null}

        {activeTab === "timeline" ? <TimelineTab state={foldState} /> : null}
      </div>

      {showPanels && output.length > 0 ? <OutputPanel output={output} /> : null}
    </div>
  );
}
