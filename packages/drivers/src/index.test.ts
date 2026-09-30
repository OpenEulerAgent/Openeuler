import { describe, expect, it } from "vitest";
import {
  PACKAGE_NAME,
  DriverError,
  createDriverRegistry,
  createFakeDriver,
  registerDriver,
  getDriver,
  listDrivers,
} from "./index.js";

describe(PACKAGE_NAME, () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@openeuler/drivers");
  });

  it("exports the public contract", () => {
    expect(typeof createDriverRegistry).toBe("function");
    expect(typeof createFakeDriver).toBe("function");
    expect(typeof registerDriver).toBe("function");
    expect(typeof getDriver).toBe("function");
    expect(typeof listDrivers).toBe("function");
    expect(new DriverError("DRIVER_NOT_FOUND", "missing")).toBeInstanceOf(Error);
  });
});
