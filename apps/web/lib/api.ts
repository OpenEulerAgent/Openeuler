export const DEFAULT_DAEMON_URL = "http://localhost:8787";

/** Normalized error thrown by {@link apiFetch}: every failure path yields one of these. */
export class ApiError extends Error {
  readonly code: string;
  /** HTTP status code; `0` when the daemon could not be reached at all. */
  readonly status: number;

  constructor(code: string, message: string, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
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
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = daemonBaseUrl();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ApiError("NETWORK_ERROR", `Could not reach daemon at ${base}`, 0, { cause });
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new ApiError("BAD_JSON", `Daemon returned invalid JSON from ${path}`, response.status, {
      cause,
    });
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = "HTTP_ERROR";
  let message = `Request failed with status ${response.status}`;
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    if (typeof error?.code === "string") code = error.code;
    if (typeof error?.message === "string") message = error.message;
  } catch {
    // Non-JSON error body — keep the fallback code/message.
  }
  return new ApiError(code, message, response.status);
}
