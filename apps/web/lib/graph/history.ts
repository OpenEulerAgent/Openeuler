/**
 * Undo/redo for the canvas editor (#46): a classic two-stack history over
 * immutable document snapshots. Pure and framework-free so the semantics
 * (add/move/connect/delete, no state corruption, redo cleared on new edits)
 * are unit-testable.
 */

export interface History<T> {
  /** Documents you can go back to (oldest first). */
  past: readonly T[];
  present: T;
  /** Documents you can go forward to (oldest first). */
  future: readonly T[];
}

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** Cap on retained undo entries; the oldest fall off. */
export const HISTORY_LIMIT = 100;

/**
 * Records `next` as the new present, pushing the current present onto the
 * past stack and clearing the future (a fresh edit invalidates redos).
 */
export function commit<T>(history: History<T>, next: T): History<T> {
  if (history.present === next) return history;
  const past = [...history.past, history.present];
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    present: next,
    future: [],
  };
}

/**
 * Like {@link commit}, but with an explicit `before`: used when the document
 * already moved through intermediate states (node drags, debounced text
 * edits) that must collapse into one entry — `before` is what lands on the
 * past stack, `next` becomes the present, the intermediates are discarded.
 */
export function commitWithBefore<T>(history: History<T>, before: T, next: T): History<T> {
  if (before === next) return history;
  const past = [...history.past, before];
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    present: next,
    future: [],
  };
}

export interface HistoryStep<T> {
  history: History<T>;
  /** The restored document, or null at an edge of the stack. */
  value: T | null;
}

/** Steps one entry back; the present moves onto the future stack. */
export function undo<T>(history: History<T>): HistoryStep<T> {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return { history, value: null };
  return {
    history: {
      past: history.past.slice(0, -1),
      present: previous,
      future: [history.present, ...history.future],
    },
    value: previous,
  };
}

/** Restores one undone entry. */
export function redo<T>(history: History<T>): HistoryStep<T> {
  const next = history.future[0];
  if (next === undefined) return { history, value: null };
  return {
    history: {
      past: [...history.past, history.present],
      present: next,
      future: history.future.slice(1),
    },
    value: next,
  };
}

/** Replaces the present without recording an entry (external updates, syncs). */
export function replacePresent<T>(history: History<T>, present: T): History<T> {
  return { ...history, present };
}

/** True when at least one more undo/redo step is available. */
export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}
