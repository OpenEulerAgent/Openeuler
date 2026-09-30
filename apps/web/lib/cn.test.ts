import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("joins truthy class names with single spaces", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("drops falsy parts", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("returns an empty string when nothing is truthy", () => {
    expect(cn()).toBe("");
    expect(cn(false, null, undefined, "")).toBe("");
  });
});
