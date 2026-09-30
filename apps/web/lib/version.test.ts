import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, isReady } from "./version.js";

describe(PACKAGE_NAME, () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@openeuler/web");
  });

  it("is ready", () => {
    expect(isReady()).toBe(true);
  });
});
