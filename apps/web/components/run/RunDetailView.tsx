"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Project, Run, StepRun, TerminalRunStatus } from "@openeuler/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { SkeletonLines } from "@/components/ui/skeleton";
import { apiFetch, ApiError } from "@/lib/api";
import type { RunAwaitingView } from "@/lib/approval";
import type { RunHostingView } from "@/lib/hosting";
import type { PreviewPortView } from "@/lib/preview";
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
import { HostedRunBanner } from "./HostedRunBanner";
import { SubworkflowLinks } from "./SubworkflowLinks";
import { ApprovalBanner } from "./ApprovalBanner";
import { ArtifactsTab } from "./ArtifactsTab";
import { InterruptedRunBanner } from "./InterruptedRunBanner";
import { LocalFallbackBanner } from "./LocalFallbackBanner";
import { OutputPanel } from "./OutputPanel";
import { PreviewTab } from "./PreviewTab";
import { RetryRunButton } from "./RetryRunButton";
import { RunHeader } from "./RunHeader";
import { RunGraphTab } from "./graph/RunGraphTab";
import { TimelineTab } from "./TimelineTab";

interface RunDetail {
  run: Run & {
    workflowRevision?: { id: string; number: number };
    /** Parent run id when this run is a sub-workflow child (#117). */
    parentRunId?: string;
    /** Child runs this run spawned via sub-workflow nodes (#117). */
    childRunIds?: string[];
  };
  steps: StepRun[];
  summary: { eventCount: number };
  /** Live sandbox snapshot while the run executes sandboxed (#102). */
  sandbox?: { id: string; image: string; status: string };
  /** Previewable port views (#107/#109): declared + detected, host while the sandbox lives. */
  ports?: PreviewPortView[];
  /** Hosting view (#110): expiry + live mappings while the run is hosted. */
  hosting?: RunHostingView | null;
  /** The open approval gate (#118), while the run is paused at one. */
  awaiting?: RunAwaitingView;
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
  /** #118: the open approval gate — synced from the detail, driven by SSE. */
  const [awaiting, setAwaiting] = useState<RunAwaitingView | null>(null);
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
    setAwaiting(null);
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
        // #118: the approval banner tracks the gate live — opened by
        // node.awaiting, closed by node.approved / the run ending.
        if (event.type === "node.awaiting") {
          setAwaiting((prev) => ({
            nodeId: event.nodeId,
            nodeName: event.nodeName,
            prompt: event.prompt,
            // SSE replay would otherwise restart the elapsed clock on every
            // page load/reconnect; a detail-synced `since` is authoritative.
            since: prev?.nodeId === event.nodeId ? prev.since : new Date().toISOString(),
          }));
        } else if (event.type === "node.approved") {
          setAwaiting(null);
        }
        if (event.type === "run.status" && isTerminalRunStatus(event.status)) {
          setTerminalStatus(event.status);
          setAwaiting(null);
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

  // #118: detail fetches are the source of truth for the gate (a fresh
  // page load lands here before any SSE event arrives); SSE mutations
  // above win until the next refetch replaces them.
  const detailAwaiting = load.phase === "ready" ? (load.detail.awaiting ?? null) : null;
  const detailAwaitingSeq = `${detailAwaiting?.nodeId ?? ""}|${detailAwaiting?.since ?? ""}`;
  useEffect(() => {
    setAwaiting(detailAwaiting);
    // Identity changes per refresh; the composed key avoids re-running on
    // unrelated re-renders while still syncing every real refetch.
  }, [detailAwaitingSeq]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Preview (#109) is visible only when the run tracks ports at all —
  // declared or detected (#107).
  const previewAvailable = (detail.ports?.length ?? 0) > 0;
  const defaultTab: RunDetailTab = graphAvailable ? "graph" : "events";
  // Guard: `?tab=graph` on an ad-hoc run (no workflow) and `?tab=preview`
  // on a portless run fall back to the default tab.
  const activeTab: RunDetailTab =
    query.tab === null ||
    (query.tab === "graph" && !graphAvailable) ||
    (query.tab === "preview" && !previewAvailable)
      ? defaultTab
      : query.tab;
  const tabs: ReadonlyArray<TabItem<RunDetailTab>> = RUN_DETAIL_TABS.filter((tab) =>
    tab.id === "graph" ? graphAvailable : tab.id === "preview" ? previewAvailable : true,
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
        attempts={foldState.totalAttempts}
        extraActions={
          !live && shownRun.status !== "success" ? <RetryRunButton runId={shownRun.id} /> : null
        }
        onAborted={() => void refresh()}
      />

      {/* #106: local-fallback notice when the policy wants a sandbox but
          docker is unavailable (auto-mode fallback; absent for sandboxed or
          local-policy runs). */}
      <LocalFallbackBanner
        projectId={detail.run.projectId}
        sandboxPresent={detail.sandbox !== undefined}
        runStatus={live ? "running" : shownRun.status}
      />

      <InterruptedRunBanner run={shownRun} steps={steps} onChanged={() => void refresh()} />

      {/* #118: approval gate — the run is paused waiting for a human;
          approve/reject (with a note) resolves it and the run continues. */}
      <ApprovalBanner
        runId={detail.run.id}
        awaiting={awaiting}
        nowMs={nowMs}
        live={live}
        onChanged={() => void refresh()}
      />

      {/* #110: hosted banner — the sandbox outlives the successful run for
          a TTL window; extend (+30m) or stop hosting inline. */}
      <HostedRunBanner
        runId={detail.run.id}
        hosting={detail.hosting ?? null}
        onChanged={() => void refresh()}
      />

      {/* #117: parent↔child links for sub-workflow chains ("child of …" up,
          one link per spawned child run down). */}
      <SubworkflowLinks
        runId={detail.run.id}
        parentRunId={detail.run.parentRunId}
        childRunIds={detail.run.childRunIds}
      />

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

        {/* Artifacts (#122): the durable capture of a terminal run's
            patterns — list, download, copy path. Lazy per activation. */}
        {activeTab === "artifacts" ? (
          <ArtifactsTab runId={detail.run.id} terminal={effectiveStatus !== undefined && !live} />
        ) : null}

        {/* Preview (#109): mounted only while active — the iframe and its
            HEAD poll are lazy by construction and torn down on switch.
            Hosted runs (#110) keep live mappings past success. */}
        {activeTab === "preview" ? (
          <PreviewTab
            runId={detail.run.id}
            ports={detail.ports ?? []}
            terminal={effectiveStatus !== undefined && !live}
            hosted={detail.hosting != null}
          />
        ) : null}
      </div>

      {showPanels && output.length > 0 ? <OutputPanel output={output} /> : null}
    </div>
  );
}
