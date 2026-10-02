/** Machine-readable failure codes for {@link SandboxError}. */
export type SandboxErrorCode =
  | "SANDBOX_PROVIDER_NOT_FOUND"
  | "SANDBOX_ALREADY_REGISTERED"
  | "SANDBOX_EXEC_FAILED"
  | "SANDBOX_TIMEOUT"
  | "SANDBOX_IMAGE_MISSING"
  | "SANDBOX_UNAVAILABLE"
  | "SANDBOX_STOP_FAILED";

/** Typed error thrown by the sandbox registry and by sandbox providers. */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
    Object.setPrototypeOf(this, SandboxError.prototype);
  }
}
