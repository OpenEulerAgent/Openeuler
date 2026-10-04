import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Run } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "../app.js";
import type { Executor } from "../executor.js";
import { createExecutor } from "../executor.js";
import { createLogger } from "../logger.js";

/**
 * Per-workflow webhook triggers (#120): management API (secret shown once),
 * signed + token trigger auth, timestamp/nonce replay protection, run
 * creation, delivery logging and rate-limit coverage. The plaintext secret
 * must never appear in any response except the create/rotate body.
 */

interface ErrorResponseBody {
  error: { code: string; message: string };
}

interface Harness {
  dir: string;
  db: Db;
  executor: Executor;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
  workflowId: string;
}

const created: { db: Db; dir: string }[] = [];

const setup = (options: { authToken?: string; rateLimit?: unknown } = {}): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-hooks-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repoPath, stdio: "pipe" });
  };
  git("add", "-A");
  git("-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init");

  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: repoPath,
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  const workflow = db.workflows.create({
    id: crypto.randomUUID(),
    projectId: project.id,
    name: "hooked",
    steps: [
      {
        id: "worker",
        name: "Worker",
        driver: "fake",
        mode: "auto",
        promptTemplate: "Do: {{task}}",
        continueSession: false,
      },
    ],
  });

  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver({}));
  const executor = createExecutor({
    db,
    worktrees: new WorktreeManager({ storeRoot: join(dir, "store") }),
    drivers,
    logger: createLogger("silent"),
  });
  const { app } = createApp({
    db,
    executor,
    secretsKey: Buffer.alloc(32, 7),
    logger: createLogger("silent"),
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit as never }),
  });

  created.push({ db, dir });
  return {
    dir,
    db,
    executor,
    request: (path, init) => Promise.resolve(app.request(path, init)),
    projectId: project.id,
    workflowId: workflow.id,
  };
};

beforeEach(() => {
  created.length = 0;
});

afterEach(() => {
  for (const { db, dir } of created) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Full signature header set over `ts.body`; ts/nonce overridable (used for BOTH signing and headers). */
const signedHeaders = (
  secret: string,
  body: string,
  opts: { timestamp?: string; nonce?: string; headers?: Record<string, string> } = {},
): Record<string, string> => {
  const ts = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? crypto.randomUUID();
  const signature = "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return {
    "content-type": "application/json",
    "x-openeuler-timestamp": ts,
    "x-openeuler-nonce": nonce,
    "x-openeuler-signature": signature,
    ...(opts.headers ?? {}),
  };
};

/** Creates the workflow's webhook and returns {hookId, secret}. */
const createWebhook = async (
  h: Harness,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ hookId: string; secret: string }> => {
  const res = await h.request(`/api/workflows/${h.workflowId}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const parsed = (await res.json()) as { webhook: { id: string }; secret: string };
  return { hookId: parsed.webhook.id, secret: parsed.secret };
};

const trigger = (h: Harness, hookId: string, body: string, headers: Record<string, string>) =>
  h.request(`/api/hooks/${hookId}`, { method: "POST", headers, body });

const deliveries = async (h: Harness, hookId: string, headers: Record<string, string> = {}) => {
  const res = await h.request(`/api/workflows/${h.workflowId}/webhook`, { headers });
  expect(res.status).toBe(200);
  return ((await res.json()) as { deliveries: unknown[] }).deliveries;
};

describe("webhook management API", () => {
  it("creates (201) and answers 409 WEBHOOK_EXISTS on a second create", async () => {
    const h = setup();
    const first = await createWebhook(h, { defaultTask: "ship it" });
    expect(first.hookId).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(first.secret).toMatch(/^[0-9a-f]{48}$/);

    const res = await h.request(`/api/workflows/${h.workflowId}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("WEBHOOK_EXISTS");
  });

  it("GET serves the webhook + deliveries and never the secret", async () => {
    const h = setup();
    const { hookId, secret } = await createWebhook(h);
    await trigger(h, hookId, "{}", signedHeaders(secret, "{}"));

    const res = await h.request(`/api/workflows/${h.workflowId}/webhook`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(secret);
    expect(text).not.toContain("secretEnc");
  });

  it("PATCH rotates the secret once and edits defaultTask", async () => {
    const h = setup();
    const { hookId, secret } = await createWebhook(h);

    const rotated = await h.request(`/api/workflows/${h.workflowId}/webhook`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rotateSecret: true, defaultTask: "fallback task" }),
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as {
      webhook: { defaultTask?: string };
      secret: string;
    };
    expect(rotatedBody.webhook.defaultTask).toBe("fallback task");
    expect(rotatedBody.secret).not.toBe(secret);

    // Old secret no longer authenticates; the rotated one does.
    expect((await trigger(h, hookId, "{}", signedHeaders(secret, "{}"))).status).toBe(401);
    expect((await trigger(h, hookId, "{}", signedHeaders(rotatedBody.secret, "{}"))).status).toBe(
      202,
    );
  });

  it("DELETE removes the webhook; the trigger then 404s", async () => {
    const h = setup();
    const { hookId } = await createWebhook(h);
    const res = await h.request(`/api/workflows/${h.workflowId}/webhook`, { method: "DELETE" });
    expect(res.status).toBe(204);

    expect((await h.request(`/api/workflows/${h.workflowId}/webhook`)).status).toBe(404);
    expect((await trigger(h, hookId, "{}", signedHeaders("whatever", "{}"))).status).toBe(404);
  });

  it("404s for unknown workflows and answers 503 without a secrets key", async () => {
    const h = setup();
    expect(
      (
        await h.request(`/api/workflows/${crypto.randomUUID()}/webhook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);

    const dir = mkdtempSync(join(tmpdir(), "openeuler-hooks-nokey-"));
    const db = createDatabase({ path: join(dir, "test.db") });
    created.push({ db, dir });
    const { app } = createApp({ db, logger: createLogger("silent") });
    const res = await app.request("/api/workflows/some-id/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("SECRETS_UNAVAILABLE");
  });
});

describe("POST /api/hooks/:id — signature auth", () => {
  it("creates a run (202 + runId) and records an accepted delivery", async () => {
    const h = setup();
    const { hookId, secret } = await createWebhook(h);
    const res = await trigger(
      h,
      hookId,
      '{"task":"from the hook"}',
      signedHeaders(secret, '{"task":"from the hook"}'),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; run: Run };
    expect(body.runId).toBe(body.run.id);

    const run = h.db.runs.get(body.runId);
    expect(run).toMatchObject({
      projectId: h.projectId,
      workflowId: h.workflowId,
      status: expect.stringMatching(/queued|running|success/),
      task: "from the hook",
    });
    expect(run?.workflowRevisionId).toBeDefined();

    const log = await deliveries(h, hookId);
    expect(log[0]).toMatchObject({
      outcome: "accepted",
      statusCode: 202,
      authMode: "signature",
      runId: body.runId,
    });
  });

  it("falls back to defaultTask, then the constant; inputs merge into the task", async () => {
    const h = setup();
    const { hookId, secret } = await createWebhook(h, { defaultTask: "the default" });

    const noTask = await trigger(h, hookId, "{}", signedHeaders(secret, "{}"));
    const noTaskRun = h.db.runs.get(((await noTask.json()) as { runId: string }).runId);
    expect(noTaskRun?.task).toBe("the default");

    const withInputs = await trigger(
      h,
      hookId,
      '{"inputs":{"branch":"feat/x","attempt":2}}',
      signedHeaders(secret, '{"inputs":{"branch":"feat/x","attempt":2}}'),
    );
    const inputsRun = h.db.runs.get(((await withInputs.json()) as { runId: string }).runId);
    expect(inputsRun?.task).toContain("the default");
    expect(inputsRun?.task).toContain('"branch": "feat/x"');
    expect(inputsRun?.task).toContain('"attempt": 2');
  });

  it("refuses bad/missing signatures (401) without creating a run", async () => {
    const h = setup();
    const { hookId, secret } = await createWebhook(h);
    const body = '{"task":"hi"}';

    const badSig = await trigger(h, hookId, body, signedHeaders("wrong-secret", body));
    expect(badSig.status).toBe(401);
    expect(((await badSig.json()) as ErrorResponseBody).error.code).toBe("HOOK_SIGNATURE_INVALID");

    const noHeaders = await trigger(h, hookId, body, { "content-type": "application/json" });
    expect(noHeaders.status).toBe(401);
    expect(((await noHeaders.json()) as ErrorResponseBody).error.code).toBe("HOOK_UNAUTHORIZED");

    // Signed over different bytes than sent → invalid.
    const wrongPayload = await trigger(
      h,
      hookId,
      '{"task":"tampered"}',
      signedHeaders(secret, body),
    );
    expect(wrongPayload.status).toBe(401);

    expect(h.db.runs.list().length).toBe(0);
    const log = await deliveries(h, hookId);
    expect(log).toHaveLength(3);
    expect(log.every((entry) => (entry as { outcome: string }).outcome === "rejected")).toBe(true);
  });

  it("refuses stale timestamps (401) and accepts the ±300s boundary", async () => {
    const h = setup();
    const { hookId, secret } = await createWebhook(h);

    const stale = await trigger(
      h,
      hookId,
      "{}",
      signedHeaders(secret, "{}", { timestamp: String(Math.floor(Date.now() / 1000) - 301) }),
    );
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as ErrorResponseBody).error.code).toBe("HOOK_TIMESTAMP_STALE");

    const garbage = await trigger(
      h,
      hookId,
      "{}",
      signedHeaders(secret, "{}", {
        headers: { "x-openeuler-timestamp": "not-a-number" },
      }),
    );
    expect(garbage.status).toBe(401);
    expect(((await garbage.json()) as ErrorResponseBody).error.code).toBe("HOOK_TIMESTAMP_INVALID");

    const boundary = await trigger(
      h,
      hookId,
      "{}",
      signedHeaders(secret, "{}", { timestamp: String(Math.floor(Date.now() / 1000) - 300) }),
    );
    expect(boundary.status).toBe(202);

    expect(h.db.runs.list().length).toBe(1);
  });

  it("rejects replays (409) — one run per signed request", async () => {
    const h = setup();
    const { hookId, secret } = await createWebhook(h);
    const body = '{"task":"once"}';
    const headers = signedHeaders(secret, body);

    const first = await trigger(h, hookId, body, headers);
    expect(first.status).toBe(202);

    const replay = await trigger(h, hookId, body, headers);
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as ErrorResponseBody).error.code).toBe("HOOK_NONCE_REPLAYED");

    expect(h.db.runs.list().length).toBe(1);
    const log = await deliveries(h, hookId);
    expect(log[0]).toMatchObject({ outcome: "rejected", statusCode: 409, authMode: "signature" });
  });

  it("rejects invalid bodies (422) after auth, without creating a run", async () => {
    const h = setup();
    const { hookId, secret } = await createWebhook(h);

    const notJson = await trigger(
      h,
      hookId,
      "not json at all",
      signedHeaders(secret, "not json at all"),
    );
    expect(notJson.status).toBe(422);
    expect(((await notJson.json()) as ErrorResponseBody).error.code).toBe("INVALID_JSON");

    const emptyTask = await trigger(h, hookId, '{"task":""}', signedHeaders(secret, '{"task":""}'));
    expect(emptyTask.status).toBe(422);

    const unknown = await trigger(h, hookId, '{"oops":1}', signedHeaders(secret, '{"oops":1}'));
    expect(unknown.status).toBe(422);

    expect(h.db.runs.list().length).toBe(0);
  });

  it("404s for unknown hook ids (no delivery row, no run)", async () => {
    const h = setup();
    const res = await trigger(h, "nosuchhook", "{}", signedHeaders("x", "{}"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("HOOK_NOT_FOUND");
  });
});

describe("POST /api/hooks/:id — token/signature interplay", () => {
  it("token mode: bearer token works without a signature", async () => {
    const h = setup({ authToken: "daemon-token-1" });
    const { hookId } = await createWebhook(h, {}, { authorization: "Bearer daemon-token-1" });

    const res = await trigger(h, hookId, '{"task":"via token"}', {
      "content-type": "application/json",
      authorization: "Bearer daemon-token-1",
    });
    expect(res.status).toBe(202);
    const run = h.db.runs.get(((await res.json()) as { runId: string }).runId);
    expect(run?.task).toBe("via token");

    const log = await deliveries(h, hookId, { authorization: "Bearer daemon-token-1" });
    expect(log[0]).toMatchObject({ outcome: "accepted", authMode: "token" });
  });

  it("token mode: a wrong token is refused (401), signature-only still works", async () => {
    const h = setup({ authToken: "daemon-token-1" });
    const { hookId, secret } = await createWebhook(
      h,
      {},
      { authorization: "Bearer daemon-token-1" },
    );

    const wrong = await trigger(h, hookId, "{}", {
      "content-type": "application/json",
      authorization: "Bearer wrong-token",
    });
    expect(wrong.status).toBe(401);

    // Signature auth bypasses the daemon token entirely (CI callers).
    const signed = await trigger(h, hookId, "{}", signedHeaders(secret, "{}"));
    expect(signed.status).toBe(202);
  });

  it("open mode: the hook still requires a valid signature (401 otherwise)", async () => {
    const h = setup();
    const { hookId } = await createWebhook(h);
    const res = await trigger(h, hookId, "{}", { "content-type": "application/json" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("HOOK_UNAUTHORIZED");
    expect(h.db.runs.list().length).toBe(0);
  });
});

describe("webhooks + the global /api middleware", () => {
  it("rate limiting applies to the trigger (429 after the bucket drains)", async () => {
    const h = setup({ rateLimit: { mutatePerMin: 2 } });
    const { hookId, secret } = await createWebhook(h);

    const first = await trigger(h, hookId, "{}", signedHeaders(secret, "{}"));
    expect(first.status).toBe(202);

    const second = await trigger(h, hookId, "{}", signedHeaders(secret, "{}"));
    expect(second.status).toBe(429);
    expect(((await second.json()) as ErrorResponseBody).error.code).toBe("RATE_LIMITED");
    expect(second.headers.get("retry-after")).toBeTruthy();
  });

  it("deleting the workflow removes its webhook (trigger then 404s)", async () => {
    const h = setup();
    const { hookId, secret } = await createWebhook(h);

    const res = await h.request(`/api/workflows/${h.workflowId}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    expect(h.db.workflowWebhooks.getByWorkflow(h.workflowId)).toBeUndefined();
    expect((await trigger(h, hookId, "{}", signedHeaders(secret, "{}"))).status).toBe(404);
  });
});
