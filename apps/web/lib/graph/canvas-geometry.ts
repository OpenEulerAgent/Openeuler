/**
 * Canvas node card geometry (#88): the SINGLE source of truth for the boxes
 * both sides of the canvas must agree on —
 *
 *  - dagre auto-layout (`layout.ts`) reserves exactly these px boxes, and
 *  - the node cards (`canvas-nodes.tsx`) pin the same dimensions through
 *    the Tailwind utilities in {@link CANVAS_NODE_SIZE_CLASSES}.
 *
 * The class strings must stay literal (Tailwind v4 emits only utilities it
 * can statically scan); `canvas-nodes.test.tsx` asserts the px ↔ class
 * agreement (1 spacing unit = 4px) so the pair can never drift silently
 * again — the drift dagre could not see was the phantom-gap/overflow class
 * of bug behind blank and mis-fitted node cards.
 */

/** Rendered node bounding boxes in px (dagre reserves these exactly). */
export const CANVAS_NODE_SIZES = {
  agent: { width: 240, height: 72 },
  exit: { width: 140, height: 64 },
  join: { width: 140, height: 64 },
  subworkflow: { width: 240, height: 72 },
  approval: { width: 240, height: 72 },
} as const;

/** Tailwind utilities pinning the card box to {@link CANVAS_NODE_SIZES}. */
export const CANVAS_NODE_SIZE_CLASSES = {
  agent: { width: "w-60", height: "h-18" },
  exit: { width: "w-35", height: "h-16" },
  join: { width: "w-35", height: "h-16" },
  subworkflow: { width: "w-60", height: "h-18" },
  approval: { width: "w-60", height: "h-18" },
} as const;
