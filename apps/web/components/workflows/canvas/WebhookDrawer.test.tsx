// @vitest-environment jsdom
//
// WebhookDrawer (#120): empty state creates the hook (secret shown once),
// ready state renders the hook URL, delivery ring and actions; rotate
// resurfaces the one-time secret; delete confirms then empties the state.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiError } from "@/lib/api";
import type { WorkflowWebhookDetail } from "@/lib/webhooks-api";
import { WebhookDrawer } from "./WebhookDrawer";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = async (node: ReactNode): Promise<void> => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

const detail: WorkflowWebhookDetail = {
  webhook: {
    id: "hook123abc",
    workflowId: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  deliveries: [
    {
      id: 2,
      webhookId: "hook123abc",
      outcome: "rejected",
      statusCode: 401,
      errorCode: "HOOK_SIGNATURE_INVALID",
      createdAt: "2026-01-01T00:01:00.000Z",
    },
    {
      id: 1,
      webhookId: "hook123abc",
      outcome: "accepted",
      statusCode: 202,
      authMode: "signature",
      runId: "run-9",
      createdAt: "2026-01-01T00:00:30.000Z",
    },
  ],
};

vi.mock("@/lib/webhooks-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/webhooks-api")>();
  return {
    ...original,
    fetchWorkflowWebhook: vi.fn(),
    createWorkflowWebhook: vi.fn(),
    patchWorkflowWebhook: vi.fn(),
    deleteWorkflowWebhook: vi.fn(),
  };
});

const api = await import("@/lib/webhooks-api");

const text = (): string => document.body.textContent ?? "";

describe("WebhookDrawer", () => {
  it("renders the create affordance when no webhook exists", async () => {
    vi.mocked(api.fetchWorkflowWebhook).mockResolvedValue(null);
    await render(createElement(WebhookDrawer, { open: true, workflowId: "w1", onClose: () => {} }));
    expect(document.querySelector("[data-webhook-empty]")).toBeTruthy();
    expect(api.fetchWorkflowWebhook).toHaveBeenCalledWith("w1");
  });

  it("renders hook URL, deliveries and actions when one exists", async () => {
    vi.mocked(api.fetchWorkflowWebhook).mockResolvedValue(detail);
    await render(createElement(WebhookDrawer, { open: true, workflowId: "w1", onClose: () => {} }));

    expect(document.querySelector("[data-webhook-summary]")).toBeTruthy();
    expect(text()).toContain("/api/hooks/hook123abc");
    const rows = document.querySelectorAll("[data-delivery-row]");
    expect(rows).toHaveLength(2);
    expect(text()).toContain("HOOK_SIGNATURE_INVALID");
    expect(text()).toContain("run-9".slice(0, 8));
    expect(text()).toContain("Rotate secret");
    // The one-time secret block is hidden until create/rotate.
    expect(document.querySelector("[data-webhook-secret]")).toBeFalsy();
  });

  it("creates the webhook and shows the secret exactly once", async () => {
    vi.mocked(api.fetchWorkflowWebhook).mockResolvedValueOnce(null).mockResolvedValue(detail);
    vi.mocked(api.createWorkflowWebhook).mockResolvedValue({
      webhook: detail.webhook,
      secret: "one-time-secret-value",
    });
    await render(createElement(WebhookDrawer, { open: true, workflowId: "w1", onClose: () => {} }));

    const buttons = [...document.querySelectorAll("button")];
    const create = buttons.find((b) => b.textContent === "Create webhook");
    await act(async () => {
      create?.click();
    });
    expect(api.createWorkflowWebhook).toHaveBeenCalledWith({ workflowId: "w1" });

    const secretBlock = document.querySelector("[data-webhook-secret]");
    expect(secretBlock).toBeTruthy();
    expect(secretBlock?.textContent).toContain("one-time-secret-value");
    // The curl snippet signs via $SECRET, not the literal value.
    expect(secretBlock?.textContent).toContain("openssl dgst -sha256 -hmac");
  });

  it("rotating resurfaces a fresh secret; deleting confirms then empties", async () => {
    vi.mocked(api.fetchWorkflowWebhook).mockResolvedValue(detail);
    vi.mocked(api.patchWorkflowWebhook).mockResolvedValue({
      webhook: detail.webhook,
      secret: "rotated-secret",
    });
    vi.mocked(api.deleteWorkflowWebhook).mockResolvedValue(undefined);
    vi.mocked(api.fetchWorkflowWebhook).mockResolvedValue(detail);
    await render(createElement(WebhookDrawer, { open: true, workflowId: "w1", onClose: () => {} }));

    const rotate = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Rotate secret",
    );
    await act(async () => {
      rotate?.click();
    });
    expect(api.patchWorkflowWebhook).toHaveBeenCalledWith({
      workflowId: "w1",
      rotateSecret: true,
    });
    expect(document.querySelector("[data-webhook-secret]")?.textContent).toContain(
      "rotated-secret",
    );

    // Delete asks for confirmation first.
    const del = [...document.querySelectorAll("button")].find((b) => b.textContent === "Delete");
    await act(async () => {
      del?.click();
    });
    expect(api.deleteWorkflowWebhook).not.toHaveBeenCalled();

    vi.mocked(api.fetchWorkflowWebhook).mockResolvedValue(null);
    const confirm = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Delete webhook",
    );
    await act(async () => {
      confirm?.click();
    });
    expect(api.deleteWorkflowWebhook).toHaveBeenCalledWith("w1");
    expect(document.querySelector("[data-webhook-empty]")).toBeTruthy();
  });

  it("surfaces load failures inline", async () => {
    vi.mocked(api.fetchWorkflowWebhook).mockRejectedValue(
      new ApiError("NETWORK_ERROR", "no daemon", 0),
    );
    await render(createElement(WebhookDrawer, { open: true, workflowId: "w1", onClose: () => {} }));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("no daemon");
  });
});
