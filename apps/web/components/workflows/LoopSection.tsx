"use client";

import {
  CONDITION_TYPES,
  MAX_LOOP_ITERATIONS,
  regexIssue,
  type FieldErrors,
  type LoopDraft,
} from "@/lib/workflow-builder";
import { Input, Select } from "@/components/ui/input";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-xs text-danger" role="alert">
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
      className="rounded-lg border border-border bg-surface p-4"
      aria-label="Loop configuration"
    >
      <header className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-fg">Loop back</h3>
          <p className="text-xs text-muted-fg">
            Re-run from an earlier step while the condition holds, up to a bounded number of passes.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium text-fg">
          <input
            type="checkbox"
            checked={loop.enabled}
            onChange={(event) => onToggle(event.target.checked)}
            className="size-4 rounded border-border accent-[var(--accent)]"
          />
          Enabled
        </label>
      </header>

      {loop.enabled ? (
        stepNames.length < 2 ? (
          <p className="mt-3 rounded-md border border-warning/40 bg-warning-subtle p-2 text-xs text-warning">
            Add at least two steps before configuring a loop back.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium text-fg">
              Jump back to step
              <Select
                value={loop.toStepIndex}
                invalid={errors["loopBack.toStepIndex"] !== undefined}
                onChange={(event) => onPatch({ toStepIndex: Number(event.target.value) })}
              >
                {stepNames.slice(1).map((name, offset) => (
                  <option key={offset + 1} value={offset + 1}>
                    {offset + 2}. {name}
                  </option>
                ))}
              </Select>
              <FieldError message={errors["loopBack.toStepIndex"]} />
            </label>

            <label className="flex flex-col gap-1 text-sm font-medium text-fg">
              Loop while
              <Select
                value={loop.conditionType}
                onChange={(event) =>
                  onPatch({ conditionType: event.target.value as LoopDraft["conditionType"] })
                }
              >
                {CONDITION_TYPES.map((condition) => (
                  <option key={condition.id} value={condition.id}>
                    {condition.label}
                  </option>
                ))}
              </Select>
              <FieldError message={errors["loopBack.when"]} />
            </label>

            {loop.conditionType === "outputContains" ||
            loop.conditionType === "outputNotContains" ? (
              <label className="flex flex-col gap-1 text-sm font-medium text-fg">
                Substring
                <Input
                  type="text"
                  value={loop.pattern}
                  invalid={errors["loopBack.when.pattern"] !== undefined}
                  onChange={(event) => onPatch({ pattern: event.target.value })}
                  placeholder="e.g. LGTM"
                />
                <FieldError message={errors["loopBack.when.pattern"]} />
              </label>
            ) : null}

            {loop.conditionType === "outputMatches" ? (
              <>
                <label className="flex flex-col gap-1 text-sm font-medium text-fg">
                  Regular expression
                  <Input
                    type="text"
                    value={loop.regex}
                    invalid={liveRegexIssue !== null || errors["loopBack.when.regex"] !== undefined}
                    onChange={(event) => onPatch({ regex: event.target.value })}
                    placeholder="e.g. lgtm|approved"
                  />
                  {liveRegexIssue ? (
                    <p className="text-xs text-danger" role="alert">
                      {liveRegexIssue}
                    </p>
                  ) : (
                    <span className="text-xs text-success">Compiles as a regex ✓</span>
                  )}
                  <FieldError message={errors["loopBack.when.regex"]} />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium text-fg">
                  Regex flags <span className="font-normal text-muted-fg">(optional)</span>
                  <Input
                    type="text"
                    value={loop.regexFlags}
                    invalid={errors["loopBack.when.flags"] !== undefined}
                    onChange={(event) => onPatch({ regexFlags: event.target.value })}
                    placeholder="e.g. gi"
                  />
                  <FieldError message={errors["loopBack.when.flags"]} />
                </label>
              </>
            ) : null}

            <label className="flex flex-col gap-1 text-sm font-medium text-fg">
              Max iterations <span className="font-normal text-muted-fg">(hard cap 25)</span>
              <Input
                type="number"
                min={1}
                max={MAX_LOOP_ITERATIONS}
                value={Number.isFinite(loop.maxIterations) ? loop.maxIterations : ""}
                invalid={errors["loopBack.maxIterations"] !== undefined}
                onChange={(event) =>
                  onPatch({
                    maxIterations:
                      event.target.value.length === 0 ? Number.NaN : Number(event.target.value),
                  })
                }
              />
              <FieldError message={errors["loopBack.maxIterations"]} />
            </label>
          </div>
        )
      ) : null}
    </section>
  );
}
