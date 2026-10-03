/**
 * URL wiring for the run detail page (#52): `?tab=` selects Graph | Events |
 * | Diff | Timeline | Preview (#109), `?stepRunId=` scopes the Diff tab to
 * one StepRun (the node drawer's deep link). Pure string helpers —
 * unit-tested without a router.
 */

export type RunDetailTab = "graph" | "events" | "diff" | "timeline" | "preview";

export const RUN_DETAIL_TABS: ReadonlyArray<{ id: RunDetailTab; label: string }> = [
  { id: "graph", label: "Graph" },
  { id: "events", label: "Events" },
  { id: "diff", label: "Diff" },
  { id: "timeline", label: "Timeline" },
  { id: "preview", label: "Preview" },
];

export function isRunDetailTab(value: string | null | undefined): value is RunDetailTab {
  return (
    value === "graph" ||
    value === "events" ||
    value === "diff" ||
    value === "timeline" ||
    value === "preview"
  );
}

export interface RunDetailQuery {
  tab: RunDetailTab | null;
  stepRunId: string | null;
}

/** Parses `tab` + `stepRunId` off a query string (`"?tab=diff&stepRunId=…"`). */
export function parseRunDetailQuery(search: string): RunDetailQuery {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  const stepRunId = params.get("stepRunId");
  return {
    tab: isRunDetailTab(tab) ? tab : null,
    stepRunId: stepRunId && stepRunId.length > 0 ? stepRunId : null,
  };
}

/** Builds the canonical query string for a run detail location. */
export function runDetailQuery(options: {
  tab?: RunDetailTab | null;
  stepRunId?: string | null;
}): string {
  const params = new URLSearchParams();
  if (options.tab !== undefined && options.tab !== null) params.set("tab", options.tab);
  if (options.stepRunId !== undefined && options.stepRunId !== null) {
    params.set("stepRunId", options.stepRunId);
  }
  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

/** Deep link into the Diff tab scoped to one StepRun (node drawer link). */
export function diffDeepLink(runId: string, stepRunId: string): string {
  return `/runs/${encodeURIComponent(runId)}${runDetailQuery({ tab: "diff", stepRunId })}`;
}

/** Plain run detail href (tab resets to its default). */
export function runDetailHref(runId: string, tab?: RunDetailTab): string {
  return `/runs/${encodeURIComponent(runId)}${tab === undefined ? "" : runDetailQuery({ tab })}`;
}
