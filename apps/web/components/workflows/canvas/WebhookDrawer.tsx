"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Field, Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { formatRelativeAge } from "@/lib/time";
import {
  createWorkflowWebhook,
  deleteWorkflowWebhook,
  fetchWorkflowWebhook,
  patchWorkflowWebhook,
  webhookTriggerUrl,
  type WorkflowWebhookDetail,
} from "@/lib/webhooks-api";

/**
 * Workflow webhook settings drawer (#120): create the workflow's trigger,
 * show the one-time secret with a ready-to-paste curl snippet, rotate the
 * secret, edit the default task, delete the hook, and watch the delivery
 * ring (newest 50, refreshed on every open and after each local action).
 */

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; detail: WorkflowWebhookDetail | null };

export function WebhookDrawer({
  open,
  workflowId,
  onClose,
}: {
  open: boolean;
  workflowId: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaultTask, setDefaultTask] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = useCallback(() => {
    setState({ phase: "loading" });
    return fetchWorkflowWebhook(workflowId)
      .then((detail) => {
        setState({ phase: "ready", detail });
        setDefaultTask(detail?.webhook.defaultTask ?? "");
      })
      .catch((cause) => {
        setState({
          phase: "error",
          message: cause instanceof ApiError ? cause.message : "Failed to load webhook",
        });
      });
  }, [workflowId]);

  useEffect(() => {
    if (!open) return;
    setSecret(null);
    setError(null);
    setConfirmDelete(false);
    reload();
  }, [open, reload]);

  const run = (action: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    action()
      .catch((cause) => {
        setError(cause instanceof ApiError ? cause.message : "Unexpected error");
      })
      .finally(() => setBusy(false));
  };

  const create = () =>
    run(async () => {
      const trimmed = defaultTask.trim();
      const created = await createWorkflowWebhook({
        workflowId,
        ...(trimmed.length === 0 ? {} : { defaultTask: trimmed }),
      });
      setSecret(created.secret);
      await reload();
    });

  const rotate = () =>
    run(async () => {
      const rotated = await patchWorkflowWebhook({ workflowId, rotateSecret: true });
      if (rotated.secret !== undefined) setSecret(rotated.secret);
    });

  const saveDefaultTask = () =>
    run(async () => {
      const trimmed = defaultTask.trim();
      await patchWorkflowWebhook({
        workflowId,
        defaultTask: trimmed.length === 0 ? null : trimmed,
      });
      await reload();
    });

  const remove = () =>
    run(async () => {
      await deleteWorkflowWebhook(workflowId);
      setSecret(null);
      await reload();
    });

  return (
    <Drawer open={open} onClose={onClose} label="Workflow webhook">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-title font-semibold text-fg">Webhook trigger</h2>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-fg">
        POST a JSON body to this workflow&apos;s hook URL to queue a run — HMAC-signed, or with the
        daemon token. The delivery log keeps the last 50 attempts.
      </p>

      {state.phase === "loading" ? (
        <p className="mt-4 rounded-lg border border-border p-3 text-sm text-muted-fg">
          Loading webhook…
        </p>
      ) : null}
      {state.phase === "error" ? (
        <p
          className="mt-4 rounded-lg border border-danger/50 bg-danger-subtle p-3 text-sm text-danger"
          role="alert"
        >
          {state.message}
        </p>
      ) : null}

      {state.phase === "ready" && state.detail === null ? (
        <div className="mt-4 flex flex-col gap-3" data-webhook-empty>
          <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-fg">
            This workflow has no webhook yet. Creating one mints a signing secret that is shown
            exactly once.
          </p>
          <Field label="Default task" hint="(optional)" htmlFor="webhook-default-task-create">
            <Input
              id="webhook-default-task-create"
              value={defaultTask}
              onChange={(event) => setDefaultTask(event.target.value)}
              placeholder="Used when the trigger body carries no task"
            />
          </Field>
          <Button size="sm" onClick={create} loading={busy}>
            Create webhook
          </Button>
        </div>
      ) : null}

      {state.phase === "ready" && state.detail !== null ? (
        <div className="mt-4 flex flex-col gap-4">
          <div
            className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3"
            data-webhook-summary
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-fg">Hook</span>
              <code className="min-w-0 truncate rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-fg">
                {webhookTriggerUrl(state.detail.webhook.id)}
              </code>
            </div>
            <p className="text-xs text-muted-fg">
              created {formatRelativeAge(state.detail.webhook.createdAt)} ago ·{" "}
              {state.detail.deliveries.length} logged deliver
              {state.detail.deliveries.length === 1 ? "y" : "ies"}
            </p>
          </div>

          {secret !== null ? (
            <div
              className="flex flex-col gap-2 rounded-lg border border-warning/50 bg-warning-subtle p-3"
              data-webhook-secret
              role="status"
            >
              <p className="text-sm font-medium text-fg">
                Signing secret — shown once, store it now
              </p>
              <code className="break-all rounded bg-surface px-2 py-1 font-mono text-xs text-fg">
                {secret}
              </code>
              <pre className="overflow-x-auto rounded bg-surface p-2 font-mono text-xs text-fg">{`TS=$(date +%s); BODY='{"task":"ship it"}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)
curl -X POST ${webhookTriggerUrl(state.detail.webhook.id)} \\
  -H "content-type: application/json" \\
  -H "x-openeuler-timestamp: $TS" \\
  -H "x-openeuler-nonce: $(uuidgen)" \\
  -H "x-openeuler-signature: sha256=$SIG" \\
  -d "$BODY"`}</pre>
            </div>
          ) : null}

          <Field
            label="Default task"
            hint="(used when the body has no task)"
            htmlFor="webhook-default-task"
          >
            <Input
              id="webhook-default-task"
              value={defaultTask}
              onChange={(event) => setDefaultTask(event.target.value)}
              placeholder="No default — the body must carry a task"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={saveDefaultTask} loading={busy}>
              Save task
            </Button>
            <Button variant="secondary" size="sm" onClick={rotate} loading={busy}>
              Rotate secret
            </Button>
            <Button
              variant="danger"
              size="sm"
              className="ml-auto"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-fg">Deliveries (last 50)</h3>
            <ul className="mt-2 flex flex-col gap-2" data-delivery-list>
              {state.detail.deliveries.length === 0 ? (
                <li className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-fg">
                  No deliveries yet — trigger the hook to see it land here.
                </li>
              ) : null}
              {state.detail.deliveries.map((delivery) => (
                <li
                  key={delivery.id}
                  data-delivery-row={delivery.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-surface p-2.5 text-xs"
                >
                  <Badge variant={delivery.outcome === "accepted" ? "success" : "danger"}>
                    {delivery.statusCode}
                  </Badge>
                  <span className="text-muted-fg">{delivery.authMode ?? "unauthenticated"}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-fg">
                    {delivery.outcome === "accepted"
                      ? `run ${delivery.runId?.slice(0, 8) ?? "?"}`
                      : (delivery.errorCode ?? "rejected")}
                  </span>
                  <span className="whitespace-nowrap text-muted-fg">
                    {formatRelativeAge(delivery.createdAt)} ago
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {confirmDelete ? (
            <div className="flex flex-col gap-2 rounded-lg border border-danger/50 bg-danger-subtle p-3">
              <p className="text-sm text-fg">
                Delete this webhook? The URL stops working immediately.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
                <Button variant="danger" size="sm" onClick={remove} loading={busy}>
                  Delete webhook
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </Drawer>
  );
}
