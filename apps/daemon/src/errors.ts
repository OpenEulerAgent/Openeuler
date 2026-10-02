export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * Structured payload serialized into the error body's `details` field
   * (e.g. `REVISION_CONFLICT` carries `currentRevision`, #76). Zod 422s keep
   * building their array-shaped details in the app error handler instead.
   */
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
