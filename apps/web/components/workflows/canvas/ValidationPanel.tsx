"use client";

import { Badge } from "@/components/ui/badge";
import type { CanvasWarning } from "@/lib/graph/edge-inspector";
import type { CanvasIssue } from "@/lib/graph/validation";
import { cn } from "@/lib/cn";

/**
 * Save-time validation summary (#46): every issue with its canvas target;
 * clicking an entry focuses + selects the offending node/edge. Save stays
 * blocked while the issues list is non-empty. Advisory warnings (e.g. a
 * router with no `always` fallback, #48) render in their own amber section
 * — visible in the same panel, never blocking.
 */
export function ValidationPanel({
  issues,
  warnings = [],
  nodeNames,
  onFocusIssue,
  className,
}: {
  issues: readonly CanvasIssue[];
  /** Advisory findings shown below the blocking issues. */
  warnings?: readonly CanvasWarning[];
  nodeNames: ReadonlyMap<string, string>;
  onFocusIssue: (issue: CanvasIssue) => void;
  className?: string;
}) {
  if (issues.length === 0 && warnings.length === 0) return null;
  return (
    <div className={cn("flex w-full flex-col gap-2", className)} data-validation-panel>
      {issues.length > 0 ? (
        <div
          role="alert"
          aria-label="Validation issues"
          className="flex max-h-52 w-full flex-col overflow-y-auto rounded-lg border border-danger/40 bg-danger-subtle p-3"
        >
          <p className="text-sm font-medium text-danger">
            {issues.length} issue{issues.length === 1 ? "" : "s"} — fix them to save
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {issues.map((issue, index) => (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => onFocusIssue(issue)}
                  className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs text-danger transition-colors hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <Badge variant="danger" className="mt-0.5 shrink-0 px-1.5 py-0 text-[10px]">
                    {labelFor(issue, nodeNames)}
                  </Badge>
                  <span className="min-w-0">
                    {issue.message}
                    {issue.field ? (
                      <span className="block font-mono text-[10px] opacity-70">{issue.field}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
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
                    {labelFor(warning, nodeNames)}
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
): string {
  if (issue.nodeId !== undefined) return nodeNames.get(issue.nodeId) ?? issue.nodeId;
  if (issue.edgeId !== undefined) return `edge ${issue.edgeId}`;
  return "graph";
}
