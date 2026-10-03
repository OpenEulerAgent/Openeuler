import { notifyUnauthorized, setPendingRetry } from "./auth-gate";
import { authorizationHeaderValue, getStoredToken } from "./token";

export const DEFAULT_DAEMON_URL = "http://localhost:8787";

/** One zod validation issue from a daemon 422 response, keyed by field path. */
export interface ApiErrorDetail {
  path: string;
  message: string;
}

/** Normalized error thrown by {@link apiFetch}: every failure path yields one of these. */
export class ApiError extends Error {
  readonly code: string;
  /** HTTP status code; `0` when the daemon could not be reached at all. */
  readonly status: number;
  /** Zod issue details when the daemon answered 422 VALIDATION_ERROR. */
  readonly details?: readonly ApiErrorDetail[];
  /** Current revision named by a 409 REVISION_CONFLICT body (#76). */
  readonly currentRevision?: number;

  constructor(
    code: string,
    message: string,
    status: number,
    options?: { cause?: unknown; details?: readonly ApiErrorDetail[]; currentRevision?: number },
  ) {
    super(message, options);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = options?.details;
    this.currentRevision = options?.currentRevision;
  }
}

export function daemonBaseUrl(
  env: string | undefined = process.env.NEXT_PUBLIC_DAEMON_URL,
): string {
  return (env ?? DEFAULT_DAEMON_URL).replace(/\/+$/, "");
}

/**
 * Typed fetch wrapper for the daemon API: JSON request/response with every
 * failure mode (network, HTTP error, malformed body) normalized to `ApiError`.
 * Injects the stored daemon token as `Authorization: Bearer …` when present
 * (#92), and reports 401s to the token gate so it can prompt + retry.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = daemonBaseUrl();
  const auth = authorizationHeaderValue(getStoredToken());
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(auth === undefined ? {} : { Authorization: auth }),
        ...init?.headers,
      },
    });
  } catch (cause) {
    throw new ApiError("NETWORK_ERROR", `Could not reach daemon at ${base}`, 0, { cause });
  }

  if (!response.ok) {
    if (response.status === 401) {
      // Token gate (#92): remember how to replay this request (the retry
      // re-reads the token from storage at call time), then prompt.
      setPendingRetry(() => apiFetch<T>(path, init));
      notifyUnauthorized();
    }
    throw await toApiError(response);
  }

  // 204 (and any empty body, e.g. DELETE) has nothing to parse.
  const text = await response.text();
  if (text.length === 0) return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new ApiError("BAD_JSON", `Daemon returned invalid JSON from ${path}`, response.status, {
      cause,
    });
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = "HTTP_ERROR";
  let message = `Request failed with status ${response.status}`;
  let details: readonly ApiErrorDetail[] | undefined;
  let currentRevision: number | undefined;
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    if (typeof error?.code === "string") code = error.code;
    if (typeof error?.message === "string") message = error.message;
    const rawDetails = (error as { details?: unknown } | undefined)?.details;
    if (Array.isArray(rawDetails)) {
      const parsed = rawDetails
        .map((detail) => detail as { path?: unknown; message?: unknown })
        .filter(
          (detail): detail is ApiErrorDetail =>
            typeof detail.path === "string" && typeof detail.message === "string",
        );
      if (parsed.length > 0) details = parsed;
    } else if (
      typeof rawDetails === "object" &&
      rawDetails !== null &&
      typeof (rawDetails as { currentRevision?: unknown }).currentRevision === "number"
    ) {
      // Structured details (409 REVISION_CONFLICT, #76): surface the
      // server's current revision so the editor can offer reload vs force.
      currentRevision = (rawDetails as { currentRevision: number }).currentRevision;
    }
  } catch {
    // Non-JSON error body — keep the fallback code/message.
  }
  return new ApiError(code, message, response.status, { details, currentRevision });
}
