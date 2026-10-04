import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db, WebhookDelivery } from "@openeuler/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { bearerFromHeader, tokensMatch } from "../auth.js";
import { HttpError } from "../errors.js";
import { decryptSecretValue, encryptSecretValue } from "../secrets-crypto.js";
import { createAndStartWorkflowRun } from "./workflows.js";

/**
 * Per-workflow inbound webhooks (#120).
 *
 * Management (normal `/api` auth, mounted at `/api/workflows`):
 * `POST /:id/webhook` (create; the secret is shown exactly once),
 * `GET /:id/webhook` (view + delivery ring), `PATCH /:id/webhook`
 * (rotate the secret and/or edit the default task; a rotated secret is
 * shown exactly once), `DELETE /:id/webhook`.
 *
 * Trigger (`POST /api/hooks/:id`, mounted separately): authenticates via
 * EITHER an HMAC-SHA256 signature over `<timestamp>.<raw body>`
 * (`X-Openeuler-Signature: sha256=<hex>`, `X-Openeuler-Timestamp` unix
 * seconds, `X-Openeuler-Nonce` unique per request) OR the daemon's normal
 * bearer token when one is configured. Replay protection: the timestamp
 * must sit inside a ±5-minute window and the nonce is cached for as long
 * as its timestamp can still pass validation — a replay answers 409
 * instead of minting a second run. Every attempt (accepted or rejected)
 * lands in the webhook's delivery ring (newest 50 kept, db-side). No run
 * is created and no body is parsed before authentication fully validates.
 */

/** Signature validity window, both directions (clock skew). */
export const HOOK_TIMESTAMP_WINDOW_SEC = 300;

/** Wire headers, lower-case (hono's `header()` is case-insensitive). */
export const HOOK_SIGNATURE_HEADER = "x-openeuler-signature";
export const HOOK_TIMESTAMP_HEADER = "x-openeuler-timestamp";
export const HOOK_NONCE_HEADER = "x-openeuler-nonce";

/** Hook ids are short and URL-safe: nicer in curl/CI than a UUID. */
export function newWebhookId(): string {
  return randomBytes(9).toString("base64url");
}

/** Webhook secrets: 48 hex chars of CSPRNG output (never client-chosen). */
export function newWebhookSecret(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Constant-time HMAC-SHA256 comparison: both hex digests are sha256-hashed
 * first so `timingSafeEqual` always sees equal-length buffers (same trick
 * as `tokensMatch` — a raw compare would throw on length mismatch and leak
 * the digest length through timing).
 */
export function hookSignatureMatches(
  secret: string,
  timestamp: string,
  body: Buffer,
  presented: string,
): boolean {
  const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  const hash = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(hash(digest), hash(presented));
}

function requireDb(c: Context<AppEnv>): Db {
  const db = c.get("db");
  if (!db) throw new HttpError(503, "DB_UNAVAILABLE", "database is not configured");
  return db;
}

async function parseJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(422, "INVALID_JSON", "request body must be valid JSON");
  }
}

/** A webhook as the API serves it: NEVER includes the secret envelope. */
export type WorkflowWebhookApiBody = {
  id: string;
  workflowId: string;
  defaultTask?: string;
  createdAt: string;
  updatedAt: string;
};

function webhookBody(webhook: {
  id: string;
  workflowId: string;
  defaultTask?: string;
  createdAt: string;
  updatedAt: string;
}): WorkflowWebhookApiBody {
  return {
    id: webhook.id,
    workflowId: webhook.workflowId,
    ...(webhook.defaultTask === undefined ? {} : { defaultTask: webhook.defaultTask }),
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
  };
}

const DefaultTaskSchema = z
  .string()
  .min(1, "defaultTask must be a non-empty string")
  .max(4000, "defaultTask must be at most 4000 characters");

const CreateWebhookBodySchema = z.strictObject({
  defaultTask: DefaultTaskSchema.optional(),
});

const PatchWebhookBodySchema = z.strictObject({
  rotateSecret: z.boolean().optional(),
  defaultTask: DefaultTaskSchema.nullable().optional(),
});

/** Trigger body (#120): `task` falls back to the webhook's `defaultTask`. */
const TriggerBodySchema = z.strictObject({
  task: z.string().min(1, "task must be a non-empty string").max(20_000).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
});

/** Task used when neither the body nor the webhook carries one. */
export const DEFAULT_HOOK_TASK = "Triggered by workflow webhook";

/** Nonce shape: URL-safe, 8..128 chars. */
const NonceSchema = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Renders the effective run task: the body's task, else the webhook's
 * default, else the constant fallback; `inputs` (when non-empty) is
 * appended as a JSON block so agents receive it deterministically.
 */
export function renderHookTask(
  body: { task?: string; inputs?: Record<string, unknown> },
  defaultTask: string | undefined,
): string {
  const base = body.task ?? defaultTask ?? DEFAULT_HOOK_TASK;
  if (body.inputs === undefined || Object.keys(body.inputs).length === 0) return base;
  return `${base}\n\nWebhook inputs:\n${JSON.stringify(body.inputs, null, 2)}`;
}

/** Management API, mounted at `/api/workflows` (normal auth applies). */
export function createWorkflowWebhooksRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post("/:id/webhook", async (c) => {
    const db = requireDb(c);
    const key = c.get("secretsKey");
    if (!key) {
      throw new HttpError(
        503,
        "SECRETS_UNAVAILABLE",
        "webhooks are not configured on this daemon (no secret key loaded)",
      );
    }
    const workflow = db.workflows.get(c.req.param("id"));
    if (!workflow) {
      throw new HttpError(404, "WORKFLOW_NOT_FOUND", `no workflow with id ${c.req.param("id")}`);
    }
    if (db.workflowWebhooks.getByWorkflow(workflow.id) !== undefined) {
      throw new HttpError(
        409,
        "WEBHOOK_EXISTS",
        `workflow ${workflow.id} already has a webhook; PATCH it to rotate the secret or edit the default task`,
      );
    }
    const body = CreateWebhookBodySchema.parse(await parseJsonBody(c));
    const secret = newWebhookSecret();
    const now = new Date().toISOString();
    const webhook = db.workflowWebhooks.create({
      id: newWebhookId(),
      workflowId: workflow.id,
      secretEnc: encryptSecretValue(key, secret),
      ...(body.defaultTask === undefined ? {} : { defaultTask: body.defaultTask }),
      createdAt: now,
      updatedAt: now,
    });
    // The ONLY moment the plaintext secret crosses the wire.
    c.get("logger").info({ webhookId: webhook.id, workflowId: workflow.id }, "webhook created");
    return c.json({ webhook: webhookBody(webhook), secret }, 201);
  });

  router.get("/:id/webhook", (c) => {
    const db = requireDb(c);
    const workflow = db.workflows.get(c.req.param("id"));
    if (!workflow) {
      throw new HttpError(404, "WORKFLOW_NOT_FOUND", `no workflow with id ${c.req.param("id")}`);
    }
    const webhook = db.workflowWebhooks.getByWorkflow(workflow.id);
    if (!webhook) {
      throw new HttpError(
        404,
        "WEBHOOK_NOT_FOUND",
        `workflow ${workflow.id} has no webhook; create one via POST /api/workflows/${workflow.id}/webhook`,
      );
    }
    const deliveries: WebhookDelivery[] = db.webhookDeliveries.list(webhook.id);
    return c.json({ webhook: webhookBody(webhook), deliveries });
  });

  router.patch("/:id/webhook", async (c) => {
    const db = requireDb(c);
    const workflow = db.workflows.get(c.req.param("id"));
    if (!workflow) {
      throw new HttpError(404, "WORKFLOW_NOT_FOUND", `no workflow with id ${c.req.param("id")}`);
    }
    const webhook = db.workflowWebhooks.getByWorkflow(workflow.id);
    if (!webhook) {
      throw new HttpError(
        404,
        "WEBHOOK_NOT_FOUND",
        `workflow ${workflow.id} has no webhook; create one via POST /api/workflows/${workflow.id}/webhook`,
      );
    }
    const body = PatchWebhookBodySchema.parse(await parseJsonBody(c));
    let secret: string | undefined;
    let secretEnc: string | undefined;
    if (body.rotateSecret === true) {
      const key = c.get("secretsKey");
      if (!key) {
        throw new HttpError(
          503,
          "SECRETS_UNAVAILABLE",
          "webhooks are not configured on this daemon (no secret key loaded)",
        );
      }
      secret = newWebhookSecret();
      secretEnc = encryptSecretValue(key, secret);
    }
    const updated = db.workflowWebhooks.update(webhook.id, {
      ...(secretEnc === undefined ? {} : { secretEnc }),
      ...(body.defaultTask === undefined ? {} : { defaultTask: body.defaultTask }),
    });
    c.get("logger").info(
      { webhookId: webhook.id, workflowId: workflow.id, rotated: secret !== undefined },
      "webhook updated",
    );
    return c.json({ webhook: webhookBody(updated ?? webhook), ...(secret ? { secret } : {}) });
  });

  router.delete("/:id/webhook", (c) => {
    const db = requireDb(c);
    const workflow = db.workflows.get(c.req.param("id"));
    if (!workflow) {
      throw new HttpError(404, "WORKFLOW_NOT_FOUND", `no workflow with id ${c.req.param("id")}`);
    }
    const webhook = db.workflowWebhooks.getByWorkflow(workflow.id);
    if (!webhook || !db.workflowWebhooks.delete(webhook.id)) {
      throw new HttpError(404, "WEBHOOK_NOT_FOUND", `workflow ${workflow.id} has no webhook`);
    }
    db.webhookDeliveries.deleteForWebhook(webhook.id);
    c.get("logger").info({ webhookId: webhook.id, workflowId: workflow.id }, "webhook deleted");
    return c.body(null, 204);
  });

  return router;
}

export interface HooksRouterOptions {
  /**
   * The daemon's bearer token (`OPENEULER_TOKEN`), when auth mode is on:
   * the trigger then also accepts `Authorization: Bearer <token>` instead
   * of a signature. Undefined (open mode) → signature-only.
   */
  authToken?: string;
  /** Injectable clock for tests (unix ms). */
  now?: () => number;
}

/** Trigger API, mounted at `/api/hooks` (own auth; see module docs). */
export function createHooksRouter(options: HooksRouterOptions = {}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const now = options.now ?? Date.now;
  /**
   * Nonce replay cache: `${webhookId}:${nonce}` → expiry ms. Entries live
   * exactly as long as their timestamp can still pass the window check.
   * ponytail: only authenticated requests reach the cache, but a valid
   * signer could still spray distinct nonces — sweep expired entries past
   * 10k keys; per-key LRU if that ever matters.
   */
  const nonces = new Map<string, number>();

  /** Records the rejected delivery (best-effort) and throws the error. */
  function reject(
    db: Db,
    webhookId: string,
    status: number,
    code: string,
    message: string,
    authMode?: "signature" | "token",
  ): never {
    try {
      db.webhookDeliveries.append({
        webhookId,
        outcome: "rejected",
        statusCode: status,
        ...(authMode === undefined ? {} : { authMode }),
        errorCode: code,
      });
    } catch {
      // The ring is best-effort on rejects; never mask the refusal.
    }
    throw new HttpError(status, code, message);
  }

  router.post("/:id", async (c) => {
    const db = requireDb(c);
    const executor = c.get("executor");
    const webhook = db.workflowWebhooks.get(c.req.param("id"));
    if (!webhook) {
      throw new HttpError(404, "HOOK_NOT_FOUND", `no webhook with id ${c.req.param("id")}`);
    }

    // The raw body is read exactly once: signatures cover these exact
    // bytes, and the JSON parse later reuses the same buffer.
    const raw = Buffer.from(await c.req.arrayBuffer());

    // --- Authentication: signature OR bearer token. Nothing below the
    // --- guard creates a run or parses the payload.

    const signature = c.req.header(HOOK_SIGNATURE_HEADER);
    let authMode: "signature" | "token";

    if (signature !== undefined) {
      authMode = "signature";
      const timestampRaw = c.req.header(HOOK_TIMESTAMP_HEADER) ?? "";
      const timestamp = /^\d{1,12}$/.test(timestampRaw) ? Number(timestampRaw) : Number.NaN;
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
        reject(
          db,
          webhook.id,
          401,
          "HOOK_TIMESTAMP_INVALID",
          `missing or malformed ${HOOK_TIMESTAMP_HEADER} header (unix seconds expected)`,
          authMode,
        );
      }
      const nowSec = Math.floor(now() / 1000);
      if (Math.abs(nowSec - timestamp) > HOOK_TIMESTAMP_WINDOW_SEC) {
        reject(
          db,
          webhook.id,
          401,
          "HOOK_TIMESTAMP_STALE",
          `timestamp is outside the ±${HOOK_TIMESTAMP_WINDOW_SEC}s window; send a fresh request`,
          authMode,
        );
      }
      const key = c.get("secretsKey");
      if (!key) {
        throw new HttpError(
          503,
          "SECRETS_UNAVAILABLE",
          "webhooks are not configured on this daemon (no secret key loaded)",
        );
      }
      const presented = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim())?.[1];
      if (presented === undefined) {
        reject(
          db,
          webhook.id,
          401,
          "HOOK_SIGNATURE_INVALID",
          `malformed ${HOOK_SIGNATURE_HEADER} header; expected sha256=<hex digest>`,
          authMode,
        );
      }
      let secret: string;
      try {
        secret = decryptSecretValue(key, webhook.secretEnc);
      } catch {
        c.get("logger").error({ webhookId: webhook.id }, "webhook secret undecryptable");
        throw new HttpError(
          500,
          "WEBHOOK_SECRET_UNREADABLE",
          "the webhook secret could not be decrypted (wrong or tampered master key)",
        );
      }
      if (!hookSignatureMatches(secret, timestampRaw, raw, presented.toLowerCase())) {
        reject(
          db,
          webhook.id,
          401,
          "HOOK_SIGNATURE_INVALID",
          "signature does not match the body (HMAC-SHA256 over `<timestamp>.<raw body>`)",
          authMode,
        );
      }
      // Signature proven → nonce replay guard.
      const nonce = c.req.header(HOOK_NONCE_HEADER) ?? "";
      if (!NonceSchema.test(nonce)) {
        reject(
          db,
          webhook.id,
          401,
          "HOOK_NONCE_INVALID",
          `missing or malformed ${HOOK_NONCE_HEADER} header (8..128 URL-safe chars expected)`,
          authMode,
        );
      }
      const nowMs = now();
      const expiry = (timestamp + HOOK_TIMESTAMP_WINDOW_SEC + 5) * 1000;
      if (nonces.size > 10_000) {
        for (const [entry, at] of nonces) {
          if (at <= nowMs) nonces.delete(entry);
        }
      }
      const seen = nonces.get(`${webhook.id}:${nonce}`);
      if (seen !== undefined && seen > nowMs) {
        reject(
          db,
          webhook.id,
          409,
          "HOOK_NONCE_REPLAYED",
          "this nonce was already used; every signed request needs a fresh nonce",
          authMode,
        );
      }
      nonces.set(`${webhook.id}:${nonce}`, expiry);
    } else {
      authMode = "token";
      const headerToken = bearerFromHeader(c.req.header("Authorization"));
      if (
        options.authToken === undefined ||
        typeof headerToken !== "string" ||
        !tokensMatch(options.authToken, headerToken)
      ) {
        reject(
          db,
          webhook.id,
          401,
          "HOOK_UNAUTHORIZED",
          "provide a valid X-Openeuler-Signature or an Authorization bearer token",
        );
      }
    }

    // --- Authenticated; parse the payload and mint the run.

    if (!executor) {
      throw new HttpError(503, "EXECUTOR_UNAVAILABLE", "executor is not configured");
    }
    const workflow = db.workflows.get(webhook.workflowId);
    if (!workflow) {
      throw new HttpError(
        409,
        "WORKFLOW_MISSING",
        `workflow ${webhook.workflowId} of this webhook no longer exists`,
      );
    }

    const parsed: z.output<typeof TriggerBodySchema> = (() => {
      try {
        return TriggerBodySchema.parse(JSON.parse(raw.toString("utf8") || "{}"));
      } catch (err) {
        if (err instanceof z.ZodError) {
          reject(
            db,
            webhook.id,
            422,
            "VALIDATION_ERROR",
            err.issues[0]?.message ?? "invalid trigger body",
            authMode,
          );
        }
        reject(db, webhook.id, 422, "INVALID_JSON", "request body must be a JSON object", authMode);
      }
    })();
    const { run } = createAndStartWorkflowRun({
      db,
      executor,
      secretsKey: c.get("secretsKey"),
      workflow,
      task: renderHookTask(parsed, webhook.defaultTask),
    });

    db.webhookDeliveries.append({
      webhookId: webhook.id,
      outcome: "accepted",
      statusCode: 202,
      authMode,
      runId: run.id,
    });
    c.get("logger").info({ webhookId: webhook.id, runId: run.id, authMode }, "webhook accepted");

    return c.json({ runId: run.id, run }, 202);
  });

  return router;
}
