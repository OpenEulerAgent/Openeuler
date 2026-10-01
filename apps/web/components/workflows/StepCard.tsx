"use client";

import { useEffect, useRef, useState } from "react";
import {
  TEMPLATE_VARIABLE_TOKENS,
  insertAtCursor,
  renderStepPreview,
  type FieldErrors,
  type StepDraft,
  type StepMode,
} from "@/lib/workflow-builder";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/cn";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-xs text-danger" role="alert">
      {message}
    </p>
  );
}

/**
 * One step in the editor: identity fields, driver/model/mode/agent, prompt
 * template with insert-variable buttons (at the textarea cursor) and a live
 * rendered preview for the sample task.
 */
export function StepCard({
  index,
  total,
  step,
  errors,
  drivers,
  sampleTask,
  onPatch,
  onRemove,
  onMove,
}: {
  index: number;
  total: number;
  step: StepDraft;
  errors: FieldErrors;
  drivers: readonly string[];
  sampleTask: string;
  onPatch: (patch: Partial<Omit<StepDraft, "id">>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const pendingCursor = useRef<number | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  // Restore the cursor after an insert-variable button re-renders the textarea.
  useEffect(() => {
    if (pendingCursor.current === null) return;
    promptRef.current?.setSelectionRange(pendingCursor.current, pendingCursor.current);
    promptRef.current?.focus();
    pendingCursor.current = null;
  }, [step.promptTemplate]);

  const insertVariable = (token: string): void => {
    const cursor = promptRef.current?.selectionStart ?? step.promptTemplate.length;
    const result = insertAtCursor(step.promptTemplate, token, cursor);
    pendingCursor.current = result.cursor;
    onPatch({ promptTemplate: result.text });
  };

  const preview = showPreview ? renderStepPreview(step.promptTemplate, sampleTask) : undefined;
  const error = (field: keyof Omit<StepDraft, "id">): string | undefined =>
    errors[`steps.${index}.${field}`];

  return (
    <section
      aria-label={`Step ${index + 1}${step.name ? `: ${step.name}` : ""}`}
      className="rounded-lg border border-border bg-elevated/40 p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">
          <span className="mr-2 inline-flex size-5 items-center justify-center rounded-full bg-accent font-mono text-xs text-accent-fg">
            {index + 1}
          </span>
          {step.name || <span className="text-muted-fg">Untitled step</span>}
        </h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={`Move step ${index + 1} up`}
            title="Move up"
          >
            ↑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label={`Move step ${index + 1} down`}
            title="Move down"
          >
            ↓
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-danger hover:bg-danger-subtle hover:text-danger"
            onClick={onRemove}
            disabled={total <= 1}
            aria-label={`Remove step ${index + 1}`}
            title="Remove step"
          >
            Remove
          </Button>
        </div>
      </header>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium text-fg">
          Name
          <Input
            type="text"
            value={step.name}
            invalid={error("name") !== undefined}
            onChange={(event) => onPatch({ name: event.target.value })}
            placeholder="e.g. implement"
          />
          <FieldError message={error("name")} />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-fg">
          Driver
          <Select
            value={step.driver}
            invalid={error("driver") !== undefined}
            onChange={(event) => onPatch({ driver: event.target.value })}
          >
            {[...new Set(drivers.includes(step.driver) ? drivers : [step.driver, ...drivers])].map(
              (id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ),
            )}
          </Select>
          <FieldError message={error("driver")} />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-fg">
          Model <span className="font-normal text-muted-fg">(optional)</span>
          <Input
            type="text"
            value={step.model}
            onChange={(event) => onPatch({ model: event.target.value })}
            placeholder="provider/model"
          />
        </label>

        <div className="flex flex-col gap-1 text-sm font-medium text-fg">
          Mode
          <div
            role="group"
            aria-label="Step mode"
            className="flex overflow-hidden rounded-md border border-border shadow-1"
          >
            {(["auto", "ask"] as const).map((mode: StepMode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={step.mode === mode}
                onClick={() => onPatch({ mode })}
                className={cn(
                  "flex-1 px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  step.mode === mode
                    ? "bg-accent text-accent-fg"
                    : "bg-surface text-muted-fg hover:bg-elevated hover:text-fg",
                )}
              >
                {mode === "auto" ? "auto (yolo)" : "ask"}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1 text-sm font-medium text-fg">
          Agent <span className="font-normal text-muted-fg">(optional)</span>
          <Input
            type="text"
            value={step.agent}
            onChange={(event) => onPatch({ agent: event.target.value })}
            placeholder="e.g. build"
          />
        </label>

        <label className="flex items-center gap-2 self-end pb-1.5 text-sm font-medium text-fg">
          <input
            type="checkbox"
            checked={step.continueSession}
            onChange={(event) => onPatch({ continueSession: event.target.checked })}
            className="size-4 rounded border-border accent-[var(--accent)]"
          />
          Continue previous session
        </label>
      </div>

      <div className="mt-3 flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-fg">Prompt template</span>
          <div className="flex flex-wrap items-center gap-1">
            {TEMPLATE_VARIABLE_TOKENS.map((token) => (
              <button
                key={token}
                type="button"
                onClick={() => insertVariable(token)}
                className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-xs text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {token}
              </button>
            ))}
            <button
              type="button"
              aria-expanded={showPreview}
              onClick={() => setShowPreview((value) => !value)}
              className="rounded px-1.5 py-0.5 text-xs font-medium text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {showPreview ? "Hide preview" : "Preview"}
            </button>
          </div>
        </div>
        <Textarea
          ref={promptRef}
          rows={4}
          value={step.promptTemplate}
          onChange={(event) => onPatch({ promptTemplate: event.target.value })}
          placeholder={`e.g. Implement this task:\n{{task}}`}
          className={cn("font-mono", error("promptTemplate") !== undefined && "border-danger")}
        />
        <FieldError message={error("promptTemplate")} />
      </div>

      {showPreview ? (
        <div
          className="mt-3 rounded-md border border-border bg-surface p-3"
          data-testid="prompt-preview"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-muted-fg">Sample task</p>
          <p className="mt-0.5 text-sm text-fg">
            {sampleTask || <span className="text-muted-fg">(empty)</span>}
          </p>
          {preview?.error ? (
            <p className="mt-2 text-xs text-danger" role="alert">
              {preview.error}
            </p>
          ) : (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-elevated p-2 font-mono text-xs text-fg">
              {preview?.text}
            </pre>
          )}
        </div>
      ) : null}
    </section>
  );
}
