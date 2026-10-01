/**
 * Focus-trap helper for modal primitives (Dialog/Drawer, issue #50).
 * Kept as pure functions over element lists so it is testable without a DOM.
 */

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Index of `active` inside `elements` (-1 when absent). Identity comparison
 * plus a defensive `===` on a `document.activeElement`-like object.
 */
export function activeIndex(elements: readonly HTMLElement[], active: unknown): number {
  return elements.indexOf(active as HTMLElement);
}

/**
 * Which element should receive focus for a Tab/Shift+Tab inside a trap?
 * Wraps at both ends; returns null when there is nothing focusable.
 */
export function nextFocusTarget(
  elements: readonly HTMLElement[],
  active: unknown,
  shift: boolean,
): HTMLElement | null {
  if (elements.length === 0) return null;
  const current = activeIndex(elements, active);
  if (current === -1) {
    // Focus is outside the trap (or on the container): go to first/last.
    return shift ? (elements[elements.length - 1] as HTMLElement) : (elements[0] as HTMLElement);
  }
  const next = shift
    ? (current - 1 + elements.length) % elements.length
    : (current + 1) % elements.length;
  return elements[next] ?? null;
}
