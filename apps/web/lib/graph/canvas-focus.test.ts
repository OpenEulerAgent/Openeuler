import { describe, expect, it } from "vitest";
import {
  CLICK_ADD_JITTER_PX,
  flowViewportBounds,
  jitteredRectCenter,
  screenRectCenter,
  shouldFocusNewNode,
} from "./canvas-focus";

// The editor's real layout: 240px palette left of the canvas, 4rem header
// above it — the window center would be ~120px right of the true center.
const canvasRect = { left: 240, top: 64, width: 800, height: 600 };

describe("screenRectCenter (#72)", () => {
  it("centers on the given rect, not the window", () => {
    expect(screenRectCenter(canvasRect)).toEqual({ x: 640, y: 364 });
    expect(screenRectCenter(canvasRect).x).not.toBe(1024 / 2);
  });

  it("handles zero-size rects without NaN", () => {
    expect(screenRectCenter({ left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe("jitteredRectCenter (#72)", () => {
  it("seeds rng 0.5 to the exact center", () => {
    expect(jitteredRectCenter(canvasRect, () => 0.5)).toEqual({ x: 640, y: 364 });
  });

  it("rng 0 → −radius, rng 1 → +radius on both axes", () => {
    expect(jitteredRectCenter(canvasRect, () => 0)).toEqual({
      x: 640 - CLICK_ADD_JITTER_PX,
      y: 364 - CLICK_ADD_JITTER_PX,
    });
    expect(jitteredRectCenter(canvasRect, () => 1)).toEqual({
      x: 640 + CLICK_ADD_JITTER_PX,
      y: 364 + CLICK_ADD_JITTER_PX,
    });
  });

  it("stays within ±radius of the center for any rng", () => {
    for (const r of [0, 0.13, 0.5, 0.77, 1]) {
      const point = jitteredRectCenter(canvasRect, () => r);
      expect(Math.abs(point.x - 640)).toBeLessThanOrEqual(CLICK_ADD_JITTER_PX);
      expect(Math.abs(point.y - 364)).toBeLessThanOrEqual(CLICK_ADD_JITTER_PX);
    }
  });
});

describe("flowViewportBounds (#72)", () => {
  it("identity viewport maps the screen rect to flow coords 1:1", () => {
    expect(flowViewportBounds(canvasRect, { x: 0, y: 0, zoom: 1 })).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("panning shifts the visible flow origin", () => {
    // Panned 2000 right: flow x=2000 is now at the pane's left edge.
    expect(flowViewportBounds(canvasRect, { x: -2000, y: 0, zoom: 1 })).toEqual({
      x: 2000,
      y: 0,
      width: 800,
      height: 600,
    });
    expect(flowViewportBounds(canvasRect, { x: 0, y: -300, zoom: 1 })).toEqual({
      x: 0,
      y: 300,
      width: 800,
      height: 600,
    });
  });

  it("zoom scales origin and extent", () => {
    expect(flowViewportBounds(canvasRect, { x: -800, y: -400, zoom: 2 })).toEqual({
      x: 400,
      y: 200,
      width: 400,
      height: 300,
    });
    expect(flowViewportBounds(canvasRect, { x: -400, y: -200, zoom: 0.5 })).toEqual({
      x: 800,
      y: 400,
      width: 1600,
      height: 1200,
    });
  });
});

describe("shouldFocusNewNode (#72)", () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };

  it("keeps in-view positions untouched", () => {
    expect(shouldFocusNewNode(bounds, { x: 400, y: 300 })).toBe(false);
    expect(shouldFocusNewNode(bounds, { x: 0, y: 0 })).toBe(false);
    expect(shouldFocusNewNode(bounds, { x: 800, y: 600 })).toBe(false);
  });

  it("flags positions outside each edge", () => {
    expect(shouldFocusNewNode(bounds, { x: -1, y: 300 })).toBe(true);
    expect(shouldFocusNewNode(bounds, { x: 801, y: 300 })).toBe(true);
    expect(shouldFocusNewNode(bounds, { x: 400, y: -1 })).toBe(true);
    expect(shouldFocusNewNode(bounds, { x: 400, y: 601 })).toBe(true);
  });

  it("flags far-off auto-placed nodes from both pan directions", () => {
    // Identity viewport shows flow x ∈ [0, 800]: nextCanvasPosition landing
    // at 5280 (rightmost 5000 + 280) is far outside.
    expect(shouldFocusNewNode(bounds, { x: 5280, y: 0 })).toBe(true);
    // Panned 5000 right, the viewport shows [5000, 5800]: a node landing
    // at 360 (the right of the starter graph) is now off-screen.
    const panned = flowViewportBounds(canvasRect, { x: -5000, y: 0, zoom: 1 });
    expect(shouldFocusNewNode(panned, { x: 360, y: 0 })).toBe(true);
    expect(shouldFocusNewNode(panned, { x: 5300, y: 100 })).toBe(false);
  });
});
