import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Per-project secret crypto (#93): AES-256-GCM envelopes plus the local
 * key-file management (generate on first boot, chmod 600).
 *
 * Envelope format: `v1:<iv>:<tag>:<cipher>` where every part after the
 * version tag is base64 (`iv` 12 bytes, `tag` 16 bytes, `cipher` the
 * GCM ciphertext of the UTF-8 plaintext). AAD is empty — the envelope is
 * self-contained and the key file is the only secret.
 */

/** AES-256 key length in bytes. */
export const SECRET_KEY_BYTES = 32;

/** GCM nonce length in bytes (96 bits, the NIST-recommended size). */
export const SECRET_IV_BYTES = 12;

/** Environment variable holding an explicit key-file path. */
export const SECRET_KEY_ENV = "OPENEULER_SECRET_KEY";

/** Default key file name inside the daemon's data directory. */
export const SECRET_KEY_FILENAME = "secret.key";

export type SecretKeyErrorCode = "SECRETS_KEY_UNREADABLE" | "SECRETS_KEY_UNWRITABLE";

/** Typed key-file failures: load errors report `SECRETS_KEY_UNREADABLE`. */
export class SecretKeyError extends Error {
  readonly code: SecretKeyErrorCode;

  constructor(code: SecretKeyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretKeyError";
    this.code = code;
  }
}

/** Typed decrypt failure: malformed or tampered envelope (GCM tag mismatch). */
export class SecretDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretDecryptError";
    this.code = "SECRETS_DECRYPT_FAILED";
  }

  readonly code: "SECRETS_DECRYPT_FAILED";
}

/**
 * Resolves the key-file path: explicit `keyPath` → `$OPENEULER_SECRET_KEY`
 * (absolute, or relative to the cwd like the daemon's other path envs) →
 * `<dataDir>/secret.key`.
 */
export function resolveSecretKeyPath(
  options: { keyPath?: string; dataDir?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const explicit = options.keyPath ?? options.env?.[SECRET_KEY_ENV];
  if (explicit !== undefined && explicit.trim().length > 0) {
    return isAbsolute(explicit) ? explicit : join(process.cwd(), explicit);
  }
  return join(options.dataDir ?? process.cwd(), SECRET_KEY_FILENAME);
}

/**
 * Loads the secret key, generating a fresh 32-byte random key on first boot
 * (file mode 600). Existing files are validated for length — a wrong-size
 * key is `SECRETS_KEY_UNREADABLE`, not a silent decrypt-failure loop.
 */
export function loadOrCreateSecretKey(
  options: { keyPath?: string; dataDir?: string; env?: NodeJS.ProcessEnv } = {},
): { key: Buffer; path: string; created: boolean } {
  const path = resolveSecretKeyPath(options);
  if (existsSync(path)) {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (cause) {
      throw new SecretKeyError("SECRETS_KEY_UNREADABLE", `cannot read secret key file ${path}`, {
        cause,
      });
    }
    if (raw.length !== SECRET_KEY_BYTES) {
      throw new SecretKeyError(
        "SECRETS_KEY_UNREADABLE",
        `secret key file ${path} is ${raw.length} bytes; expected ${SECRET_KEY_BYTES} — restore the original key or delete the file to regenerate (stored secrets become undecryptable either way)`,
      );
    }
    return { key: raw, path, created: false };
  }
  const key = randomBytes(SECRET_KEY_BYTES);
  try {
    writeFileSync(path, key, { mode: 0o600 });
    // The mode above is masked by umask on some platforms; enforce 600.
    chmodSync(path, 0o600);
  } catch (cause) {
    throw new SecretKeyError(
      "SECRETS_KEY_UNWRITABLE",
      `cannot create secret key file ${path} (check directory permissions)`,
      { cause },
    );
  }
  return { key, path, created: true };
}

/** Encrypts `plaintext` into a `v1:<iv>:<tag>:<cipher>` envelope (base64 parts). */
export function encryptSecretValue(key: Buffer, plaintext: string): string {
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretKeyError(
      "SECRETS_KEY_UNREADABLE",
      `secret key must be ${SECRET_KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  const iv = randomBytes(SECRET_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(
    ":",
  );
}

/** Decrypts a `v1:<iv>:<tag>:<cipher>` envelope; tampering raises {@link SecretDecryptError}. */
export function decryptSecretValue(key: Buffer, envelope: string): string {
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretKeyError(
      "SECRETS_KEY_UNREADABLE",
      `secret key must be ${SECRET_KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new SecretDecryptError("malformed secret envelope (expected v1:<iv>:<tag>:<cipher>)");
  }
  let iv: Buffer;
  let tag: Buffer;
  let cipher: Buffer;
  try {
    iv = Buffer.from(parts[1] as string, "base64");
    tag = Buffer.from(parts[2] as string, "base64");
    cipher = Buffer.from(parts[3] as string, "base64");
  } catch (cause) {
    throw new SecretDecryptError("malformed secret envelope (invalid base64 parts)", { cause });
  }
  if (iv.length !== SECRET_IV_BYTES || tag.length === 0) {
    throw new SecretDecryptError("malformed secret envelope (wrong part sizes)");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(cipher), decipher.final()]).toString("utf8");
  } catch (cause) {
    // Wrong key or a tampered ciphertext/tag: GCM refuses to decrypt.
    throw new SecretDecryptError("secret decryption failed (tampered envelope or wrong key)", {
      cause,
    });
  }
}
