/**
 * Pure canvas-affordance helpers (#75): when the minimap earns its space,
 * and the marquee-selection mode toggle behind the toolbar's "Select area"
 * button. Browser-free so both are trivially unit-testable; the editor
 * only wires them into React Flow props.
 */

/** Graphs at or above this node count get a minimap; smaller ones stay
 *  uncluttered (the whole graph already fits the viewport). */
export const MINIMAP_NODE_THRESHOLD = 8;

/** Pure decision: does a graph of `nodeCount` nodes warrant the minimap? */
export function shouldShowMiniMap(nodeCount: number): boolean {
  return nodeCount >= MINIMAP_NODE_THRESHOLD;
}

/** "pan" — default pointer behavior (drag pans the canvas). "marquee" —
 *  dragging paints a selection box instead. */
export type SelectionMode = "pan" | "marquee";

export type SelectionModeAction = { type: "toggle" } | { type: "reset" };

/**
 * Pure reducer for the marquee toggle: `toggle` flips between pan and
 * marquee; `reset` (Escape, or leaving the canvas) always lands back on
 * pan — Escape must never leave the user stuck painting selection boxes.
 */
export function selectionModeReducer(
  state: SelectionMode,
  action: SelectionModeAction,
): SelectionMode {
  if (action.type === "reset") return "pan";
  return state === "pan" ? "marquee" : "pan";
}
