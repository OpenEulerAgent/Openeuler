"use client";

import type { ExitCondition } from "@openeuler/core";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import type { CanvasEdge, CanvasDocument } from "@/lib/graph/canvas-document";
import { isUnconditionalEdge } from "@/lib/graph/canvas-ops";
import type { CanvasIssue } from "@/lib/graph/validation";
import { issuesForEdge } from "@/lib/graph/validation";
import { cn } from "@/lib/cn";

/**
 * Floating panel for the selected edge: condition editor (type, pattern /
 * regex, invert, iteration cap) + delete. Patches are debounced into one
 * undo entry by the editor.
 */

export function conditionSummary(data: CanvasEdge["data"]): string {
  const condition = data.condition;
  if (condition.type === "always") {
    return data.invert === true ? "never (inverted always)" : "always";
  }
  const negated = data.invert === true;
  switch (condition.type) {
    case "outputContains":
      return `${negated ? "not " : ""}contains "${condition.pattern}"`;
    case "outputNotContains":
      return `${negated ? "" : "not "}contains "${condition.pattern}"`;
    case "outputMatches":
      return `${negated ? "not " : ""}matches /${condition.regex}/${condition.flags ?? ""}`;
  }
}

const CONDITION_TYPES: Array<{ id: ExitCondition["type"]; label: string }> = [
  { id: "always", label: "Always (fallback)" },
  { id: "outputContains", label: "Output contains" },
  { id: "outputNotContains", label: "Output does not contain" },
  { id: "outputMatches", label: "Output matches regex" },
];

export function EdgeEditorPanel({
  edge,
  doc,
  issues,
  onPatch,
  onDelete,
  onClose,
}: {
  edge: CanvasEdge;
  doc: CanvasDocument;
  issues: readonly CanvasIssue[];
  onPatch: (patch: Partial<CanvasEdge["data"]>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const edgeIssues = issuesForEdge(issues, edge.id);
  const condition = edge.data.condition;
  const source = doc.nodes.find((node) => node.id === edge.source);
  const target = doc.nodes.find((node) => node.id === edge.target);
  const isLoop = edge.target !== edge.source && reaches(doc, edge.target, edge.source);

  return (
    <div
      role="dialog"
      aria-label={`Edge ${source?.data.name ?? edge.source} → ${target?.data.name ?? edge.target}`}
      className="absolute top-3 right-3 z-20 w-72 rounded-lg border border-border bg-surface p-3 shadow-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">
            {source?.data.name ?? edge.source} → {target?.data.name ?? edge.target}
          </p>
          <p className="text-xs text-muted-fg">
            {isUnconditionalEdge(edge.data) ? "unconditional" : "conditional"}
            {edge.data.order !== undefined ? ` · order ${edge.data.order}` : ""}
            {isLoop ? " · loop edge" : ""}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close edge editor"
          onClick={onClose}
          className="rounded p-1 text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-3">
        <Field label="Condition" htmlFor="edge-condition-type">
          <Select
            id="edge-condition-type"
            value={condition.type}
            onChange={(event) => {
              const type = event.target.value as ExitCondition["type"];
              onPatch({
                condition:
                  type === "always"
                    ? { type: "always" }
                    : type === "outputMatches"
                      ? { type: "outputMatches", regex: "" }
                      : { type, pattern: "" },
              });
            }}
          >
            {CONDITION_TYPES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        {condition.type === "outputContains" || condition.type === "outputNotContains" ? (
          <Field label="Pattern" htmlFor="edge-pattern">
            <Input
              id="edge-pattern"
              value={"pattern" in condition ? condition.pattern : ""}
              invalid={edgeIssues.some((issue) => (issue.field ?? "").includes("pattern"))}
              onChange={(event) =>
                onPatch({
                  condition: { ...condition, pattern: event.target.value } as ExitCondition,
                })
              }
              placeholder="text to look for in the output"
            />
          </Field>
        ) : null}

        {condition.type === "outputMatches" ? (
          <>
            <Field label="Regex" htmlFor="edge-regex">
              <Input
                id="edge-regex"
                value={"regex" in condition ? condition.regex : ""}
                invalid={edgeIssues.some((issue) => (issue.field ?? "").includes("regex"))}
                onChange={(event) =>
                  onPatch({
                    condition: { ...condition, regex: event.target.value } as ExitCondition,
                  })
                }
                placeholder="output ~ /pattern/"
                className="font-mono"
              />
            </Field>
            <Field label="Flags" hint="(e.g. i)" htmlFor="edge-flags">
              <Input
                id="edge-flags"
                value={"flags" in condition ? (condition.flags ?? "") : ""}
                onChange={(event) =>
                  onPatch({
                    condition: {
                      ...condition,
                      ...(event.target.value.length === 0 ? {} : { flags: event.target.value }),
                    } as ExitCondition,
                  })
                }
                placeholder="i"
                className="font-mono"
              />
            </Field>
          </>
        ) : null}

        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={edge.data.invert === true}
            onChange={(event) => onPatch({ invert: event.target.checked ? true : undefined })}
            className="size-4 rounded border-border accent-[var(--accent)]"
          />
          Invert condition
        </label>

        <Field
          label="Max iterations"
          hint="(loop guard; blank = default)"
          htmlFor="edge-max-iterations"
        >
          <Input
            id="edge-max-iterations"
            type="number"
            min={1}
            value={edge.data.maxIterations ?? ""}
            onChange={(event) =>
              onPatch({
                maxIterations:
                  event.target.value.length === 0 ? undefined : Number(event.target.value),
              })
            }
          />
        </Field>

        {edgeIssues.length > 0 ? (
          <ul className="flex flex-col gap-1" role="alert">
            {edgeIssues.map((issue, index) => (
              <li key={index} className="text-xs text-danger">
                {issue.message}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex justify-between gap-2">
          <Button variant="danger" size="sm" onClick={onDelete}>
            Delete edge
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Whether `from` can reach `to` over the document's edges. */
function reaches(doc: CanvasDocument, from: string, to: string): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of doc.edges) {
    const bucket = outgoing.get(edge.source);
    if (bucket === undefined) outgoing.set(edge.source, [edge.target]);
    else bucket.push(edge.target);
  }
  const seen = new Set<string>();
  const queue = [...(outgoing.get(from) ?? [])];
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (next === to) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(outgoing.get(next) ?? []));
  }
  return false;
}

/** Red highlight class for edges carrying validation issues. */
export function edgeStrokeClass(issues: readonly CanvasIssue[], edgeId: string): string {
  return cn(issuesForEdge(issues, edgeId).length > 0 && "stroke-danger");
}
