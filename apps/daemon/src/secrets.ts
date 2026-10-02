import { redactSecrets, type SecretForRedaction } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import type { RunSecretsLoader } from "@openeuler/engine";
import { decryptSecretValue, encryptSecretValue } from "./secrets-crypto.js";

/**
 * Daemon-side secret support (#93): one object built at boot from the db +
 * master key, backing the API routes (encrypt on write), the executor
 * (decrypt into driver env at run start) and the activity/log redaction
 * paths. Secrets are read fresh from the db on every call so updates apply
 * to runs that have not started yet (a running run keeps its start-of-run
 * snapshot).
 */
export interface SecretsSupport {
  /** Encrypts a value for storage (`v1:…` envelope). */
  encrypt(value: string): string;
  /** The engine hook: loads + decrypts the run's project secrets at run start. */
  loadRunSecrets: RunSecretsLoader;
  /** Fresh redaction transform for a project's current secrets. */
  redactorForProject(projectId: string): (text: string) => string;
}

export function createSecretsSupport(db: Db, key: Buffer): SecretsSupport {
  const decryptAll = (projectId: string): SecretForRedaction[] =>
    db.projectSecrets.list(projectId).map((row) => ({
      name: row.name,
      value: decryptSecretValue(key, row.valueEnc),
    }));

  return {
    encrypt(value) {
      return encryptSecretValue(key, value);
    },
    loadRunSecrets(run) {
      const secrets = decryptAll(run.projectId);
      if (secrets.length === 0) return undefined;
      return {
        env: Object.fromEntries(secrets.map((secret) => [secret.name, secret.value])),
        secrets,
      };
    },
    redactorForProject(projectId) {
      const secrets = decryptAll(projectId);
      return (text) => redactSecrets(text, secrets);
    },
  };
}
