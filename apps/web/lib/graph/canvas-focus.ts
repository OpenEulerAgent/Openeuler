/**
 * Pure helpers for canvas add interactions (#72): deciding whether a
 * freshly added node landed outside the visible viewport (so the editor
 * fitViews to it instead of reading as "add didn't work"), and computing
 * the click-to-add drop point from the CANVAS element's screen rect — not
 * the window's, which the 240px palette and the header shift. No React or
 * @xyflow/react imports, like the rest of lib/graph — headless-testable.
 */

/** A screen-space rect (the shape of getBoundingClientRect). */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The visible region expressed in flow coordinates. */
export interface FlowViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** React Flow viewport — structural slice ({x, y, zoom}). */
export interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

/** Center of a screen-space rect (the canvas pane, not the window). */
export function screenRectCenter(rect: ScreenRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** Random offset radius so repeated click-adds don't stack exactly (#72). */
export const CLICK_ADD_JITTER_PX = 40;

/**
 * Rect center in screen coords with a ±`radius` random offset. `rng` is
 * injectable so tests get deterministic jitter; defaults to Math.random.
 */
export function jitteredRectCenter(
  rect: ScreenRect,
  rng: () => number = Math.random,
  radius = CLICK_ADD_JITTER_PX,
): { x: number; y: number } {
  const center = screenRectCenter(rect);
  return {
    x: center.x + (rng() * 2 - 1) * radius,
    y: center.y + (rng() * 2 - 1) * radius,
  };
}

/** -0 → 0 so projected origins compare equal to literal zeros. */
const noNegativeZero = (value: number): number => (value === 0 ? 0 : value);

/**
 * The on-screen rect projected into flow coordinates: panning moves the
 * visible origin, zooming scales both origin and extent.
 */
export function flowViewportBounds(rect: ScreenRect, viewport: FlowViewport): FlowViewportBounds {
  return {
    x: noNegativeZero(-viewport.x / viewport.zoom),
    y: noNegativeZero(-viewport.y / viewport.zoom),
    width: rect.width / viewport.zoom,
    height: rect.height / viewport.zoom,
  };
}

/**
 * Whether a flow-space node position lies outside the visible bounds (#72)
 * — boundary-exact positions count as visible (no needless re-framing).
 */
export function shouldFocusNewNode(
  bounds: FlowViewportBounds,
  nodePosition: { x: number; y: number },
): boolean {
  return (
    nodePosition.x < bounds.x ||
    nodePosition.x > bounds.x + bounds.width ||
    nodePosition.y < bounds.y ||
    nodePosition.y > bounds.y + bounds.height
  );
}
