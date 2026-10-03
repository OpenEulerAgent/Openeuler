import { z } from "zod";

/**
 * Per-project secrets (#93): name rules shared by every layer (API
 * validation, db upsert, web form) and the redaction transform applied to
 * all persisted run output. Values themselves only ever live in the daemon
 * (encrypted at rest); this module is deliberately dependency-free and
 * browser-safe so the web can reuse the name schema.
 */

/** Secret names follow env-var rules: `^[A-Z_][A-Z0-9_]*$`, at most 64 chars. */
export const SECRET_NAME_MAX_LENGTH = 64;

export const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;

export const SECRET_NAME_SCHEMA = z
  .string()
  .min(1, "secret name must be a non-empty string")
  .max(SECRET_NAME_MAX_LENGTH, `secret name must be at most ${SECRET_NAME_MAX_LENGTH} characters`)
  .regex(
    SECRET_NAME_REGEX,
    "secret name must match ^[A-Z_][A-Z0-9_]*$ (uppercase letters, digits, underscores; no leading digit)",
  );

/** Marker shape substituted for a secret value: `***NAME***`. */
export const secretRedactionMarker = (name: string): string => `***${name}***`;

/**
 * Values shorter than this are skipped by redaction: replacing a 1–3 char
 * substring everywhere would mangle unrelated text (and leak nothing
 * meaningful anyway — real tokens are longer).
 */
export const MIN_SECRET_REDACTION_LENGTH = 4;

/** A decrypted secret paired with its name, as consumed by redaction. */
export interface SecretForRedaction {
  name: string;
  value: string;
}

/**
 * Replaces every occurrence of each secret `value` in `text` with
 * `***NAME***`. Case-sensitive exact-substring matching; secrets are
 * applied longest-value-first so overlapping values cannot leak a tail
 * (e.g. `token123` inside `token12345` is consumed by the longer one).
 * Values shorter than {@link MIN_SECRET_REDACTION_LENGTH} are skipped.
 */
export function redactSecrets(text: string, secrets: readonly SecretForRedaction[]): string {
  const active = secrets
    .filter((secret) => secret.value.length >= MIN_SECRET_REDACTION_LENGTH)
    .sort((a, b) => b.value.length - a.value.length);
  let output = text;
  for (const secret of active) {
    if (!output.includes(secret.value)) continue;
    output = output.split(secret.value).join(secretRedactionMarker(secret.name));
  }
  return output;
}

/**
 * Structural payload keys that are never redacted: they carry enum-ish
 * machine tokens (event `type`, run `status`, …) where a collision with a
 * secret value would corrupt schema parsing, and they are never free text
 * that could realistically contain a credential.
 */
export const REDACTION_STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "type",
  "seq",
  "status",
  "verdict",
  "code",
  "sessionId",
]);

/**
 * Deep redaction for JSON-ish payloads (event payloads, activity payloads,
 * structured log fields): every string value on a non-structural key is
 * passed through {@link redactSecrets}; plain objects and arrays are
 * walked recursively. Returns a new value; the input is left untouched.
 */
export function redactJson(value: unknown, secrets: readonly SecretForRedaction[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTION_STRUCTURAL_KEYS.has(key) ? child : redactJson(child, secrets);
    }
    return out;
  }
  return value;
}
