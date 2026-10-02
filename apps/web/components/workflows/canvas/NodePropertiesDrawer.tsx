"use client";

import { useMemo, useRef, useState, type ComponentProps } from "react";
import type { StepConfig } from "@openeuler/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Field, Input, Textarea } from "@/components/ui/input";
import type { AgentNodeData, CanvasDocument, CanvasNode } from "@/lib/graph/canvas-document";
import {
  insertPromptVariable,
  inspectorFieldErrors,
  previewPromptTemplate,
  upstreamNodes,
  type InspectorFieldErrors,
} from "@/lib/graph/inspector";
import {
  classifyIssue,
  issueHint,
  issuesForNode,
  type CanvasIssue,
} from "@/lib/graph/validation";
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
  onCommitEdit,
  onDelete,
  onClose,
  preset,
  onDetachPreset,
  onUpdateFromPreset,
  onSaveAsPreset,
}: {
  node: CanvasNode;
  doc: CanvasDocument;
  issues: readonly CanvasIssue[];
  onPatchAgent: (patch: Partial<StepConfig>) => void;
  onPatchName: (name: string) => void;
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
              {node.data.kind === "agent" ? "Agent step" : "Exit node"}
            </h2>
            {node.data.kind === "agent" && node.data.isEntry ? (
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
            placeholder={node.data.kind === "agent" ? "e.g. implement" : "Exit"}
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
          {node.data.kind === "agent" && node.data.isEntry ? (
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
    </>
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
