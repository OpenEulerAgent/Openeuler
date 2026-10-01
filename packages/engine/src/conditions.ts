import type { ExitCondition } from "@openeuler/core";

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Human-readable form of an exit condition, for event details and errors. */
export function describeCondition(when: ExitCondition): string {
  switch (when.type) {
    case "always":
      return "always";
    case "outputContains":
      return `outputContains ${JSON.stringify(when.pattern)}`;
    case "outputNotContains":
      return `outputNotContains ${JSON.stringify(when.pattern)}`;
    case "outputMatches":
      return `outputMatches /${when.regex}/${when.flags ?? ""}`;
  }
}

/**
 * Exit condition evaluation state, compiled once per run so `outputMatches`
 * regexes are a single `new RegExp` per execution.
 */
export interface ExitEvaluator {
  when: ExitCondition;
  /** Pre-compiled regex for `outputMatches` conditions. */
  regex: RegExp | undefined;
}

/**
 * Compiles an exit condition once per run. `outputMatches` regexes are
 * validated at workflow save time; a compile failure here (data that
 * bypassed the schema) is surfaced as a clear error instead of a crash.
 */
export function compileExitCondition(when: ExitCondition, label = ""): ExitEvaluator | Error {
  if (when.type !== "outputMatches") {
    return { when, regex: undefined };
  }
  try {
    return { when, regex: new RegExp(when.regex, when.flags ?? "") };
  } catch (err) {
    return new Error(
      `${label}outputMatches regex ${describeCondition(when)} does not compile: ${describeError(err)}`,
    );
  }
}

/**
 * Evaluates an exit condition against a final output. `always` is trivially
 * true; `outputContains`/`outputNotContains` are substring checks;
 * `outputMatches` uses the pre-compiled regex (the pattern controls its own
 * anchoring via `^`/`$`/`m`). `lastIndex` is reset so `g`/`y` flags cannot
 * make repeated evaluation stateful.
 */
export function evaluateExitCondition(evaluator: ExitEvaluator, output: string): boolean {
  switch (evaluator.when.type) {
    case "always":
      return true;
    case "outputContains":
      return output.includes(evaluator.when.pattern);
    case "outputNotContains":
      return !output.includes(evaluator.when.pattern);
    case "outputMatches": {
      const regex = evaluator.regex;
      if (regex === undefined) return false;
      regex.lastIndex = 0;
      return regex.test(output);
    }
  }
}
