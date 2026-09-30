import { cn } from "@/lib/cn";
import type { AgentToolCallEvent, AgentToolOutputEvent } from "@openeuler/core";
import type { ReactNode } from "react";
import type { RunStatusEvent } from "@openeuler/core";
import { TERMINAL_STATUS_STYLES, type FeedEntry } from "@/lib/run-feed";

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
  const style = TERMINAL_STATUS_STYLES[event.status];
  return (
    <p className={cn("rounded-lg border px-3 py-2 text-sm font-medium", style.className)}>
      {style.label}
    </p>
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
  }
}
