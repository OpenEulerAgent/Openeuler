import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Step, Workflow } from "@openeuler/core";
import { createDatabase, WEBHOOK_DELIVERY_LOG_LIMIT } from "./index.js";
import type { Db, WebhookDeliveryInput, WorkflowWebhook } from "./index.js";

const uuid = (): string => crypto.randomUUID();
const iso = (): string => new Date().toISOString();

const makeWorkflow = (db: Db, over: Partial<Workflow> = {}): Workflow => {
  const project = db.projects.create({
    id: uuid(),
    path: "/srv/repos/demo",
    name: "demo",
    defaultBranch: "main",
    createdAt: iso(),
  });
  const steps: Step[] = [
    {
      id: "s1",
      name: "Worker",
      driver: "fake",
      mode: "auto",
      promptTemplate: "{{task}}",
      continueSession: false,
    },
  ];
  return db.workflows.create({
    id: uuid(),
    projectId: project.id,
    name: "wf",
    steps,
    ...over,
  });
};

const makeWebhook = (workflowId: string): WorkflowWebhook => ({
  id: uuid(),
  workflowId,
  secretEnc: "v1:a:b:c",
  createdAt: iso(),
  updatedAt: iso(),
});

const delivery = (webhookId: string, seed: number): WebhookDeliveryInput => ({
  webhookId,
  outcome: seed % 2 === 0 ? "accepted" : "rejected",
  statusCode: seed % 2 === 0 ? 202 : 401,
  authMode: "signature",
  ...(seed % 2 === 0 ? { runId: uuid() } : { errorCode: "HOOK_SIGNATURE_INVALID" }),
});

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openeuler-webhooks-"));
  db = createDatabase({ path: join(dir, "test.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("workflowWebhooks repo", () => {
  it("creates, gets by id and by workflow", () => {
    const workflow = makeWorkflow(db);
    const webhook = db.workflowWebhooks.create(makeWebhook(workflow.id));
    expect(db.workflowWebhooks.get(webhook.id)).toEqual(webhook);
    expect(db.workflowWebhooks.getByWorkflow(workflow.id)).toEqual(webhook);
  });

  it("maps an absent defaultTask to undefined, a stored one back", () => {
    const workflow = makeWorkflow(db);
    const plain = makeWebhook(workflow.id);
    db.workflowWebhooks.create(plain);
    expect(db.workflowWebhooks.get(plain.id)?.defaultTask).toBeUndefined();

    const withDefault = makeWebhook(makeWorkflow(db).id);
    withDefault.defaultTask = "ship it";
    db.workflowWebhooks.create(withDefault);
    expect(db.workflowWebhooks.get(withDefault.id)?.defaultTask).toBe("ship it");
  });

  it("enforces at most one webhook per workflow (unique index)", () => {
    const workflow = makeWorkflow(db);
    db.workflowWebhooks.create(makeWebhook(workflow.id));
    expect(() => db.workflowWebhooks.create(makeWebhook(workflow.id))).toThrow();
  });

  it("patches secret and defaultTask, bumps updatedAt, keeps createdAt", () => {
    const workflow = makeWorkflow(db);
    const webhook = db.workflowWebhooks.create(makeWebhook(workflow.id));
    const updated = db.workflowWebhooks.update(webhook.id, {
      secretEnc: "v1:rotated",
      defaultTask: "fallback",
    });
    expect(updated).toMatchObject({
      id: webhook.id,
      secretEnc: "v1:rotated",
      defaultTask: "fallback",
      createdAt: webhook.createdAt,
    });
    expect(updated !== undefined && updated.updatedAt >= webhook.updatedAt).toBe(true);

    const cleared = db.workflowWebhooks.update(webhook.id, { defaultTask: null });
    expect(cleared?.defaultTask).toBeUndefined();
    expect(cleared?.secretEnc).toBe("v1:rotated");

    expect(db.workflowWebhooks.update(uuid(), { secretEnc: "x" })).toBeUndefined();
  });

  it("deletes by id and for a workflow", () => {
    const workflow = makeWorkflow(db);
    const webhook = db.workflowWebhooks.create(makeWebhook(workflow.id));
    expect(db.workflowWebhooks.delete(webhook.id)).toBe(true);
    expect(db.workflowWebhooks.delete(webhook.id)).toBe(false);

    const other = db.workflowWebhooks.create(makeWebhook(workflow.id));
    expect(db.workflowWebhooks.deleteForWorkflow(workflow.id)).toBe(1);
    expect(db.workflowWebhooks.get(other.id)).toBeUndefined();
  });
});

describe("webhookDeliveries repo", () => {
  it("appends and lists newest first with optional fields round-tripping", () => {
    const workflow = makeWorkflow(db);
    const webhook = db.workflowWebhooks.create(makeWebhook(workflow.id));
    const first = db.webhookDeliveries.append({
      ...delivery(webhook.id, 1),
      authMode: undefined,
    });
    const second = db.webhookDeliveries.append(delivery(webhook.id, 2));

    const rows = db.webhookDeliveries.list(webhook.id);
    expect(rows.map((row) => row.id)).toEqual([second.id, first.id]);
    expect(rows[1]).toMatchObject({
      outcome: "rejected",
      statusCode: 401,
      errorCode: expect.any(String),
    });
    expect(rows[1]?.authMode).toBeUndefined();
    expect(rows[0]).toMatchObject({
      outcome: "accepted",
      statusCode: 202,
      authMode: "signature",
      runId: expect.any(String),
    });
    expect(first.createdAt).toEqual(expect.any(String));
  });

  it("keeps only the newest 50 deliveries per webhook (ring truncation)", () => {
    const workflow = makeWorkflow(db);
    const webhook = db.workflowWebhooks.create(makeWebhook(workflow.id));
    for (let i = 0; i < WEBHOOK_DELIVERY_LOG_LIMIT + 15; i += 1) {
      db.webhookDeliveries.append(delivery(webhook.id, i));
    }
    const rows = db.webhookDeliveries.list(webhook.id);
    expect(rows).toHaveLength(WEBHOOK_DELIVERY_LOG_LIMIT);
    // Newest survive: the first appended row is gone, the last one leads.
    expect(rows[0]?.errorCode ?? rows[0]?.runId).toBeTruthy();
    expect(rows[0]?.id).toBeGreaterThan(rows[rows.length - 1]?.id ?? 0);
  });

  it("truncates per webhook — a busy hook never evicts a quiet one's rows", () => {
    const busy = db.workflowWebhooks.create(makeWebhook(makeWorkflow(db).id));
    const quiet = db.workflowWebhooks.create(makeWebhook(makeWorkflow(db).id));
    for (let i = 0; i < WEBHOOK_DELIVERY_LOG_LIMIT + 5; i += 1) {
      db.webhookDeliveries.append(delivery(busy.id, i));
    }
    db.webhookDeliveries.append(delivery(quiet.id, 1));
    expect(db.webhookDeliveries.list(quiet.id)).toHaveLength(1);
    expect(db.webhookDeliveries.list(busy.id)).toHaveLength(WEBHOOK_DELIVERY_LOG_LIMIT);
  });

  it("deletes every delivery for a webhook", () => {
    const workflow = makeWorkflow(db);
    const webhook = db.workflowWebhooks.create(makeWebhook(workflow.id));
    db.webhookDeliveries.append(delivery(webhook.id, 1));
    db.webhookDeliveries.append(delivery(webhook.id, 2));
    expect(db.webhookDeliveries.deleteForWebhook(webhook.id)).toBe(2);
    expect(db.webhookDeliveries.list(webhook.id)).toEqual([]);
  });
});
