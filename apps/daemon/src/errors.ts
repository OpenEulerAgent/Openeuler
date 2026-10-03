export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * Structured payload serialized into the error body's `details` field
   * (e.g. `REVISION_CONFLICT` carries `currentRevision`, #76). Zod 422s keep
   * building their array-shaped details in the app error handler instead;
   * the array shape is accepted for 422s that carry node/edge-attributed
   * findings directly (e.g. sub-workflow reference validation, #117).
   */
  readonly details?: Record<string, unknown> | Array<{ path: string; message: string }>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown> | Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
