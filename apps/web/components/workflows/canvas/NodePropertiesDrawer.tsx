"use client";

import { useMemo, useRef, useState, type ComponentProps } from "react";
import type { SandboxOverrides, StepConfig } from "@openeuler/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import type {
  AgentNodeData,
  CanvasDocument,
  CanvasNode,
  JoinNodeData,
  SubworkflowNodeData,
} from "@/lib/graph/canvas-document";
import {
  insertPromptVariable,
  inspectorFieldErrors,
  previewPromptTemplate,
  upstreamNodes,
  type InspectorFieldErrors,
} from "@/lib/graph/inspector";
import { classifyIssue, issueHint, issuesForNode, type CanvasIssue } from "@/lib/graph/validation";
import { cn } from "@/lib/cn";

/**
 * The "build the agent" inspector (#47): right drawer bound to the selected
 * canvas node. Agent nodes edit their full StepConfig — name, prompt with
 * insert-variable buttons (the `{{output:…}}` picker lists upstream nodes
 * only), model, mode toggle, session continuation — against a live
 * sample-data prompt preview and inline zod field errors. Patches apply to
 * the document live (the canvas card updates without save); the editor
 * debounces them into undo entries and settles them on field blur / close.
 *
 * Preset provenance (#49): nodes created from a preset show a
 * "from preset: X" badge with an explicit **Detach** button (drops the link,
 * keeps the config copy) and **Update from preset** (copies the preset's
 * CURRENT config + name in). A "Save as preset…" action turns the node's
 * current config into a new roster entry. When the badge is absent the
 * node is plain — including stale presetIds whose preset was deleted.
 */
export function NodePropertiesDrawer({
  node,
  doc,
  issues,
  onPatchAgent,
  onPatchName,
  onPatchJoinMode,
  onPatchSubworkflow,
  onCommitEdit,
  onDelete,
  onClose,
  preset,
  onDetachPreset,
  onUpdateFromPreset,
  onSaveAsPreset,
  workflows,
}: {
  node: CanvasNode;
  doc: CanvasDocument;
  issues: readonly CanvasIssue[];
  onPatchAgent: (patch: Partial<StepConfig>) => void;
  onPatchName: (name: string) => void;
  /** Join mode toggle (#116): `all` waits for every branch, `any` = first winner. */
  onPatchJoinMode?: (mode: "all" | "any") => void;
  /**
   * Sub-workflow picker (#117): which workflow the node spawns + how its
   * revision is pinned.
   */
  onPatchSubworkflow?: (patch: { workflowId?: string; revision?: "latest" | number }) => void;
  /** Settles a pending debounced edit into one history entry (field blur). */
  onCommitEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** The preset this node came from; undefined = plain/detached/stale. */
  preset?: { name: string } | undefined;
  onDetachPreset?: () => void;
  onUpdateFromPreset?: () => void;
  /** Saves the node's current config as a new preset. */
  onSaveAsPreset?: (name: string, description: string) => Promise<void> | void;
  /** The project's workflows, for the sub-workflow picker (#117). */
  workflows?: readonly SubworkflowPickerWorkflow[] | undefined;
}) {
  const fieldErrors = useMemo(() => inspectorFieldErrors(doc, node.id), [doc, node.id]);
  const nodeIssues = issuesForNode(issues, node.id).filter(
    (issue) => !(issue.field ?? "").startsWith("config.") && issue.field !== "name",
  );
  const nodeBlockers = nodeIssues.filter((issue) => classifyIssue(issue) === "blocker");
  const nodeHints = nodeIssues.filter((issue) => classifyIssue(issue) === "hint");
  const [saveAsOpen, setSaveAsOpen] = useState(false);

  return (
    <Drawer open onClose={onClose} label={`Edit ${node.data.name || "node"}`} className="max-w-sm">
      <div className="flex flex-col gap-4" onBlur={onCommitEdit}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-title font-semibold text-fg">
              {node.data.kind === "agent"
                ? "Agent step"
                : node.data.kind === "join"
                  ? "Join node"
                  : node.data.kind === "subworkflow"
                    ? "Sub-workflow node"
                    : "Exit node"}
            </h2>
            {node.data.kind === "agent" && node.data.isEntry ? (
              <Badge variant="accent" className="mt-1">
                entry · pinned
              </Badge>
            ) : null}
            {node.data.kind === "subworkflow" && node.data.isEntry ? (
              <Badge variant="accent" className="mt-1">
                entry · pinned
              </Badge>
            ) : null}
            {preset !== undefined ? (
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" data-preset-badge>
                  from preset: {preset.name}
                </Badge>
                {onDetachPreset ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onDetachPreset}
                    title="Keep this node's config copy, but stop tracking the preset"
                  >
                    Detach
                  </Button>
                ) : null}
              </span>
            ) : null}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <Field label="Name" htmlFor="node-name" error={fieldErrors["name"]}>
          <Input
            id="node-name"
            value={node.data.name}
            invalid={fieldErrors["name"] !== undefined}
            onChange={(event) => onPatchName(event.target.value)}
            placeholder={
              node.data.kind === "agent"
                ? "e.g. implement"
                : node.data.kind === "join"
                  ? "Join"
                  : "Exit"
            }
          />
        </Field>

        {node.data.kind === "agent" ? (
          <AgentInspector
            node={node as CanvasNode & { data: AgentNodeData }}
            doc={doc}
            fieldErrors={fieldErrors}
            onPatchAgent={onPatchAgent}
          />
        ) : null}

        {node.data.kind === "join" ? (
          <JoinInspector
            node={node as CanvasNode & { data: JoinNodeData }}
            onPatchJoinMode={onPatchJoinMode}
          />
        ) : null}

        {node.data.kind === "subworkflow" ? (
          <SubworkflowInspector
            node={node as CanvasNode & { data: SubworkflowNodeData }}
            workflows={workflows ?? []}
            fieldErrors={fieldErrors}
            onPatchSubworkflow={onPatchSubworkflow}
          />
        ) : null}

        {nodeBlockers.length > 0 ? (
          <div className="rounded-lg border border-danger/40 bg-danger-subtle p-3" role="alert">
            <p className="text-sm font-medium text-danger">
              {nodeBlockers.length} blocker{nodeBlockers.length === 1 ? "" : "s"} on this node
            </p>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-xs text-danger">
              {nodeBlockers.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {nodeHints.length > 0 ? (
          <div
            className="rounded-lg border border-warning/50 bg-warning-subtle p-3"
            role="status"
            data-node-hints
          >
            <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-warning">
              {nodeHints.map((issue, index) => (
                <li key={index}>{issueHint(issue) ?? issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {node.data.kind === "agent" && (onSaveAsPreset !== undefined || preset !== undefined) ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-elevated/40 p-3">
            {preset !== undefined && onUpdateFromPreset !== undefined ? (
              <>
                <p className="text-xs text-muted-fg">
                  Preset edits never change this node automatically — update pulls the current
                  preset config and name in.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onUpdateFromPreset}
                  data-update-from-preset
                >
                  Update from preset
                </Button>
              </>
            ) : null}
            {onSaveAsPreset !== undefined ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSaveAsOpen(true)}
                data-save-as-preset
              >
                Save as preset…
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-auto flex justify-end pt-2">
          {node.data.isEntry === true ? (
            <p className="text-xs text-muted-fg">The entry node cannot be deleted.</p>
          ) : (
            <Button variant="danger" onClick={onDelete}>
              Delete node
            </Button>
          )}
        </div>
      </div>

      {saveAsOpen && onSaveAsPreset !== undefined ? (
        <SaveAsPresetDialog
          defaultName={node.data.kind === "agent" ? node.data.name : ""}
          onClose={() => setSaveAsOpen(false)}
          onSave={onSaveAsPreset}
        />
      ) : null}
    </Drawer>
  );
}

/** Name/description prompt for turning the inspected node into a preset. */
function SaveAsPresetDialog({
  defaultName,
  onClose,
  onSave,
}: {
  defaultName: string;
  onClose: () => void;
  onSave: (name: string, description: string) => Promise<void> | void;
}) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setSaving(true);
    try {
      await onSave(trimmed, description.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      disableClose={saving}
      label="Save node as preset"
      className="max-w-sm"
    >
      <h2 className="text-title font-semibold text-fg">Save node as preset</h2>
      <p className="mt-1 text-sm text-muted-fg">
        Adds the current config to “Your team”. Existing nodes are untouched — presets are
        templates, not links.
      </p>
      <div className="mt-4 flex flex-col gap-3">
        <Field label="Preset name" htmlFor="preset-name">
          <Input
            id="preset-name"
            value={name}
            autoFocus
            invalid={name.trim().length === 0}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Senior Reviewer"
          />
        </Field>
        <Field label="Description" hint="(optional)" htmlFor="preset-description">
          <Textarea
            id="preset-description"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this agent does"
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} loading={saving} disabled={name.trim().length === 0}>
          Save preset
        </Button>
      </div>
    </Dialog>
  );
}

/** Agent-only fields. Rendered exclusively for `kind: "agent"` nodes. */
function AgentInspector({
  node,
  doc,
  fieldErrors,
  onPatchAgent,
}: {
  node: CanvasNode & { data: AgentNodeData };
  doc: CanvasDocument;
  fieldErrors: InspectorFieldErrors;
  onPatchAgent: (patch: Partial<StepConfig>) => void;
}) {
  const { config } = node.data;

  const upstream = useMemo(() => upstreamNodes(doc, node.id), [doc, node.id]);
  const preview = useMemo(
    () =>
      previewPromptTemplate(
        config.promptTemplate,
        upstream.map((candidate) => ({ id: candidate.id, name: candidate.data.name })),
      ),
    [config.promptTemplate, upstream],
  );

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  /** Inserts a variable token at the textarea caret and keeps focus there. */
  const insertVariable = (token: string) => {
    const el = textareaRef.current;
    const at = el ? (el.selectionStart ?? el.value.length) : config.promptTemplate.length;
    const result = insertPromptVariable(config.promptTemplate, token, at);
    onPatchAgent({ promptTemplate: result.template });
    setPickerOpen(false);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta === null) return;
      ta.focus();
      ta.setSelectionRange(result.caret, result.caret);
    });
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Driver" htmlFor="node-driver">
          <p
            id="node-driver"
            className="flex min-h-[34px] items-center"
            title="Driver per node is coming — the workflow default applies for now."
          >
            <Badge
              variant="outline"
              className="max-w-full truncate px-2 py-1 font-mono text-[10px]"
            >
              {config.driver}
            </Badge>
            <span className="sr-only"> (read-only)</span>
          </p>
        </Field>
        <Field label="Model" hint="(optional)" htmlFor="node-model">
          <Input
            id="node-model"
            value={config.model ?? ""}
            invalid={fieldErrors["config.model"] !== undefined}
            onChange={(event) =>
              onPatchAgent({
                model:
                  event.target.value.trim().length === 0 ? undefined : event.target.value.trim(),
              })
            }
            placeholder="provider/model"
            className="font-mono"
          />
        </Field>
      </div>

      <Field label="Mode" htmlFor="node-mode">
        <div
          id="node-mode"
          role="group"
          aria-label="Mode"
          className="grid grid-cols-2 gap-1 rounded-md border border-border bg-surface p-1"
        >
          <ModeOption
            active={config.mode === "auto"}
            title="auto"
            hint="yolo — run without asking"
            onClick={() => onPatchAgent({ mode: "auto" })}
          />
          <ModeOption
            active={config.mode === "ask"}
            title="ask"
            hint="wait for approval"
            onClick={() => onPatchAgent({ mode: "ask" })}
          />
        </div>
      </Field>

      <Field
        label="Prompt template"
        htmlFor="node-prompt"
        error={fieldErrors["config.promptTemplate"]}
      >
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Insert variable"
        >
          {[
            { token: "{{task}}", label: "task" },
            { token: "{{iterations}}", label: "iterations" },
            { token: "{{prevOutput}}", label: "prevOutput" },
          ].map((item) => (
            <InsertButton key={item.token} onClick={() => insertVariable(item.token)}>
              {item.label}
            </InsertButton>
          ))}
          <span className="relative">
            <InsertButton
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              aria-controls="node-output-picker"
              active={pickerOpen}
              onClick={() => setPickerOpen((open) => !open)}
            >
              output:…
            </InsertButton>
            {pickerOpen ? (
              <>
                <button
                  type="button"
                  aria-label="Close node picker"
                  tabIndex={-1}
                  className="fixed inset-0 z-10 cursor-default"
                  onClick={() => setPickerOpen(false)}
                />
                <div
                  id="node-output-picker"
                  role="listbox"
                  aria-label="Upstream nodes"
                  className="absolute top-full left-0 z-20 mt-1 max-h-52 w-64 overflow-y-auto rounded-lg border border-border bg-surface p-1 text-left shadow-3"
                >
                  {upstream.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-fg">
                      No upstream nodes yet — connect a node into this one first.
                    </p>
                  ) : (
                    upstream.map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        role="option"
                        aria-selected={false}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => insertVariable(`{{output:${candidate.id}}}`)}
                        className="flex w-full flex-col rounded-md px-2 py-1.5 text-left transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <span className="truncate text-xs font-medium text-fg">
                          {candidate.data.name}
                        </span>
                        <span className="truncate font-mono text-[10px] text-muted-fg">
                          {`{{output:${candidate.id}}}`}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : null}
          </span>
        </div>
        <Textarea
          id="node-prompt"
          ref={textareaRef}
          rows={6}
          value={config.promptTemplate}
          invalid={fieldErrors["config.promptTemplate"] !== undefined}
          onChange={(event) => onPatchAgent({ promptTemplate: event.target.value })}
          placeholder="Use {{task}} for the run task and {{output:<node>}} for upstream outputs."
          className="font-mono text-xs"
        />
      </Field>

      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-fg">Preview</p>
        <div
          className={cn(
            "rounded-lg border bg-elevated/50 p-2.5 font-mono text-xs whitespace-pre-wrap",
            preview.ok ? "border-border text-fg" : "border-danger/40 text-danger",
          )}
          data-prompt-preview
          role={preview.ok ? "status" : "alert"}
        >
          {preview.ok ? preview.text || "…" : preview.error}
        </div>
        <p className="text-[11px] text-muted-fg">
          Rendered with a sample task and placeholder upstream outputs — this is what the agent
          receives at run time.
        </p>
      </div>

      <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-elevated/40 p-3">
        <label htmlFor="node-continue-session" className="text-sm text-fg">
          Continue previous session
          <span className="block text-xs font-normal text-muted-fg">
            Chain this step onto the session of the run so far.
          </span>
        </label>
        <button
          id="node-continue-session"
          type="button"
          role="switch"
          aria-checked={config.continueSession}
          aria-label="Continue previous session"
          onClick={() => onPatchAgent({ continueSession: !config.continueSession })}
          className={cn(
            "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
            config.continueSession ? "bg-accent" : "bg-border",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-1 transition-transform",
              config.continueSession && "translate-x-4",
            )}
          />
        </button>
      </div>

      <SandboxOverridesSection
        overrides={config.sandboxOverrides}
        fieldErrors={fieldErrors}
        onPatchAgent={onPatchAgent}
      />
    </>
  );
}

/**
 * Join-only fields (#116): the mode toggle is the whole config — a join has
 * no prompt, driver or model of its own. `all` synchronizes every branch,
 * `any` races them; the copy under each option says exactly what run time
 * does so the toggle never needs a manual.
 */
function JoinInspector({
  node,
  onPatchJoinMode,
}: {
  node: CanvasNode & { data: JoinNodeData };
  onPatchJoinMode?: (mode: "all" | "any") => void;
}) {
  const { mode } = node.data.config;
  return (
    <Field label="Mode" htmlFor="node-join-mode">
      <div
        id="node-join-mode"
        role="group"
        aria-label="Join mode"
        className="grid grid-cols-2 gap-1 rounded-md border border-border bg-surface p-1"
        data-join-mode={mode}
      >
        <ModeOption
          active={mode === "all"}
          title="all"
          hint="wait for every branch"
          onClick={() => onPatchJoinMode?.("all")}
        />
        <ModeOption
          active={mode === "any"}
          title="any"
          hint="first winner — losers cancelled"
          onClick={() => onPatchJoinMode?.("any")}
        />
      </div>
      <p className="text-xs text-muted-fg" data-join-mode-copy>
        {mode === "all"
          ? "all: every incoming branch must complete before the flow continues — the merged outputs of all branches become this join's output."
          : "any: the first branch to complete wins and the flow continues immediately; the remaining branches are cancelled."}
      </p>
    </Field>
  );
}

/** A workflow the sub-workflow picker (#117) lists. */
export interface SubworkflowPickerWorkflow {
  id: string;
  name: string;
  /** Latest revision number (the picker offers 1..N plus "latest"). */
  latestRevision?: number | undefined;
}

/**
 * Sub-workflow-only fields (#117): the whole config is a picker — WHICH
 * workflow this node spawns and HOW its revision is pinned. `latest`
 * re-resolves at every run (the child pins whatever is newest when it
 * starts); a pinned number freezes the snapshot. Choosing a different
 * workflow resets the revision to `latest`.
 */
function SubworkflowInspector({
  node,
  workflows,
  fieldErrors,
  onPatchSubworkflow,
}: {
  node: CanvasNode & { data: SubworkflowNodeData };
  workflows: readonly SubworkflowPickerWorkflow[];
  fieldErrors: InspectorFieldErrors;
  onPatchSubworkflow?: (patch: { workflowId?: string; revision?: "latest" | number }) => void;
}) {
  const { workflowId, revision } = node.data.config;
  const selected = workflows.find((candidate) => candidate.id === workflowId);
  const latest = selected?.latestRevision ?? undefined;
  return (
    <>
      <Field
        label="Workflow"
        htmlFor="node-subworkflow-workflow"
        error={fieldErrors["config.workflowId"]}
      >
        <Select
          id="node-subworkflow-workflow"
          value={workflowId}
          invalid={fieldErrors["config.workflowId"] !== undefined}
          onChange={(event) => onPatchSubworkflow?.({ workflowId: event.target.value })}
          data-subworkflow-workflow
        >
          <option value="">Pick a workflow…</option>
          {workflows.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
              {candidate.latestRevision !== undefined ? ` (rev ${candidate.latestRevision})` : ""}
            </option>
          ))}
        </Select>
        {workflowId !== "" && selected === undefined ? (
          <p className="text-xs text-warning" data-subworkflow-stale>
            This workflow no longer exists — pick another before saving.
          </p>
        ) : null}
        <p className="text-xs text-muted-fg">
          Running this node spawns a child run of the workflow and waits for it — the child&apos;s
          final output becomes this node&apos;s output.
        </p>
      </Field>

      <Field
        label="Revision"
        htmlFor="node-subworkflow-revision"
        error={fieldErrors["config.revision"]}
      >
        <Select
          id="node-subworkflow-revision"
          value={revision === "latest" ? "latest" : String(revision)}
          invalid={fieldErrors["config.revision"] !== undefined}
          onChange={(event) =>
            onPatchSubworkflow?.({
              revision: event.target.value === "latest" ? "latest" : Number(event.target.value),
            })
          }
          data-subworkflow-revision
        >
          <option value="latest">latest — resolve at run time</option>
          {latest !== undefined
            ? Array.from({ length: latest }, (_, index) => index + 1)
                .reverse()
                .map((number) => (
                  <option key={number} value={number}>
                    pin revision {number}
                  </option>
                ))
            : revision !== "latest"
              ? [
                  <option key={revision} value={revision}>
                    pin revision {revision}
                  </option>,
                ]
              : null}
        </Select>
        <p className="text-xs text-muted-fg" data-subworkflow-revision-copy>
          {revision === "latest"
            ? "latest: each run pins the workflow's newest revision when the child starts — edits never mutate a running run."
            : `pinned: the child always runs revision ${revision}, exactly as saved.`}
        </p>
      </Field>
    </>
  );
}

/**
 * Per-node sandbox overrides (#101), collapsible: image / cpus / memory /
 * network. Every field defaults to empty = "inherit from project" — the
 * project sandbox policy applies, override fields win at run time. Patches
 * flow through the ordinary config patch (graph save persists a new
 * revision).
 */
function SandboxOverridesSection({
  overrides,
  fieldErrors,
  onPatchAgent,
}: {
  overrides: SandboxOverrides | undefined;
  fieldErrors: InspectorFieldErrors;
  onPatchAgent: (patch: Partial<StepConfig>) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeCount =
    overrides === undefined
      ? 0
      : [overrides.image, overrides.cpus, overrides.memoryMb, overrides.network].filter(
          (field) => field !== undefined,
        ).length;

  /** Patches one field of the overrides object; empty input clears the field. */
  const patchOverride = (field: keyof SandboxOverrides, value: number | string | undefined) => {
    const next: SandboxOverrides = { ...(overrides ?? {}) };
    if (value === undefined || value === "") {
      delete next[field];
    } else {
      (next as Record<string, unknown>)[field] = value;
    }
    const hasFields = Object.values(next).some((entry) => entry !== undefined);
    onPatchAgent({ sandboxOverrides: hasFields ? next : undefined });
  };

  return (
    <div className="rounded-lg border border-border bg-elevated/40">
      <button
        type="button"
        aria-expanded={open}
        data-sandbox-overrides-toggle
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-fg transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span>Sandbox overrides</span>
        {activeCount > 0 ? (
          <Badge variant="neutral">
            {activeCount} override{activeCount === 1 ? "" : "s"}
          </Badge>
        ) : null}
        <span aria-hidden className="text-muted-fg">
          {open ? "−" : "+"}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
          <p className="text-xs text-muted-fg">
            Empty fields inherit the project&apos;s sandbox policy (Project settings → Sandbox); set
            fields here to override it for this step only.
          </p>
          <Field
            label="Image"
            hint="(inherit from project by default)"
            htmlFor="node-sandbox-image"
            error={fieldErrors["config.sandboxOverrides.image"]}
          >
            <Input
              id="node-sandbox-image"
              value={overrides?.image ?? ""}
              invalid={fieldErrors["config.sandboxOverrides.image"] !== undefined}
              onChange={(event) => patchOverride("image", event.target.value.trim())}
              placeholder="openeuler/worker:latest"
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="CPUs"
              hint="(1–8)"
              htmlFor="node-sandbox-cpus"
              error={fieldErrors["config.sandboxOverrides.cpus"]}
            >
              <Input
                id="node-sandbox-cpus"
                type="number"
                min={1}
                max={8}
                step={1}
                value={overrides?.cpus ?? ""}
                invalid={fieldErrors["config.sandboxOverrides.cpus"] !== undefined}
                onChange={(event) => {
                  const raw = event.target.value;
                  patchOverride("cpus", raw === "" ? undefined : Number(raw));
                }}
                placeholder="inherit"
              />
            </Field>
            <Field
              label="Memory (MiB)"
              hint="(512–8192)"
              htmlFor="node-sandbox-memory"
              error={fieldErrors["config.sandboxOverrides.memoryMb"]}
            >
              <Input
                id="node-sandbox-memory"
                type="number"
                min={512}
                max={8192}
                step={256}
                value={overrides?.memoryMb ?? ""}
                invalid={fieldErrors["config.sandboxOverrides.memoryMb"] !== undefined}
                onChange={(event) => {
                  const raw = event.target.value;
                  patchOverride("memoryMb", raw === "" ? undefined : Number(raw));
                }}
                placeholder="inherit"
              />
            </Field>
          </div>
          <Field
            label="Network"
            htmlFor="node-sandbox-network"
            error={fieldErrors["config.sandboxOverrides.network"]}
          >
            <Select
              id="node-sandbox-network"
              value={overrides?.network ?? ""}
              invalid={fieldErrors["config.sandboxOverrides.network"] !== undefined}
              onChange={(event) => patchOverride("network", event.target.value)}
            >
              <option value="">inherit from project</option>
              <option value="none">none — fully isolated</option>
              <option value="limited">limited — dedicated bridge, DNS works</option>
              <option value="default">default — normal outbound</option>
            </Select>
            {overrides?.network === "limited" ? (
              <p className="text-xs text-warning">
                v0.2 honesty: “limited” does not filter egress yet.
              </p>
            ) : null}
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function ModeOption({
  active,
  title,
  hint,
  onClick,
}: {
  active: boolean;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-md px-2 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active ? "bg-accent text-accent-fg" : "text-muted-fg hover:bg-elevated hover:text-fg",
      )}
    >
      <span className="block text-xs font-medium">{title}</span>
      <span className="block text-[10px] opacity-80">{hint}</span>
    </button>
  );
}

function InsertButton({
  onClick,
  active = false,
  children,
  ...rest
}: ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active
          ? "border-accent bg-accent text-accent-fg"
          : "border-border bg-surface text-muted-fg hover:bg-elevated hover:text-fg",
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
