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
import { cn } from "@/lib/cn";

const inputClass =
  "rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-xs text-red-600" role="alert">
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
      className="rounded-lg border border-slate-200 bg-slate-50/60 p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">
          <span className="mr-2 inline-flex size-5 items-center justify-center rounded-full bg-slate-900 font-mono text-xs text-white">
            {index + 1}
          </span>
          {step.name || <span className="text-slate-400">Untitled step</span>}
        </h3>
        <div className="flex items-center gap-1">
          <Buttonish
            onClick={() => onMove(-1)}
            disabled={index === 0}
            label="Move up"
            aria-label={`Move step ${index + 1} up`}
          >
            ↑
          </Buttonish>
          <Buttonish
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            label="Move down"
            aria-label={`Move step ${index + 1} down`}
          >
            ↓
          </Buttonish>
          <Buttonish
            onClick={onRemove}
            disabled={total <= 1}
            label="Remove step"
            aria-label={`Remove step ${index + 1}`}
            danger
          >
            Remove
          </Buttonish>
        </div>
      </header>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Name
          <input
            type="text"
            value={step.name}
            onChange={(event) => onPatch({ name: event.target.value })}
            placeholder="e.g. implement"
            className={cn(inputClass, error("name") && "border-red-400")}
          />
          <FieldError message={error("name")} />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Driver
          <select
            value={step.driver}
            onChange={(event) => onPatch({ driver: event.target.value })}
            className={cn(inputClass, error("driver") && "border-red-400")}
          >
            {[...new Set(drivers.includes(step.driver) ? drivers : [step.driver, ...drivers])].map(
              (id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ),
            )}
          </select>
          <FieldError message={error("driver")} />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Model <span className="font-normal text-slate-400">(optional)</span>
          <input
            type="text"
            value={step.model}
            onChange={(event) => onPatch({ model: event.target.value })}
            placeholder="provider/model"
            className={inputClass}
          />
        </label>

        <div className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Mode
          <div className="flex overflow-hidden rounded-md border border-slate-300 shadow-sm">
            {(["auto", "ask"] as const).map((mode: StepMode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={step.mode === mode}
                onClick={() => onPatch({ mode })}
                className={cn(
                  "flex-1 px-3 py-1.5 text-sm font-medium transition-colors",
                  step.mode === mode
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-100",
                )}
              >
                {mode === "auto" ? "auto (yolo)" : "ask"}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Agent <span className="font-normal text-slate-400">(optional)</span>
          <input
            type="text"
            value={step.agent}
            onChange={(event) => onPatch({ agent: event.target.value })}
            placeholder="e.g. build"
            className={inputClass}
          />
        </label>

        <label className="flex items-center gap-2 self-end pb-1.5 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={step.continueSession}
            onChange={(event) => onPatch({ continueSession: event.target.checked })}
            className="size-4 rounded border-slate-300"
          />
          Continue previous session
        </label>
      </div>

      <div className="mt-3 flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-slate-700">Prompt template</span>
          <div className="flex flex-wrap items-center gap-1">
            {TEMPLATE_VARIABLE_TOKENS.map((token) => (
              <button
                key={token}
                type="button"
                onClick={() => insertVariable(token)}
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-xs text-slate-600 hover:bg-slate-100"
              >
                {token}
              </button>
            ))}
            <button
              type="button"
              aria-expanded={showPreview}
              onClick={() => setShowPreview((value) => !value)}
              className="rounded px-1.5 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              {showPreview ? "Hide preview" : "Preview"}
            </button>
          </div>
        </div>
        <textarea
          ref={promptRef}
          rows={4}
          value={step.promptTemplate}
          onChange={(event) => onPatch({ promptTemplate: event.target.value })}
          placeholder={`e.g. Implement this task:\n{{task}}`}
          className={cn(
            "rounded-md border border-slate-300 p-2 font-mono text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none",
            error("promptTemplate") && "border-red-400",
          )}
        />
        <FieldError message={error("promptTemplate")} />
      </div>

      {showPreview ? (
        <div
          className="mt-3 rounded-md border border-slate-200 bg-white p-3"
          data-testid="prompt-preview"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Sample task</p>
          <p className="mt-0.5 text-sm text-slate-700">
            {sampleTask || <span className="text-slate-400">(empty)</span>}
          </p>
          {preview?.error ? (
            <p className="mt-2 text-xs text-red-600" role="alert">
              {preview.error}
            </p>
          ) : (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-xs text-slate-700">
              {preview?.text}
            </pre>
          )}
        </div>
      ) : null}
    </section>
  );
}

function Buttonish({
  onClick,
  disabled,
  label,
  danger,
  children,
  ...aria
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  danger?: boolean;
  children: React.ReactNode;
} & Record<"aria-label", string>) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        danger ? "text-red-600 hover:bg-red-50" : "text-slate-600 hover:bg-slate-100",
      )}
      {...aria}
    >
      {children}
    </button>
  );
}
