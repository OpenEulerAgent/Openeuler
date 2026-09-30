/** Machine-readable failure codes for {@link DriverError}. */
export type DriverErrorCode =
  | "DRIVER_ALREADY_REGISTERED"
  | "DRIVER_NOT_FOUND"
  | "DRIVER_EVENTS_ALREADY_CONSUMED"
  | "DRIVER_ABORT_FAILED";

/** Typed error thrown by the driver registry and by drivers. */
export class DriverError extends Error {
  readonly code: DriverErrorCode;

  constructor(code: DriverErrorCode, message: string) {
    super(message);
    this.name = "DriverError";
    this.code = code;
    Object.setPrototypeOf(this, DriverError.prototype);
  }
}
