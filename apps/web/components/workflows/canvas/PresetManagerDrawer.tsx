"use client";

import { useState } from "react";
import type { AgentPreset, StepConfig } from "@openeuler/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Field, Input, Textarea } from "@/components/ui/input";
import type { AgentPresetUpdatePatch } from "@/lib/workflows-api";
import { cn } from "@/lib/cn";

/**
 * Minimal preset management (#49), opened from the palette's "Your team"
 * → Manage affordance: rename, edit description/icon, edit the config
 * fields (prompt/model/mode/continueSession), delete with confirm. Saving
 * PATCHes the preset — existing nodes are never touched (they sync only
 * via their own "Update from preset" button).
 */
export function PresetManagerDrawer({
  presets,
  onClose,
  onUpdate,
  onDelete,
}: {
  presets: readonly AgentPreset[];
  onClose: () => void;
  /** Persist edits; resolves on success, rejects (shown inline) on failure. */
  onUpdate: (presetId: string, patch: AgentPresetUpdatePatch) => Promise<void> | void;
  /** Delete after the user confirms; builtin presets are deletable too. */
  onDelete: (presetId: string) => Promise<void> | void;
}) {
  return (
    <Drawer open onClose={onClose} label="Manage presets" className="max-w-md" >
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-title font-semibold text-fg">Your team</h2>
            <p className="mt-0.5 text-xs text-muted-fg">
              {presets.length} preset{presets.length === 1 ? "" : "s"}. Editing a preset never
              changes existing nodes — nodes update only through “Update from preset”.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        {presets.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-fg">
            No presets. Open a node and use “Save as preset…” to add one.
          </p>
        ) : (
          presets.map((preset) => (
            <PresetRow
              key={preset.id}
              preset={preset}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </Drawer>
  );
}

function PresetRow({
  preset,
  onUpdate,
  onDelete,
}: {
  preset: AgentPreset;
  onUpdate: (presetId: string, patch: AgentPresetUpdatePatch) => Promise<void> | void;
  onDelete: (presetId: string) => Promise<void> | void;
}) {
  const [name, setName] = useState(preset.name);
  const [description, setDescription] = useState(preset.description);
  const [icon, setIcon] = useState(preset.icon ?? "");
  const [config, setConfig] = useState<StepConfig>(preset.config);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchConfig = (patch: Partial<StepConfig>) =>
    setConfig((current) => {
      const merged = { ...current, ...patch };
      for (const key of Object.keys(merged)) {
        if (merged[key as keyof StepConfig] === undefined) {
          delete merged[key as keyof StepConfig];
        }
      }
      return merged;
    });

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || config.promptTemplate.trim().length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await onUpdate(preset.id, {
        name: trimmed,
        description: description.trim(),
        icon: icon.trim().length === 0 ? null : icon.trim(),
        config,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save preset");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onDelete(preset.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to delete preset");
      setDeleting(false);
    }
  };

  const invalid = name.trim().length === 0 || config.promptTemplate.trim().length === 0;

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3"
      data-preset-row={preset.id}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base leading-none">
          {preset.icon ?? "🤖"}
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-fg">{preset.name}</span>
        {preset.builtin ? <Badge variant="neutral">builtin</Badge> : null}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setConfirmDelete(true)}
          title="Delete this preset (existing nodes keep their config copies)"
        >
          Delete
        </Button>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Field label="Name" htmlFor={`preset-${preset.id}-name`}>
          <Input
            id={`preset-${preset.id}-name`}
            value={name}
            invalid={name.trim().length === 0}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Icon" hint="(optional)" htmlFor={`preset-${preset.id}-icon`}>
          <Input
            id={`preset-${preset.id}-icon`}
            value={icon}
            onChange={(event) => setIcon(event.target.value)}
            placeholder="🛠️"
            className="w-16 text-center"
          />
        </Field>
      </div>

      <Field label="Description" htmlFor={`preset-${preset.id}-description`}>
        <Textarea
          id={`preset-${preset.id}-description`}
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What this agent does"
        />
      </Field>

      <Field label="Prompt template" htmlFor={`preset-${preset.id}-prompt`}>
        <Textarea
          id={`preset-${preset.id}-prompt`}
          rows={5}
          value={config.promptTemplate}
          invalid={config.promptTemplate.trim().length === 0}
          onChange={(event) => patchConfig({ promptTemplate: event.target.value })}
          placeholder="Use {{task}} for the run task and {{output:<node>}} for upstream outputs."
          className="font-mono text-xs"
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Model" hint="(optional)" htmlFor={`preset-${preset.id}-model`}>
          <Input
            id={`preset-${preset.id}-model`}
            value={config.model ?? ""}
            onChange={(event) =>
              patchConfig({
                model: event.target.value.trim().length === 0 ? undefined : event.target.value.trim(),
              })
            }
            placeholder="provider/model"
            className="font-mono"
          />
        </Field>
        <Field label="Mode" htmlFor={`preset-${preset.id}-mode`}>
          <div
            id={`preset-${preset.id}-mode`}
            role="group"
            aria-label="Mode"
            className="grid grid-cols-2 gap-1 rounded-md border border-border bg-surface p-1"
          >
            {(["auto", "ask"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={config.mode === mode}
                onClick={() => patchConfig({ mode })}
                className={cn(
                  "rounded-md px-2 py-1 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  config.mode === mode
                    ? "bg-accent text-accent-fg"
                    : "text-muted-fg hover:bg-elevated hover:text-fg",
                )}
              >
                {mode}
              </button>
            ))}
          </div>
        </Field>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-elevated/40 p-2.5">
        <label htmlFor={`preset-${preset.id}-continue`} className="text-sm text-fg">
          Continue previous session
        </label>
        <button
          id={`preset-${preset.id}-continue`}
          type="button"
          role="switch"
          aria-checked={config.continueSession}
          aria-label="Continue previous session"
          onClick={() => patchConfig({ continueSession: !config.continueSession })}
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
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

      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => void save()} loading={saving} disabled={invalid}>
          Save changes
        </Button>
      </div>

      {confirmDelete ? (
        <Dialog
          open
          onClose={() => {
            if (!deleting) setConfirmDelete(false);
          }}
          disableClose={deleting}
          label={`Delete preset ${preset.name}`}
          className="max-w-sm"
        >
          <h2 className="text-title font-semibold text-fg">Delete “{preset.name}”?</h2>
          <p className="mt-1 text-sm text-muted-fg">
            Existing nodes created from it keep working — they already hold their own config copy;
            their “from preset” badge clears.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Keep preset
            </Button>
            <Button variant="danger" onClick={() => void remove()} loading={deleting}>
              Delete preset
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
