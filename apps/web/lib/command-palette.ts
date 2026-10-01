/**
 * Command palette (⌘K) model + state machine (issue #50).
 *
 * The palette is a pure reducer over `{open, query, selectedIndex}` plus a
 * flat item list with actions; the component (components/shell/CommandPalette)
 * supplies data fetching and dispatches side effects through
 * {@link PaletteContext}, which keeps the whole thing unit-testable with a
 * mocked router.
 */
import { fuzzyMatch } from "./fuzzy";

/** Groups in canonical display order. */
export const PALETTE_GROUPS = ["Actions", "Pages", "Projects", "Runs"] as const;

export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

export interface PaletteContext {
  /** Mockable in tests; `router.push` is the only method used. */
  router: { push: (path: string) => void };
  /** Close the palette (usually dispatched alongside the action). */
  close: () => void;
  /** Project id extracted from the current route, when on /projects/:id/*. */
  projectId: string | null;
  /** Abort a running run (POST /api/runs/:id/abort is wired in the component). */
  stopRun: (runId: string) => void;
}

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  /** Secondary text (e.g. path or branch). */
  hint?: string;
  /** Extra fuzzy-match targets beyond label + hint. */
  keywords?: string;
  /** Destructive items (stop run): first activation arms, second fires. */
  requiresConfirm?: boolean;
  /** Execute the item; receives the mockable context. */
  run: (context: PaletteContext) => void;
}

export interface PaletteState {
  open: boolean;
  query: string;
  selectedIndex: number;
  /** Id of the item awaiting its second activation (two-step confirm). */
  confirmId: string | null;
}

export type PaletteAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "toggle" }
  | { type: "query"; value: string }
  | { type: "move"; delta: number; count: number }
  | { type: "arm"; id: string };

export const INITIAL_PALETTE_STATE: PaletteState = {
  open: false,
  query: "",
  selectedIndex: 0,
  confirmId: null,
};

/**
 * State machine: open/toggle flip visibility (and reset query+selection);
 * typing resets selection to the top; move wraps in both directions. `arm`
 * starts the two-step confirm for a destructive item; every other action
 * (including typing and moving — "any other key") cancels it.
 */
export function paletteReducer(state: PaletteState, action: PaletteAction): PaletteState {
  switch (action.type) {
    case "open":
      return { open: true, query: "", selectedIndex: 0, confirmId: null };
    case "close":
      return { ...state, open: false, confirmId: null };
    case "toggle":
      return { ...state, open: !state.open, query: "", selectedIndex: 0, confirmId: null };
    case "query":
      return { ...state, query: action.value, selectedIndex: 0, confirmId: null };
    case "move": {
      if (!state.open || action.count <= 0) return state;
      // Wrap in both directions so ArrowUp from the top reaches the bottom.
      const next = (state.selectedIndex + action.delta + action.count) % action.count;
      return { ...state, selectedIndex: next, confirmId: null };
    }
    case "arm":
      if (!state.open) return state;
      return { ...state, confirmId: action.id };
  }
}

/** Two-step confirm decision for activating an item: arm first or fire. */
export function confirmOutcome(item: PaletteItem, confirmId: string | null): "arm" | "run" {
  return item.requiresConfirm && confirmId !== item.id ? "arm" : "run";
}

/** Fuzzy-match one item against the query using label + hint + keywords. */
export function matchItem(item: PaletteItem, query: string): { score: number } | null {
  if (query.length === 0) return { score: 0 };
  const targets = [item.label, item.hint ?? "", item.keywords ?? ""];
  let best: { score: number } | null = null;
  for (const target of targets) {
    if (target.length === 0) continue;
    const match = fuzzyMatch(query, target);
    if (match && (best === null || match.score > best.score)) best = match;
  }
  return best;
}

/**
 * Filter items by query (empty query → all items in canonical order) and
 * group them for display: best score first within the section pass, groups in
 * {@link PALETTE_GROUPS} order.
 */
export function filterPaletteItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  if (query.length === 0) {
    return [...items].sort(
      (a, b) => PALETTE_GROUPS.indexOf(a.group) - PALETTE_GROUPS.indexOf(b.group),
    );
  }
  return items
    .map((item, index) => ({ item, index, match: matchItem(item, query) }))
    .filter(
      (entry): entry is { item: PaletteItem; index: number; match: { score: number } } =>
        entry.match !== null,
    )
    .sort((a, b) => b.match.score - a.match.score || a.index - b.index)
    .map((entry) => entry.item);
}

/** Clamp the selected index into [0, count-1] (count 0 → -1 = nothing). */
export function clampSelection(index: number, count: number): number {
  if (count <= 0) return -1;
  return Math.max(0, Math.min(index, count - 1));
}

/**
 * The "enter" transition: which item does the current state select, if any?
 * Pure — the component performs `item.run(context)`.
 */
export function selectedPaletteItem(
  state: PaletteState,
  items: readonly PaletteItem[],
): PaletteItem | null {
  const filtered = filterPaletteItems(items, state.query);
  const index = clampSelection(state.selectedIndex, filtered.length);
  return index === -1 ? null : (filtered[index] ?? null);
}

/** Group consecutive items for sectioned rendering. */
export function groupPaletteItems(
  items: readonly PaletteItem[],
): Array<{ group: PaletteGroup; items: PaletteItem[] }> {
  const sections: Array<{ group: PaletteGroup; items: PaletteItem[] }> = [];
  for (const group of PALETTE_GROUPS) {
    const groupItems = items.filter((item) => item.group === group);
    if (groupItems.length > 0) sections.push({ group, items: groupItems });
  }
  return sections;
}
