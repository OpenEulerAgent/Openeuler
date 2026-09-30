import { describe, expect, it, vi } from "vitest";
import { DriverError } from "./error.js";
import { createDriverRegistry } from "./registry.js";
import type { AgentDriver } from "./types.js";

function stubDriver(id: string): AgentDriver {
  return {
    id,
    start: () => {
      throw new Error("not implemented");
    },
  };
}

describe("createDriverRegistry", () => {
  it("registers and looks up drivers", () => {
    const registry = createDriverRegistry();
    const fake = stubDriver("fake");
    registry.registerDriver(fake);
    expect(registry.getDriver("fake")).toBe(fake);
  });

  it("lists drivers in registration order", () => {
    const registry = createDriverRegistry();
    const first = stubDriver("first");
    const second = stubDriver("second");
    registry.registerDriver(first);
    registry.registerDriver(second);
    expect(registry.listDrivers()).toEqual([first, second]);
    // The returned list is a copy; mutating it must not affect the registry.
    registry.listDrivers().pop();
    expect(registry.listDrivers()).toEqual([first, second]);
  });

  it("starts empty", () => {
    expect(createDriverRegistry().listDrivers()).toEqual([]);
  });

  it("rejects duplicate ids with a typed DriverError", () => {
    const registry = createDriverRegistry();
    registry.registerDriver(stubDriver("opencode"));
    let caught: unknown;
    try {
      registry.registerDriver(stubDriver("opencode"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DriverError);
    expect(caught).toMatchObject({ code: "DRIVER_ALREADY_REGISTERED" });
    expect((caught as DriverError).message).toContain("opencode");
    // The original driver stays registered.
    expect(registry.getDriver("opencode").id).toBe("opencode");
    expect(registry.listDrivers().length).toBe(1);
  });

  it("throws a typed DriverError for unknown ids", () => {
    const registry = createDriverRegistry();
    let caught: unknown;
    try {
      registry.getDriver("does-not-exist");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DriverError);
    expect(caught).toMatchObject({ code: "DRIVER_NOT_FOUND" });
    expect((caught as DriverError).message).toContain("does-not-exist");
  });
});

describe("default registry helpers", () => {
  it("registerDriver/getDriver/listDrivers operate on a shared default registry", async () => {
    vi.resetModules();
    const registry = await import("./registry.js");
    const driver = stubDriver("default-registry-test");
    registry.registerDriver(driver);
    expect(registry.getDriver("default-registry-test")).toBe(driver);
    expect(registry.listDrivers().map((entry) => entry.id)).toContain("default-registry-test");
    expect(registry.defaultDriverRegistry.getDriver("default-registry-test")).toBe(driver);

    let caught: unknown;
    try {
      registry.registerDriver(stubDriver("default-registry-test"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "DRIVER_ALREADY_REGISTERED" });
  });
});
