import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, failure, success } from "./index.js";

describe(PACKAGE_NAME, () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@openeuler/db");
  });

  it("wraps values in a success result", () => {
    expect(success(42)).toEqual({ ok: true, value: 42 });
  });

  it("wraps errors in a failure result", () => {
    expect(failure("boom")).toEqual({ ok: false, error: "boom" });
  });
});
