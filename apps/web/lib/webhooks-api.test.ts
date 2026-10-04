import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  createWorkflowWebhook,
  deleteWorkflowWebhook,
  fetchWorkflowWebhook,
  isWebhookMissing,
  patchWorkflowWebhook,
} from "./webhooks-api";

/** Minimal stand-in for apiFetch: records the call, replies canned JSON. */
const fetcher = vi.fn();

beforeEach(() => {
  fetcher.mockReset();
});

describe("fetchWorkflowWebhook", () => {
  it("GETs the webhook detail", async () => {
    fetcher.mockResolvedValue({
      webhook: { id: "abc123", workflowId: "w1", createdAt: "x", updatedAt: "x" },
      deliveries: [
        { id: 1, webhookId: "abc123", outcome: "accepted", statusCode: 202, createdAt: "y" },
      ],
    });
    const detail = await fetchWorkflowWebhook("w1", fetcher);
    expect(detail?.webhook.id).toBe("abc123");
    expect(detail?.deliveries).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith("/api/workflows/w1/webhook");
  });

  it("returns null on 404 WEBHOOK_NOT_FOUND, rethrows everything else", async () => {
    fetcher.mockRejectedValue(new ApiError("WEBHOOK_NOT_FOUND", "none", 404));
    await expect(fetchWorkflowWebhook("w1", fetcher)).resolves.toBeNull();

    fetcher.mockRejectedValue(new ApiError("HTTP_ERROR", "boom", 500));
    await expect(fetchWorkflowWebhook("w1", fetcher)).rejects.toBeInstanceOf(ApiError);
  });

  it("encodes the workflow id", async () => {
    fetcher.mockRejectedValue(new ApiError("WEBHOOK_NOT_FOUND", "none", 404));
    await fetchWorkflowWebhook("a/b c", fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/workflows/a%2Fb%20c/webhook");
  });
});

describe("createWorkflowWebhook", () => {
  it("POSTs and surfaces the one-time secret", async () => {
    fetcher.mockResolvedValue({
      webhook: { id: "h", workflowId: "w1", createdAt: "x", updatedAt: "x" },
      secret: "s3cret",
    });
    const created = await createWorkflowWebhook({
      workflowId: "w1",
      defaultTask: "ship",
      fetcher,
    });
    expect(created.secret).toBe("s3cret");
    expect(fetcher).toHaveBeenCalledWith("/api/workflows/w1/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultTask: "ship" }),
    });
  });

  it("omits defaultTask when not given", async () => {
    fetcher.mockResolvedValue({ webhook: { id: "h" }, secret: "s" });
    await createWorkflowWebhook({ workflowId: "w1", fetcher });
    expect(JSON.parse(vi.mocked(fetcher).mock.calls[0]?.[1]?.body as string)).toEqual({});
  });
});

describe("patchWorkflowWebhook", () => {
  it("PATCHes rotation and default-task edits", async () => {
    fetcher.mockResolvedValue({
      webhook: { id: "h", workflowId: "w1", createdAt: "x", updatedAt: "x" },
      secret: "fresh",
    });
    const patched = await patchWorkflowWebhook({
      workflowId: "w1",
      rotateSecret: true,
      defaultTask: null,
      fetcher,
    });
    expect(patched.secret).toBe("fresh");
    expect(fetcher).toHaveBeenCalledWith("/api/workflows/w1/webhook", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotateSecret: true, defaultTask: null }),
    });
  });

  it("no secret in the response when nothing rotated", async () => {
    fetcher.mockResolvedValue({
      webhook: { id: "h", workflowId: "w1", createdAt: "x", updatedAt: "x" },
    });
    const patched = await patchWorkflowWebhook({
      workflowId: "w1",
      defaultTask: "t",
      fetcher,
    });
    expect(patched.secret).toBeUndefined();
  });
});

describe("deleteWorkflowWebhook", () => {
  it("DELETEs the webhook", async () => {
    fetcher.mockResolvedValue(undefined);
    await deleteWorkflowWebhook("w1", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/workflows/w1/webhook", { method: "DELETE" });
  });
});

describe("isWebhookMissing", () => {
  it("matches only WEBHOOK_NOT_FOUND", () => {
    expect(isWebhookMissing(new ApiError("WEBHOOK_NOT_FOUND", "none", 404))).toBe(true);
    expect(isWebhookMissing(new ApiError("WORKFLOW_NOT_FOUND", "none", 404))).toBe(false);
    expect(isWebhookMissing(new Error("nope"))).toBe(false);
  });
});
