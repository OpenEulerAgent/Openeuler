import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, PACKAGE_NAME, nextTick } from "./index.js";

describe(PACKAGE_NAME, () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@openeuler/engine");
  });

  it("reports a semver engine version", () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("advances the tick counter", () => {
    expect(nextTick(41)).toEqual({ tick: 42 });
  });
});
