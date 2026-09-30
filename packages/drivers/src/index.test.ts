import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, PLACEHOLDER_DRIVERS, listDriverIds } from "./index.js";

describe(PACKAGE_NAME, () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@openeuler/drivers");
  });

  it("ships a frozen placeholder driver registry", () => {
    expect(Object.isFrozen(PLACEHOLDER_DRIVERS)).toBe(true);
    expect(PLACEHOLDER_DRIVERS.length).toBeGreaterThan(0);
  });

  it("lists driver ids", () => {
    expect(listDriverIds()).toEqual(["placeholder"]);
  });
});
