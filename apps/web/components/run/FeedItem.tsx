import { cn } from "@/lib/cn";
import type {
  AgentToolCallEvent,
  AgentToolOutputEvent,
  EdgeCapReachedEvent,
  EdgeTakenEvent,
  LoopIterationEvent,
  NodeCompletedEvent,
  NodeQueuedEvent,
  NodeStartedEvent,
  RunStatusEvent,
} from "@openeuler/core";
import type { ReactNode } from "react";
import type { StepCompletedEvent, StepStartedEvent } from "@openeuler/core";
import { TERMINAL_STATUS_STYLES, isTerminalRunStatus, type FeedEntry } from "@/lib/run-feed";

function SystemLine({ children }: { children: ReactNode }) {
  return <p className="px-1 py-0.5 font-mono text-xs text-slate-400">{children}</p>;
}

function ToolCallItem({ event }: { event: AgentToolCallEvent }) {
  return (
    <details className="rounded-lg border border-slate-200 bg-white">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-sm text-slate-700 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-xs text-slate-400">
          ▸
        </span>
        <span className="font-mono text-xs font-semibold text-slate-800">{event.tool}</span>
        <span className="text-xs text-slate-400">tool call</span>
      </summary>
      <pre className="mx-3 mb-3 overflow-auto rounded-md bg-slate-50 p-2 font-mono text-xs text-slate-700">
        {JSON.stringify(event.input ?? {}, null, 2)}
      </pre>
    </details>
  );
}

function ToolOutputItem({ event }: { event: AgentToolOutputEvent }) {
  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-sm text-slate-600 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-xs text-slate-400">
          ▸
        </span>
        <span className="text-xs text-slate-500">tool output</span>
      </summary>
      <pre className="mx-3 mb-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-slate-100 p-2 font-mono text-xs text-slate-700">
        {event.output}
      </pre>
    </details>
  );
}

function RunStatusBanner({ event }: { event: RunStatusEvent }) {
  // Non-terminal transitions (e.g. `running`) render as a quiet system line;
  // only terminal statuses get the colored banner.
  if (!isTerminalRunStatus(event.status)) {
    return <SystemLine>run {event.status}</SystemLine>;
  }
  const style = TERMINAL_STATUS_STYLES[event.status];
  return (
    <p className={cn("rounded-lg border px-3 py-2 text-sm font-medium", style.className)}>
      {style.label}
    </p>
  );
}

function StepStartedItem({ event }: { event: StepStartedEvent }) {
  return (
    <SystemLine>
      step {event.stepName} started (pass {event.iteration})
    </SystemLine>
  );
}

function StepCompletedItem({ event }: { event: StepCompletedEvent }) {
  const failed = event.status !== "success";
  return (
    <SystemLine>
      <span className={failed ? "text-red-500" : undefined}>
        step {event.stepName} {event.status}
      </span>
    </SystemLine>
  );
}

/** Human-readable label for a loop verdict (kept in sync with the engine's detail). */
const LOOP_VERDICT_LABELS: Record<LoopIterationEvent["verdict"], string> = {
  continue: "continuing",
  "exit-condition-met": "exit condition met",
  "max-iterations": "stopped at maxIterations",
  "hard-cap": "stopped at the iteration hard cap",
};

function LoopIterationItem({ event }: { event: LoopIterationEvent }) {
  return (
    <SystemLine>
      loop pass {event.iteration}: {LOOP_VERDICT_LABELS[event.verdict]}
      {event.detail === undefined ? "" : ` — ${event.detail}`}
    </SystemLine>
  );
}

// --- graph events (#45): minimal system-line rendering; the full live
// graph view lands in #52. ---

function NodeQueuedItem({ event }: { event: NodeQueuedEvent }) {
  return (
    <SystemLine>
      node {event.nodeName} queued (pass {event.iteration})
    </SystemLine>
  );
}

function NodeStartedItem({ event }: { event: NodeStartedEvent }) {
  return (
    <SystemLine>
      node {event.nodeName} started (pass {event.iteration})
    </SystemLine>
  );
}

function NodeCompletedItem({ event }: { event: NodeCompletedEvent }) {
  const failed = event.status !== "success";
  const detail =
    event.status === "success"
      ? `${event.durationMs}ms`
      : `${event.status}${event.error === undefined ? "" : `: ${event.error}`}`;
  return (
    <SystemLine>
      <span className={failed ? "text-red-500" : undefined}>
        node {event.nodeName} {event.status}
      </span>{" "}
      ({detail})
    </SystemLine>
  );
}

function EdgeTakenItem({ event }: { event: EdgeTakenEvent }) {
  return (
    <SystemLine>
      route {event.source} → {event.target} ({event.matchedCondition})
    </SystemLine>
  );
}

function EdgeCapReachedItem({ event }: { event: EdgeCapReachedEvent }) {
  return (
    <SystemLine>
      <span className="text-amber-600">
        edge {event.edgeId} hit its iteration cap ({event.taken}/{event.maxIterations})
      </span>
    </SystemLine>
  );
}

/** Render one feed row, styled per event type. */
export function FeedItem({ entry }: { entry: FeedEntry }) {
  if (entry.kind === "message") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <p className="text-xs font-medium text-slate-500">assistant</p>
        <p className="mt-1 whitespace-pre-wrap font-mono text-sm leading-relaxed text-slate-800">
          {entry.text}
        </p>
      </div>
    );
  }

  const { event } = entry;
  switch (event.type) {
    case "started":
      return <SystemLine>agent started</SystemLine>;
    case "session":
      return <SystemLine>session {event.sessionId}</SystemLine>;
    case "tool-call":
      return <ToolCallItem event={event} />;
    case "tool-output":
      return <ToolOutputItem event={event} />;
    case "done":
      return <SystemLine>agent finished</SystemLine>;
    case "error":
      return (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-red-600">
            error{event.code === undefined ? "" : ` (${event.code})`}
          </p>
          <p className="mt-1 font-mono text-sm text-red-700">{event.message}</p>
        </div>
      );
    case "run.status":
      return <RunStatusBanner event={event} />;
    case "step.started":
      return <StepStartedItem event={event} />;
    case "step.completed":
      return <StepCompletedItem event={event} />;
    case "loop.iteration":
      return <LoopIterationItem event={event} />;
    case "node.queued":
      return <NodeQueuedItem event={event} />;
    case "node.started":
      return <NodeStartedItem event={event} />;
    case "node.completed":
      return <NodeCompletedItem event={event} />;
    case "edge.taken":
      return <EdgeTakenItem event={event} />;
    case "edge.cap-reached":
      return <EdgeCapReachedItem event={event} />;
  }
}
