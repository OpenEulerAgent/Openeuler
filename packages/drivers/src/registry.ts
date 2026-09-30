import { DriverError } from "./error.js";
import type { AgentDriver } from "./types.js";

/** Registry of available {@link AgentDriver}s. The daemon composes one at boot. */
export interface DriverRegistry {
  /** Register a driver. Throws `DriverError` (`DRIVER_ALREADY_REGISTERED`) on duplicate ids. */
  registerDriver(driver: AgentDriver): void;
  /** Look up a driver by id. Throws `DriverError` (`DRIVER_NOT_FOUND`) for unknown ids. */
  getDriver(id: string): AgentDriver;
  /** All registered drivers, in registration order. */
  listDrivers(): AgentDriver[];
}

/** Create an independent driver registry. */
export function createDriverRegistry(): DriverRegistry {
  const drivers = new Map<string, AgentDriver>();
  return {
    registerDriver(driver: AgentDriver): void {
      if (drivers.has(driver.id)) {
        throw new DriverError(
          "DRIVER_ALREADY_REGISTERED",
          `driver "${driver.id}" is already registered`,
        );
      }
      drivers.set(driver.id, driver);
    },
    getDriver(id: string): AgentDriver {
      const driver = drivers.get(id);
      if (driver === undefined) {
        throw new DriverError("DRIVER_NOT_FOUND", `no driver registered with id "${id}"`);
      }
      return driver;
    },
    listDrivers(): AgentDriver[] {
      return [...drivers.values()];
    },
  };
}

/** Process-wide default registry, used by the standalone helpers below. */
export const defaultDriverRegistry: DriverRegistry = createDriverRegistry();

/** Register a driver on the default registry. */
export function registerDriver(driver: AgentDriver): void {
  defaultDriverRegistry.registerDriver(driver);
}

/** Look up a driver on the default registry. */
export function getDriver(id: string): AgentDriver {
  return defaultDriverRegistry.getDriver(id);
}

/** List drivers on the default registry, in registration order. */
export function listDrivers(): AgentDriver[] {
  return defaultDriverRegistry.listDrivers();
}
