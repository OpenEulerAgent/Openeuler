import { describe, expect, it } from "vitest";
import { nextFocusTarget } from "./focus-trap";

const a = {} as HTMLElement;
const b = {} as HTMLElement;
const c = {} as HTMLElement;

describe("nextFocusTarget", () => {
  it("returns null when nothing is focusable", () => {
    expect(nextFocusTarget([], a, false)).toBeNull();
    expect(nextFocusTarget([], null, true)).toBeNull();
  });

  it("Tab from the last element wraps to the first", () => {
    expect(nextFocusTarget([a, b, c], c, false)).toBe(a);
  });

  it("Shift+Tab from the first element wraps to the last", () => {
    expect(nextFocusTarget([a, b, c], a, true)).toBe(c);
  });

  it("moves forward and backward inside the list", () => {
    expect(nextFocusTarget([a, b, c], a, false)).toBe(b);
    expect(nextFocusTarget([a, b, c], b, false)).toBe(c);
    expect(nextFocusTarget([a, b, c], c, true)).toBe(b);
    expect(nextFocusTarget([a, b, c], b, true)).toBe(a);
  });

  it("pulls focus into the trap when it lives outside", () => {
    const outside = {} as HTMLElement;
    expect(nextFocusTarget([a, b, c], outside, false)).toBe(a);
    expect(nextFocusTarget([a, b, c], outside, true)).toBe(c);
    expect(nextFocusTarget([a, b, c], null, false)).toBe(a);
  });

  it("handles a single focusable element", () => {
    expect(nextFocusTarget([a], a, false)).toBe(a);
    expect(nextFocusTarget([a], a, true)).toBe(a);
  });
});
