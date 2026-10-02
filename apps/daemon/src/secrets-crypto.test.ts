import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SECRET_KEY_BYTES,
  decryptSecretValue,
  encryptSecretValue,
  loadOrCreateSecretKey,
  resolveSecretKeyPath,
  SecretDecryptError,
  SecretKeyError,
} from "./secrets-crypto.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openeuler-crypto-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const key = (): Buffer => crypto.getRandomValues(new Uint8Array(SECRET_KEY_BYTES)) as Buffer;

describe("encrypt/decrypt round-trip", () => {
  it("round-trips arbitrary values through the v1 envelope", () => {
    const k = key();
    for (const value of [
      "npat_abc123def456",
      "",
      "ünïcode ✓ with spaces & symbols=!@#",
      "a".repeat(10_000),
      '{"json":"like"}',
    ]) {
      const envelope = encryptSecretValue(k, value);
      expect(envelope.startsWith("v1:")).toBe(true);
      expect(envelope.split(":")).toHaveLength(4);
      expect(decryptSecretValue(k, envelope)).toBe(value);
    }
  });

  it("produces a different envelope per call (random IV)", () => {
    const k = key();
    expect(encryptSecretValue(k, "same")).not.toBe(encryptSecretValue(k, "same"));
  });

  it("cannot decrypt with a different key", () => {
    const envelope = encryptSecretValue(key(), "npat_supersecret");
    expect(() => decryptSecretValue(key(), envelope)).toThrow(SecretDecryptError);
  });

  it("detects tampering: flipped cipher byte fails the GCM tag", () => {
    const k = key();
    const envelope = encryptSecretValue(k, "npat_supersecret");
    const parts = envelope.split(":");
    const cipher = Buffer.from(parts[3] as string, "base64");
    cipher[0] = (cipher[0] as number) ^ 0xff;
    const tampered = [...parts.slice(0, 3), cipher.toString("base64")].join(":");
    expect(() => decryptSecretValue(k, tampered)).toThrow(SecretDecryptError);
    expect(() => decryptSecretValue(k, tampered)).toThrow(/SECRETS_DECRYPT_FAILED|tampered/);
  });

  it("detects tampering: swapped auth tag fails", () => {
    const k = key();
    const a = encryptSecretValue(k, "value-a");
    const b = encryptSecretValue(k, "value-b");
    const mixed = [a.split(":")[0], a.split(":")[1], b.split(":")[2], a.split(":")[3]].join(":");
    expect(() => decryptSecretValue(k, mixed)).toThrow(SecretDecryptError);
  });

  it("rejects malformed envelopes with a typed error", () => {
    const k = key();
    for (const bad of ["", "v2:aaa:bbb:ccc", "v1:only:two", "v1:!!:!!:!!"]) {
      expect(() => decryptSecretValue(k, bad)).toThrow(SecretDecryptError);
    }
  });

  it("rejects wrong-size keys with a typed error", () => {
    const short = Buffer.alloc(16);
    expect(() => encryptSecretValue(short, "x")).toThrow(SecretKeyError);
    expect(() => decryptSecretValue(short, "v1:aaaa:bbbb:cccc")).toThrow(SecretKeyError);
  });
});

describe("loadOrCreateSecretKey", () => {
  it("generates a 32-byte key file (mode 600) on first boot", () => {
    const { key: k, path, created } = loadOrCreateSecretKey({ dataDir: dir });
    expect(created).toBe(true);
    expect(path).toBe(join(dir, "secret.key"));
    expect(k.length).toBe(32);
    expect(readFileSync(path).length).toBe(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reuses the existing key on the next boot", () => {
    const first = loadOrCreateSecretKey({ dataDir: dir });
    const second = loadOrCreateSecretKey({ dataDir: dir });
    expect(second.created).toBe(false);
    expect(second.key.equals(first.key)).toBe(true);
  });

  it("throws SECRETS_KEY_UNREADABLE for a wrong-size key file", () => {
    writeFileSync(join(dir, "secret.key"), Buffer.alloc(10));
    try {
      loadOrCreateSecretKey({ dataDir: dir });
      throw new Error("expected loadOrCreateSecretKey to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretKeyError);
      expect((err as SecretKeyError).code).toBe("SECRETS_KEY_UNREADABLE");
    }
  });

  it("respects OPENEULER_SECRET_KEY (absolute and cwd-relative) over the default path", () => {
    const custom = join(dir, "custom.key");
    const absolute = loadOrCreateSecretKey({
      env: { OPENEULER_SECRET_KEY: custom },
      dataDir: join(dir, "data"),
    });
    expect(absolute.path).toBe(custom);

    process.chdir(dir);
    try {
      const relative = resolveSecretKeyPath({
        env: { OPENEULER_SECRET_KEY: "relative.key" },
        dataDir: join(dir, "data"),
      });
      expect(relative).toBe(join(dir, "relative.key"));
    } finally {
      process.chdir("/tmp");
    }
  });
});
