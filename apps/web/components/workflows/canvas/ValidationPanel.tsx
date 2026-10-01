"use client";

import { Badge } from "@/components/ui/badge";
import type { CanvasIssue } from "@/lib/graph/validation";
import { cn } from "@/lib/cn";

/**
 * Save-time validation summary (#46): every issue with its canvas target;
 * clicking an entry focuses + selects the offending node/edge. Save stays
 * blocked while the list is non-empty.
 */
export function ValidationPanel({
  issues,
  nodeNames,
  onFocusIssue,
  className,
}: {
  issues: readonly CanvasIssue[];
  nodeNames: ReadonlyMap<string, string>;
  onFocusIssue: (issue: CanvasIssue) => void;
  className?: string;
}) {
  if (issues.length === 0) return null;
  return (
    <div
      role="alert"
      aria-label="Validation issues"
      className={cn(
        "flex max-h-52 w-full flex-col overflow-y-auto rounded-lg border border-danger/40 bg-danger-subtle p-3",
        className,
      )}
      data-validation-panel
    >
      <p className="text-sm font-medium text-danger">
        {issues.length} issue{issues.length === 1 ? "" : "s"} — fix them to save
      </p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {issues.map((issue, index) => {
          const label =
            issue.nodeId !== undefined
              ? (nodeNames.get(issue.nodeId) ?? issue.nodeId)
              : issue.edgeId !== undefined
                ? `edge ${issue.edgeId}`
                : "graph";
          return (
            <li key={index}>
              <button
                type="button"
                onClick={() => onFocusIssue(issue)}
                className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs text-danger transition-colors hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Badge variant="danger" className="mt-0.5 shrink-0 px-1.5 py-0 text-[10px]">
                  {label}
                </Badge>
                <span className="min-w-0">
                  {issue.message}
                  {issue.field ? (
                    <span className="block font-mono text-[10px] opacity-70">{issue.field}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
