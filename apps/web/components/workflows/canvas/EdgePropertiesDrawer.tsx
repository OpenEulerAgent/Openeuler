"use client";

import { useMemo, useState } from "react";
import type { ExitCondition } from "@openeuler/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import type { CanvasDocument, CanvasEdge } from "@/lib/graph/canvas-document";
import {
  EDGE_MAX_ITERATIONS_DEFAULT,
  EDGE_MAX_ITERATIONS_HARD_CAP,
  MISSING_FALLBACK_MESSAGE,
  clampMaxIterations,
  conditionForType,
  conditionSummary,
  cyclicEdgeIds,
  edgeFieldErrors,
  needsConditionConfig,
  routerFallbackWarnings,
  routerRows,
  testCondition,
  type ConditionMatchRegion,
} from "@/lib/graph/edge-inspector";
import { issueHint, issuesForEdge, type CanvasIssue } from "@/lib/graph/validation";
import { cn } from "@/lib/cn";

/**
 * The conditional edge editor (#48): right drawer bound to the selected
 * canvas edge — condition builder (always / contains / not-contains /
 * regex + flags) with a negate toggle, a live test box that highlights the
 * matched regions of a pasted sample output exactly as the engine will
 * evaluate it, the cycle-guard maxIterations cap, and the source router's
 * evaluation order (first match wins, `always` fallback last). Patches
 * apply to the document live; the editor debounces them into undo entries
 * and settles them on field blur / close / selection change.
 */
export function EdgePropertiesDrawer({
  edge,
  doc,
  issues,
  onPatch,
  onMove,
  onCommitEdit,
  onDelete,
  onClose,
}: {
  edge: CanvasEdge;
  doc: CanvasDocument;
  issues: readonly CanvasIssue[];
  onPatch: (patch: Partial<CanvasEdge["data"]>) => void;
  /** Moves the given edge (a router-order row) within its evaluation order. */
  onMove: (edgeId: string, direction: -1 | 1) => void;
  /** Settles a pending debounced edit into one history entry (field blur). */
  onCommitEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const fieldErrors = useMemo(() => edgeFieldErrors(edge.data), [edge.data]);
  const edgeIssues = issuesForEdge(issues, edge.id);
  const condition = edge.data.condition;

  const source = doc.nodes.find((node) => node.id === edge.source);
  const target = doc.nodes.find((node) => node.id === edge.target);
  const sourceName = source?.data.kind === "agent" ? source.data.name : edge.source;
  const targetName = target?.data.name ?? edge.target;

  const siblings = doc.edges.filter((candidate) => candidate.source === edge.source);
  const rows = useMemo(() => routerRows(doc, edge.source), [doc, edge.source]);
  // Same gate as the lib's warnings (single-conditional routers included):
  // any router with ≥ 1 conditional edge and no always fallback.
  const missingFallback = useMemo(
    () => routerFallbackWarnings(doc).some((warning) => warning.nodeId === edge.source),
    [doc, edge.source],
  );

  const isCycleEdge = useMemo(() => cyclicEdgeIds(doc).has(edge.id), [doc, edge.id]);

  return (
    <Drawer
      open
      onClose={onClose}
      label={`Edit edge ${sourceName} to ${targetName}`}
      className="max-w-sm"
    >
      <div className="flex flex-col gap-4" onBlur={onCommitEdit}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-title font-semibold text-fg">Edge</h2>
            <p
              className="mt-0.5 truncate text-sm text-muted-fg"
              title={`${sourceName} → ${targetName}`}
            >
              {sourceName} → {targetName}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-fg">Canvas label</p>
          <div>
            <Badge
              variant={
                needsConditionConfig(edge.data)
                  ? "warning"
                  : condition.type === "always" && edge.data.invert !== true
                    ? "neutral"
                    : "info"
              }
              className="max-w-full truncate px-2 py-1 font-mono text-[11px]"
              title="Derived from the condition — shown on the canvas edge"
            >
              {conditionSummary(edge.data)}
            </Badge>
          </div>
        </div>

        <Field label="Condition" htmlFor="edge-condition-type">
          <Select
            id="edge-condition-type"
            value={condition.type}
            onChange={(event) =>
              onPatch({ condition: conditionForType(event.target.value as ExitCondition["type"]) })
            }
          >
            <option value="always">Always (fallback)</option>
            <option value="outputContains">Output contains</option>
            <option value="outputNotContains">Output does not contain</option>
            <option value="outputMatches">Output matches regex</option>
          </Select>
        </Field>

        {condition.type === "outputContains" || condition.type === "outputNotContains" ? (
          <Field label="Pattern" htmlFor="edge-pattern" error={fieldErrors.pattern}>
            <Input
              id="edge-pattern"
              value={condition.pattern}
              invalid={fieldErrors.pattern !== undefined}
              onChange={(event) =>
                onPatch({ condition: { ...condition, pattern: event.target.value } })
              }
              placeholder="text to look for in the output"
            />
          </Field>
        ) : null}

        {condition.type === "outputMatches" ? (
          <div className="grid grid-cols-[1fr_5rem] gap-3">
            <Field label="Regex" htmlFor="edge-regex" error={fieldErrors.regex}>
              <Input
                id="edge-regex"
                value={condition.regex}
                invalid={fieldErrors.regex !== undefined}
                onChange={(event) =>
                  onPatch({ condition: { ...condition, regex: event.target.value } })
                }
                placeholder="^ok$"
                className="font-mono"
              />
            </Field>
            <Field label="Flags" hint="(i)" htmlFor="edge-flags" error={fieldErrors.flags}>
              <Input
                id="edge-flags"
                value={condition.flags ?? ""}
                invalid={fieldErrors.flags !== undefined}
                onChange={(event) =>
                  onPatch({
                    condition: {
                      ...condition,
                      ...(event.target.value.length === 0 ? {} : { flags: event.target.value }),
                    },
                  })
                }
                placeholder="i"
                className="font-mono"
              />
            </Field>
          </div>
        ) : null}

        {condition.type === "always" && edge.data.invert !== true ? (
          <p className="text-xs text-muted-fg">
            Unconditional: taken whenever no conditional sibling matches — a router&apos;s fallback,
            evaluated last regardless of its position.
          </p>
        ) : null}

        <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-elevated/40 p-3">
          <label htmlFor="edge-invert" className="text-sm text-fg">
            Negate
            <span className="block text-xs font-normal text-muted-fg">
              Invert the match result (¬) at evaluation time — e.g. take this edge when the pattern
              does <span className="font-medium">not</span> match.
            </span>
          </label>
          <button
            id="edge-invert"
            type="button"
            role="switch"
            aria-checked={edge.data.invert === true}
            aria-label="Negate condition"
            onClick={() => onPatch({ invert: edge.data.invert === true ? undefined : true })}
            className={cn(
              "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
              edge.data.invert === true ? "bg-accent" : "bg-border",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-1 transition-transform",
                edge.data.invert === true && "translate-x-4",
              )}
            />
          </button>
        </div>

        <ConditionTestBox edge={edge} />

        {isCycleEdge ? (
          <Field
            label="Max iterations"
            hint={`(cycle guard; default ${EDGE_MAX_ITERATIONS_DEFAULT}, 1..${EDGE_MAX_ITERATIONS_HARD_CAP})`}
            htmlFor="edge-max-iterations"
            error={fieldErrors.maxIterations}
          >
            <Input
              id="edge-max-iterations"
              type="number"
              min={1}
              max={EDGE_MAX_ITERATIONS_HARD_CAP}
              value={edge.data.maxIterations ?? ""}
              invalid={fieldErrors.maxIterations !== undefined}
              onChange={(event) =>
                onPatch({
                  maxIterations:
                    event.target.value.length === 0
                      ? undefined
                      : clampMaxIterations(Number(event.target.value)),
                })
              }
              placeholder={String(EDGE_MAX_ITERATIONS_DEFAULT)}
            />
          </Field>
        ) : null}

        {siblings.length > 1 ? (
          <EvaluationOrder rows={rows} nodeNames={nodeNamesOf(doc)} onMove={onMove} />
        ) : null}

        {missingFallback ? (
          <div
            className="rounded-lg border border-warning/50 bg-warning-subtle p-3"
            role="alert"
            data-missing-fallback
          >
            <p className="text-sm font-medium text-warning">No fallback edge</p>
            <p className="mt-0.5 text-xs text-warning">{MISSING_FALLBACK_MESSAGE}</p>
          </div>
        ) : null}

        {edgeIssues.length > 0 ? (
          <div className="rounded-lg border border-danger/40 bg-danger-subtle p-3" role="alert">
            <p className="text-sm font-medium text-danger">
              {edgeIssues.length} issue{edgeIssues.length === 1 ? "" : "s"} on this edge — saving
              stays blocked
            </p>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-xs text-danger">
              {edgeIssues.map((issue, index) => (
                <li key={index}>{issueHint(issue) ?? issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-auto flex justify-end pt-2">
          <Button variant="danger" onClick={onDelete}>
            Delete edge
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

/**
 * The live test box: paste sample output, see the matched regions
 * highlighted exactly as the engine evaluates the condition (negate
 * included). Invalid or empty patterns show the compile error instead.
 */
function ConditionTestBox({ edge }: { edge: CanvasEdge }) {
  const [sample, setSample] = useState("");
  const result = useMemo(() => testCondition(edge.data, sample), [edge.data, sample]);

  return (
    <div className="flex flex-col gap-1" data-condition-test>
      <p className="text-sm font-medium text-fg">Test against sample output</p>
      <Textarea
        aria-label="Sample output"
        rows={3}
        value={sample}
        onChange={(event) => setSample(event.target.value)}
        placeholder="paste what this step's output might look like…"
        className="font-mono text-xs"
      />
      {result.ok ? (
        <>
          <div
            className="min-h-[2.25rem] rounded-lg border border-border bg-elevated/50 p-2.5 font-mono text-xs whitespace-pre-wrap text-fg"
            data-condition-test-preview
          >
            {sample.length === 0 ? (
              <span className="text-muted-fg">matched regions will highlight here</span>
            ) : result.regions.length === 0 ? (
              sample
            ) : (
              <Highlighted sample={sample} regions={result.regions} />
            )}
          </div>
          <p
            role="status"
            className={cn("text-xs font-medium", result.matched ? "text-success" : "text-muted-fg")}
          >
            {result.matched
              ? `condition matches — edge would be taken${edge.data.invert === true ? " (negated)" : ""}`
              : `no match — evaluation continues${edge.data.invert === true ? " (negated)" : ""}`}
          </p>
        </>
      ) : (
        <p className="text-xs text-danger" role="alert">
          {result.error} — fix the condition to test it.
        </p>
      )}
    </div>
  );
}

/** Sample text with each matched region wrapped in a `<mark>`. */
function Highlighted({ sample, regions }: { sample: string; regions: ConditionMatchRegion[] }) {
  const parts: Array<{ text: string; match: boolean }> = [];
  let at = 0;
  for (const region of regions) {
    if (region.start > at) parts.push({ text: sample.slice(at, region.start), match: false });
    parts.push({ text: sample.slice(region.start, region.end), match: true });
    at = region.end;
  }
  if (at < sample.length) parts.push({ text: sample.slice(at), match: false });
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark
            key={index}
            className="rounded-[2px] bg-info-subtle px-0.5 font-semibold text-info"
            data-match-region
          >
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** The source node's outgoing edges in evaluation order, fallback last. */
function EvaluationOrder({
  rows,
  nodeNames,
  onMove,
}: {
  rows: ReturnType<typeof routerRows>;
  nodeNames: ReadonlyMap<string, string>;
  onMove: (edgeId: string, direction: -1 | 1) => void;
}) {
  const conditionalRows = rows.filter((row) => row.conditional);
  const fallbackRow = rows.find((row) => !row.conditional);

  return (
    <div className="flex flex-col gap-1.5" data-evaluation-order>
      <div>
        <p className="text-sm font-medium text-fg">Evaluation order</p>
        <p className="text-xs text-muted-fg">
          First match wins: conditions are checked top to bottom against the source output; the{" "}
          <span className="font-medium text-fg">always</span> edge is the fallback and is evaluated
          last regardless of its position.
        </p>
      </div>
      <ol className="flex flex-col gap-1">
        {conditionalRows.map((row, index) => (
          <li
            key={row.edge.id}
            className={cn(
              "flex items-center gap-2 rounded-lg border p-2",
              row.edge.selected === true ? "border-accent bg-accent/5" : "border-border",
            )}
          >
            <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-fg">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-fg">
                → {nodeNames.get(row.edge.target) ?? row.edge.target}
              </span>
              <span className="block truncate font-mono text-[10px] text-muted-fg">
                {conditionSummary(row.edge.data)}
              </span>
            </span>
            <span className="flex shrink-0 gap-1">
              <button
                type="button"
                aria-label={`Evaluate via ${nodeNames.get(row.edge.target) ?? row.edge.target} earlier`}
                disabled={index === 0}
                onClick={() => onMove(row.edge.id, -1)}
                className="rounded-md border border-border p-1 text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-40"
              >
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className="size-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M8 3.5 3.5 8h9L8 3.5Z" fill="currentColor" stroke="none" />
                </svg>
              </button>
              <button
                type="button"
                aria-label={`Evaluate via ${nodeNames.get(row.edge.target) ?? row.edge.target} later`}
                disabled={index === conditionalRows.length - 1}
                onClick={() => onMove(row.edge.id, 1)}
                className="rounded-md border border-border p-1 text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-40"
              >
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className="size-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M8 12.5 12.5 8h-9L8 12.5Z" fill="currentColor" stroke="none" />
                </svg>
              </button>
            </span>
          </li>
        ))}
        {fallbackRow !== undefined ? (
          <li className="flex items-center gap-2 rounded-lg border border-dashed border-border p-2">
            <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-fg">↳</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-fg">
                → {nodeNames.get(fallbackRow.edge.target) ?? fallbackRow.edge.target}
              </span>
              <span className="block truncate font-mono text-[10px] text-muted-fg">
                {conditionSummary(fallbackRow.edge.data)}
              </span>
            </span>
            <Badge variant="neutral" className="shrink-0 px-1.5 py-0 text-[10px]">
              fallback
            </Badge>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

function nodeNamesOf(doc: CanvasDocument): ReadonlyMap<string, string> {
  return new Map(doc.nodes.map((node) => [node.id, node.data.name]));
}
