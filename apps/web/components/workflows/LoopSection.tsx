"use client";

import {
  CONDITION_TYPES,
  MAX_LOOP_ITERATIONS,
  regexIssue,
  type FieldErrors,
  type LoopDraft,
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
 * Loop-back configuration: enable toggle, target step (steps after the first),
 * condition builder (type + pattern/regex with live regex feedback) and the
 * iteration budget (hard cap 25).
 */
export function LoopSection({
  loop,
  stepNames,
  errors,
  onPatch,
  onToggle,
}: {
  loop: LoopDraft;
  stepNames: readonly string[];
  errors: FieldErrors;
  onPatch: (patch: Partial<LoopDraft>) => void;
  onToggle: (enabled: boolean) => void;
}) {
  const liveRegexIssue =
    loop.conditionType === "outputMatches" && loop.regex.length > 0
      ? regexIssue(loop.regex, loop.regexFlags)
      : null;

  return (
    <section
      className="rounded-lg border border-slate-200 bg-white p-4"
      aria-label="Loop configuration"
    >
      <header className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Loop back</h3>
          <p className="text-xs text-slate-500">
            Re-run from an earlier step while the condition holds, up to a bounded number of passes.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={loop.enabled}
            onChange={(event) => onToggle(event.target.checked)}
            className="size-4 rounded border-slate-300"
          />
          Enabled
        </label>
      </header>

      {loop.enabled ? (
        stepNames.length < 2 ? (
          <p className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-700">
            Add at least two steps before configuring a loop back.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Jump back to step
              <select
                value={loop.toStepIndex}
                onChange={(event) => onPatch({ toStepIndex: Number(event.target.value) })}
                className={cn(inputClass, errors["loopBack.toStepIndex"] && "border-red-400")}
              >
                {stepNames.slice(1).map((name, offset) => (
                  <option key={offset + 1} value={offset + 1}>
                    {offset + 2}. {name}
                  </option>
                ))}
              </select>
              <FieldError message={errors["loopBack.toStepIndex"]} />
            </label>

            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Loop while
              <select
                value={loop.conditionType}
                onChange={(event) =>
                  onPatch({ conditionType: event.target.value as LoopDraft["conditionType"] })
                }
                className={inputClass}
              >
                {CONDITION_TYPES.map((condition) => (
                  <option key={condition.id} value={condition.id}>
                    {condition.label}
                  </option>
                ))}
              </select>
              <FieldError message={errors["loopBack.when"]} />
            </label>

            {loop.conditionType === "outputContains" ||
            loop.conditionType === "outputNotContains" ? (
              <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
                Substring
                <input
                  type="text"
                  value={loop.pattern}
                  onChange={(event) => onPatch({ pattern: event.target.value })}
                  placeholder="e.g. LGTM"
                  className={cn(inputClass, errors["loopBack.when.pattern"] && "border-red-400")}
                />
                <FieldError message={errors["loopBack.when.pattern"]} />
              </label>
            ) : null}

            {loop.conditionType === "outputMatches" ? (
              <>
                <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
                  Regular expression
                  <input
                    type="text"
                    value={loop.regex}
                    onChange={(event) => onPatch({ regex: event.target.value })}
                    placeholder="e.g. (?i)lgtm|approved"
                    className={cn(
                      inputClass,
                      (liveRegexIssue || errors["loopBack.when.regex"]) && "border-red-400",
                    )}
                  />
                  {liveRegexIssue ? (
                    <p className="text-xs text-red-600" role="alert">
                      {liveRegexIssue}
                    </p>
                  ) : (
                    <span className="text-xs text-emerald-600">Compiles as a regex ✓</span>
                  )}
                  <FieldError message={errors["loopBack.when.regex"]} />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
                  Regex flags <span className="font-normal text-slate-400">(optional)</span>
                  <input
                    type="text"
                    value={loop.regexFlags}
                    onChange={(event) => onPatch({ regexFlags: event.target.value })}
                    placeholder="e.g. gi"
                    className={cn(inputClass, errors["loopBack.when.flags"] && "border-red-400")}
                  />
                  <FieldError message={errors["loopBack.when.flags"]} />
                </label>
              </>
            ) : null}

            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Max iterations <span className="font-normal text-slate-400">(hard cap 25)</span>
              <input
                type="number"
                min={1}
                max={MAX_LOOP_ITERATIONS}
                value={Number.isFinite(loop.maxIterations) ? loop.maxIterations : ""}
                onChange={(event) =>
                  onPatch({
                    maxIterations:
                      event.target.value.length === 0 ? Number.NaN : Number(event.target.value),
                  })
                }
                className={cn(inputClass, errors["loopBack.maxIterations"] && "border-red-400")}
              />
              <FieldError message={errors["loopBack.maxIterations"]} />
            </label>
          </div>
        )
      ) : null}
    </section>
  );
}
