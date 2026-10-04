import { cn } from "@/lib/cn";
import type {
  AgentToolCallEvent,
  AgentToolOutputEvent,
  EdgeCapReachedEvent,
  EdgeTakenEvent,
  LoopIterationEvent,
  NodeApprovedEvent,
  NodeAwaitingEvent,
  NodeCompletedEvent,
  NodeQueuedEvent,
  NodeRetryEvent,
  NodeStartedEvent,
  RunStatusEvent,
  SandboxLogEvent,
  SandboxLogTruncatedEvent,
} from "@openeuler/core";
import type { ReactNode } from "react";
import type { StepCompletedEvent, StepStartedEvent } from "@openeuler/core";
import { TERMINAL_STATUS_STYLES, isTerminalRunStatus, type FeedEntry } from "@/lib/run-feed";

function SystemLine({ children }: { children: ReactNode }) {
  return <p className="px-1 py-0.5 font-mono text-xs text-muted-fg">{children}</p>;
}

function ToolCallItem({ event }: { event: AgentToolCallEvent }) {
  return (
    <details className="rounded-lg border border-border bg-surface">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-sm text-fg [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-xs text-muted-fg">
          ▸
        </span>
        <span className="font-mono text-xs font-semibold text-fg">{event.tool}</span>
        <span className="text-xs text-muted-fg">tool call</span>
      </summary>
      <pre className="mx-3 mb-3 overflow-auto rounded-md bg-elevated p-2 font-mono text-xs text-fg">
        {JSON.stringify(event.input ?? {}, null, 2)}
      </pre>
    </details>
  );
}

function ToolOutputItem({ event }: { event: AgentToolOutputEvent }) {
  return (
    <details className="rounded-lg border border-border bg-elevated">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-sm text-muted-fg [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-xs text-muted-fg">
          ▸
        </span>
        <span className="text-xs text-muted-fg">tool output</span>
      </summary>
      <pre className="mx-3 mb-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-surface p-2 font-mono text-xs text-fg">
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
      <span className={failed ? "text-danger" : undefined}>
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
      <span className={failed ? "text-danger" : undefined}>
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

// --- approval gate events (#118): the wait and the decision. ---

function NodeAwaitingItem({ event }: { event: NodeAwaitingEvent }) {
  return (
    <p className="rounded-lg border border-warning/40 bg-warning-subtle px-3 py-2 font-mono text-xs text-warning">
      ⏸ node {event.nodeName} awaiting approval (pass {event.iteration})
      {event.timeoutMinutes === undefined ? "" : ` · times out in ${event.timeoutMinutes}m`}
      {event.prompt.length > 0 ? ` — ${event.prompt}` : ""}
    </p>
  );
}

function NodeApprovedItem({ event }: { event: NodeApprovedEvent }) {
  return (
    <SystemLine>
      <span className={event.approved ? "text-success" : "text-warning"}>
        node {event.nodeName} {event.approved ? "approved" : "rejected"}
        {event.note === undefined || event.note.length === 0 ? "" : `: ${event.note}`}
      </span>
    </SystemLine>
  );
}

function EdgeCapReachedItem({ event }: { event: EdgeCapReachedEvent }) {
  return (
    <SystemLine>
      <span className="text-warning">
        edge {event.edgeId} hit its iteration cap ({event.taken}/{event.maxIterations})
      </span>
    </SystemLine>
  );
}

// --- node retry events (#119): an attempt is re-executed after backoff. ---

function NodeRetryItem({ event }: { event: NodeRetryEvent }) {
  return (
    <SystemLine>
      <span className="text-warning">
        node {event.nodeName} attempt {event.attempt} retried
        {event.error === undefined ? "" : `: ${event.error}`}
      </span>{" "}
      — next attempt in {event.nextInMs}ms (attempt {event.attempt + 1})
    </SystemLine>
  );
}

// --- sandbox log events (#104): quiet mono gray lines; the run feed shows
// them under "All" only (filters hide them), the graph fold ignores them. ---

function SandboxLogItem({ event }: { event: SandboxLogEvent }) {
  return (
    <p
      className={cn(
        "whitespace-pre-wrap break-all px-1 py-px font-mono text-xs",
        event.stream === "stderr" ? "text-warning/80" : "text-muted-fg",
      )}
    >
      {event.stream === "stderr" ? "[stderr] " : ""}
      {event.line}
    </p>
  );
}

function SandboxLogTruncatedItem({ event }: { event: SandboxLogTruncatedEvent }) {
  return (
    <SystemLine>
      <span className="text-warning">
        sandbox logs truncated — showing the last {event.kept} of {event.kept + event.dropped} lines
        ({event.dropped} dropped)
      </span>
    </SystemLine>
  );
}

/** Render one feed row, styled per event type. */
export function FeedItem({ entry }: { entry: FeedEntry }) {
  if (entry.kind === "message") {
    return (
      <div className="rounded-lg border border-border bg-surface p-3">
        <p className="text-xs font-medium text-muted-fg">assistant</p>
        <p className="mt-1 whitespace-pre-wrap font-mono text-sm leading-relaxed text-fg">
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
        <div className="rounded-lg border border-danger/40 bg-danger-subtle p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-danger">
            error{event.code === undefined ? "" : ` (${event.code})`}
          </p>
          <p className="mt-1 font-mono text-sm text-danger">{event.message}</p>
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
    case "node.awaiting":
      return <NodeAwaitingItem event={event} />;
    case "node.approved":
      return <NodeApprovedItem event={event} />;
    case "node.retry":
      return <NodeRetryItem event={event} />;
    case "edge.taken":
      return <EdgeTakenItem event={event} />;
    case "edge.cap-reached":
      return <EdgeCapReachedItem event={event} />;
    case "sandbox.log":
      return <SandboxLogItem event={event} />;
    case "sandbox.log-truncated":
      return <SandboxLogTruncatedItem event={event} />;
  }
}
