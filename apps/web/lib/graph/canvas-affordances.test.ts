import { describe, expect, it } from "vitest";
import {
  MINIMAP_NODE_THRESHOLD,
  selectionModeReducer,
  shouldShowMiniMap,
  type SelectionMode,
} from "./canvas-affordances";

describe("shouldShowMiniMap threshold (#75)", () => {
  it("threshold is 8 nodes", () => {
    expect(MINIMAP_NODE_THRESHOLD).toBe(8);
  });

  it("hides below the threshold", () => {
    expect(shouldShowMiniMap(0)).toBe(false);
    expect(shouldShowMiniMap(1)).toBe(false);
    expect(shouldShowMiniMap(7)).toBe(false);
  });

  it("shows at and above the threshold", () => {
    expect(shouldShowMiniMap(8)).toBe(true);
    expect(shouldShowMiniMap(12)).toBe(true);
    expect(shouldShowMiniMap(120)).toBe(true);
  });
});

describe("selectionModeReducer marquee toggle (#75)", () => {
  it("starts on pan; toggle flips to marquee and back", () => {
    expect(selectionModeReducer("pan", { type: "toggle" })).toBe("marquee");
    expect(selectionModeReducer("marquee", { type: "toggle" })).toBe("pan");
  });

  it("reset always lands on pan, from either mode", () => {
    expect(selectionModeReducer("pan", { type: "reset" })).toBe("pan");
    expect(selectionModeReducer("marquee", { type: "reset" })).toBe("pan");
  });

  it("toggling out and back is idempotent around reset", () => {
    let mode: SelectionMode = "pan";
    mode = selectionModeReducer(mode, { type: "toggle" });
    expect(mode).toBe("marquee");
    mode = selectionModeReducer(mode, { type: "reset" });
    expect(mode).toBe("pan");
    mode = selectionModeReducer(mode, { type: "reset" });
    expect(mode).toBe("pan");
  });
});
