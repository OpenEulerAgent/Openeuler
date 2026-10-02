"use client";

import { Badge } from "@/components/ui/badge";
import type { CanvasWarning } from "@/lib/graph/edge-inspector";
import {
  issueHint,
  severitySummary,
  splitIssuesBySeverity,
  type CanvasIssue,
} from "@/lib/graph/validation";
import { cn } from "@/lib/cn";

/**
 * Live validation summary (#46, #68): every issue with its canvas target,
 * grouped by severity — hard blockers first (red), then structural hints
 * (amber, e.g. a freshly dropped node not wired in yet). Clicking an entry
 * focuses + selects the offending node/edge. Save stays blocked while ANY
 * issue (hint or blocker) exists; the split is purely tonal. Advisory
 * warnings (e.g. a router with no `always` fallback, #48) render in their
 * own amber section — visible in the same panel, never blocking.
 */
export function ValidationPanel({
  issues,
  warnings = [],
  nodeNames,
  edgeLabels,
  onFocusIssue,
  className,
}: {
  issues: readonly CanvasIssue[];
  /** Advisory findings shown below the blocking issues. */
  warnings?: readonly CanvasWarning[];
  nodeNames: ReadonlyMap<string, string>;
  /** Human-readable "source → target" labels; ids are the fallback (#69). */
  edgeLabels?: ReadonlyMap<string, string>;
  onFocusIssue: (issue: CanvasIssue) => void;
  className?: string;
}) {
  const { blockers, hints } = splitIssuesBySeverity(issues);
  if (issues.length === 0 && warnings.length === 0) return null;
  return (
    <div className={cn("flex w-full flex-col gap-2", className)} data-validation-panel>
      {issues.length > 0 ? (
        <div
          role="alert"
          aria-label="Validation issues"
          className={cn(
            "flex max-h-52 w-full flex-col overflow-y-auto rounded-lg border p-3",
            blockers.length > 0
              ? "border-danger/40 bg-danger-subtle"
              : "border-warning/50 bg-warning-subtle",
          )}
        >
          <p
            className={cn(
              "text-sm font-medium",
              blockers.length > 0 ? "text-danger" : "text-warning",
            )}
          >
            {severitySummary(issues)} — fix to save
          </p>

          {blockers.length > 0 ? (
            <ul className="mt-1.5 flex flex-col gap-1" data-validation-blockers>
              {blockers.map((issue, index) => (
                <li key={index}>
                  <button
                    type="button"
                    onClick={() => onFocusIssue(issue)}
                    className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs text-danger transition-colors hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Badge variant="danger" className="mt-0.5 shrink-0 px-1.5 py-0 text-[10px]">
                      {labelFor(issue, nodeNames, edgeLabels)}
                    </Badge>
                    <span className="min-w-0">
                      {issue.message}
                      {issue.field ? (
                        <span className="block font-mono text-[10px] opacity-70">
                          {issue.field}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {hints.length > 0 ? (
            <ul
              className={cn("flex flex-col gap-1", blockers.length > 0 ? "mt-2" : "mt-1.5")}
              data-validation-hints
            >
              {hints.map((issue, index) => (
                <li key={index}>
                  <button
                    type="button"
                    onClick={() => onFocusIssue(issue)}
                    className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs text-warning transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Badge variant="warning" className="mt-0.5 shrink-0 px-1.5 py-0 text-[10px]">
                      {labelFor(issue, nodeNames, edgeLabels)}
                    </Badge>
                    <span className="min-w-0">
                      {issueHint(issue) ?? issue.message}
                      <span className="block text-[10px] opacity-70">{issue.message}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div
          role="status"
          aria-label="Validation warnings"
          className="flex max-h-44 w-full flex-col overflow-y-auto rounded-lg border border-warning/50 bg-warning-subtle p-3"
          data-validation-warnings
        >
          <p className="text-sm font-medium text-warning">
            {warnings.length} warning{warnings.length === 1 ? "" : "s"} — will not block saving
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {warnings.map((warning, index) => (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => onFocusIssue(warning)}
                  className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs text-warning transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <Badge variant="warning" className="mt-0.5 shrink-0 px-1.5 py-0 text-[10px]">
                    {labelFor(warning, nodeNames, edgeLabels)}
                  </Badge>
                  <span className="min-w-0">{warning.message}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function labelFor(
  issue: { nodeId?: string; edgeId?: string },
  nodeNames: ReadonlyMap<string, string>,
  edgeLabels?: ReadonlyMap<string, string>,
): string {
  if (issue.nodeId !== undefined) return nodeNames.get(issue.nodeId) ?? issue.nodeId;
  if (issue.edgeId !== undefined) return edgeLabels?.get(issue.edgeId) ?? `edge ${issue.edgeId}`;
  return "graph";
}
