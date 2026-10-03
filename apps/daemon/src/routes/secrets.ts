import type { Db } from "@openeuler/db";
import { SECRET_NAME_SCHEMA } from "@openeuler/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { HttpError } from "../errors.js";
import { encryptSecretValue } from "../secrets-crypto.js";

/**
 * Per-project secrets API (#93): `GET/PUT /api/projects/:id/secrets` and
 * `DELETE /api/projects/:id/secrets/:name`.
 *
 * The listing is **names only** — values are write-only over the wire and
 * never rendered anywhere in the web UI. PUT upserts (same name = rotate).
 */

const PutSecretBodySchema = z.strictObject({
  name: SECRET_NAME_SCHEMA,
  value: z.string().min(1, "secret value must be a non-empty string"),
});

function requireDb(c: Context<AppEnv>): Db {
  const db = c.get("db");
  if (!db) throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
  return db;
}

function requireKey(c: Context<AppEnv>): Buffer {
  const key = c.get("secretsKey");
  if (!key) {
    throw new HttpError(
      503,
      "SECRETS_UNAVAILABLE",
      "secrets are not configured on this daemon (no secret key loaded)",
    );
  }
  return key;
}

function requireProject(db: Db, projectId: string): void {
  if (!db.projects.get(projectId)) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", `no project with id ${projectId}`);
  }
}

async function parseJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(422, "INVALID_JSON", "request body must be valid JSON");
  }
}

export function createSecretsRouter(): Hono<AppEnv> {
  const secrets = new Hono<AppEnv>();

  secrets.get("/:id/secrets", (c) => {
    const db = requireDb(c);
    const projectId = c.req.param("id");
    requireProject(db, projectId);
    return c.json({ secrets: db.projectSecrets.listNames(projectId) });
  });

  secrets.put("/:id/secrets", async (c) => {
    const db = requireDb(c);
    const key = requireKey(c);
    const projectId = c.req.param("id");
    requireProject(db, projectId);
    const body = PutSecretBodySchema.parse(await parseJsonBody(c));
    const existed = db.projectSecrets.get(projectId, body.name) !== undefined;
    const stored = db.projectSecrets.set(projectId, body.name, encryptSecretValue(key, body.value));
    // Never log the value; the name alone identifies the rotation.
    c.get("logger").info({ projectId, name: body.name, rotated: existed }, "secret stored");
    return c.json(
      { secret: { name: stored.name, createdAt: stored.createdAt } },
      existed ? 200 : 201,
    );
  });

  secrets.delete("/:id/secrets/:name", (c) => {
    const db = requireDb(c);
    const projectId = c.req.param("id");
    requireProject(db, projectId);
    const name = c.req.param("name");
    if (!db.projectSecrets.delete(projectId, name)) {
      throw new HttpError(404, "SECRET_NOT_FOUND", `no secret named ${name} on this project`);
    }
    c.get("logger").info({ projectId, name }, "secret deleted");
    return c.body(null, 204);
  });

  return secrets;
}
