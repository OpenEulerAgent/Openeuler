export const PACKAGE_NAME = "@openeuler/drivers";

export type {
  AgentDriver,
  AgentExit,
  AgentExitReason,
  AgentHandle,
  AgentMode,
  AgentStartOpts,
} from "./types.js";

export { DriverError } from "./error.js";
export type { DriverErrorCode } from "./error.js";

export {
  createDriverRegistry,
  defaultDriverRegistry,
  getDriver,
  listDrivers,
  registerDriver,
} from "./registry.js";
export type { DriverRegistry } from "./registry.js";

export { createFakeDriver, FakeDriver } from "./fake.js";
export type { FakeDriverOptions } from "./fake.js";
