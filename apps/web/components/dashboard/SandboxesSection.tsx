"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonLines } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { DockerPill } from "@/components/DockerPill";
import { BoxIcon } from "@/components/shell/icons";
import { ApiError } from "@/lib/api";
import { useDockerStatus } from "@/lib/docker-status";
import {
  destroySandboxInstance,
  stopSandboxInstance,
  type SandboxInstance,
  type SandboxInstanceStatus,
} from "@/lib/sandbox-api";
import { countRunningSandboxes, useSandboxInstances } from "@/lib/sandbox-instances";
import { formatRelativeAge } from "@/lib/time";

/**
 * Sandboxes dashboard section (#112): the active-containers view between the
 * project cards and the runs table. One card per provider sandbox — image,
 * status, run link, live cpu/mem usage bars — polled every 5s while the page
 * is visible. Stop is a graceful container stop (kept, inspectable) with an
 * arm-confirm; Destroy removes the container for good (arm-confirm); both
 * update optimistically and surface failures as toasts.
 */

const SANDBOX_STATUS_META: Record<SandboxInstanceStatus, { label: string; variant: BadgeVariant }> =
  {
    running: { label: "Running", variant: "success" },
    exited: { label: "Exited", variant: "warning" },
    stopped: { label: "Stopped", variant: "neutral" },
  };

/** MiB → compact human form ("812 MiB", "1.5 GiB"). */
function formatMiB(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}

function UsageBar({
  label,
  fraction,
  text,
  testId,
}: {
  label: string;
  /** 0..1 width; clamped. */
  fraction: number;
  text: string;
  testId: string;
}) {
  const width = `${Math.min(100, Math.max(0, fraction * 100)).toFixed(1)}%`;
  return (
    <div data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-fg">{label}</span>
        <span className="text-xs tabular-nums text-muted-fg">{text}</span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-elevated"
        role="progressbar"
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width }}
        />
      </div>
    </div>
  );
}

/** Arm-confirm inline action (same pattern as the runs table's Stop cell). */
function ConfirmAction({
  label,
  confirmLabel,
  busyLabel,
  busy,
  danger,
  hint,
  onConfirm,
  testId,
}: {
  label: string;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  danger?: boolean;
  /** Extra warning shown while armed (e.g. "this fails the run"). */
  hint?: string;
  onConfirm: () => void;
  testId: string;
}) {
  const [armed, setArmed] = useState(false);
  if (busy) {
    return (
      <Button variant="ghost" size="sm" loading data-testid={testId}>
        {busyLabel}
      </Button>
    );
  }
  if (!armed) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={danger ? "text-danger hover:bg-danger-subtle hover:text-danger" : undefined}
        data-testid={testId}
        onClick={() => setArmed(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5"
      onKeyDown={(event) => {
        if (event.key === "Escape") setArmed(false);
      }}
    >
      {hint !== undefined ? (
        <span className="max-w-48 truncate text-xs text-warning" title={hint}>
          {hint}
        </span>
      ) : null}
      <Button
        variant={danger ? "danger" : "secondary"}
        size="sm"
        data-testid={`${testId}-confirm`}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
        Cancel
      </Button>
    </span>
  );
}

function SandboxCard({
  instance,
  stopping,
  destroying,
  onStop,
  onDestroy,
}: {
  instance: SandboxInstance;
  stopping: boolean;
  destroying: boolean;
  onStop: (instance: SandboxInstance) => void;
  onDestroy: (instance: SandboxInstance) => void;
}) {
  const meta = SANDBOX_STATUS_META[instance.status];
  const usage = instance.usage;
  const runLink = instance.runId === null ? null : `/runs/${encodeURIComponent(instance.runId)}`;
  return (
    <Card
      className="flex flex-col gap-3 py-5"
      data-testid="sandbox-card"
      data-sandbox-id={instance.id}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="min-w-0 truncate rounded-md bg-elevated px-2 py-1 font-mono text-xs text-fg"
          title={instance.image}
          data-testid="sandbox-image"
        >
          {instance.image}
        </span>
        <Badge variant={meta.variant} data-testid="sandbox-status">
          {instance.status === "running" ? (
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />
          ) : null}
          {meta.label}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-fg">
        {runLink !== null ? (
          <>
            <Link
              href={runLink}
              className="rounded-sm font-medium text-link transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              data-testid="sandbox-run-link"
            >
              {instance.run?.project?.name ?? "project"} · run {(instance.runId ?? "").slice(0, 8)}
            </Link>
            {instance.run !== undefined ? (
              <span
                className="rounded-full border border-border px-1.5 py-0.5"
                title={`Run status: ${instance.run.status}`}
              >
                {instance.run.status}
              </span>
            ) : null}
            {instance.run?.hosted === true ? (
              <span
                className="rounded-full border border-success/50 bg-success-subtle px-1.5 py-0.5 text-success"
                title="Sandbox kept alive for previews (hosting)"
              >
                hosted
              </span>
            ) : null}
          </>
        ) : (
          <span title={`Sandbox id ${instance.id}`}>Unlinked sandbox · {instance.id}</span>
        )}
        <span className="ml-auto" title={`Started ${new Date(instance.startedAt).toISOString()}`}>
          started {formatRelativeAge(new Date(instance.startedAt).toISOString())}
        </span>
      </div>

      {usage === undefined ? (
        <p className="text-xs text-muted-fg" data-testid="sandbox-usage-unavailable">
          Usage unavailable for this sandbox.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <UsageBar
            label="CPU"
            testId="sandbox-cpu-bar"
            fraction={usage.cpuPercent === undefined ? 0 : Math.min(100, usage.cpuPercent) / 100}
            text={usage.cpuPercent === undefined ? "—" : `${usage.cpuPercent.toFixed(1)}%`}
          />
          <UsageBar
            label="Memory"
            testId="sandbox-mem-bar"
            fraction={
              usage.memMb === undefined || usage.memLimitMb === undefined
                ? 0
                : usage.memMb / usage.memLimitMb
            }
            text={
              usage.memMb === undefined
                ? "—"
                : usage.memLimitMb === undefined
                  ? formatMiB(usage.memMb)
                  : `${formatMiB(usage.memMb)} / ${formatMiB(usage.memLimitMb)}`
            }
          />
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-end gap-1 border-t border-border pt-3">
        {runLink !== null ? (
          <Link
            href={runLink}
            className="rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-fg transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Open run
          </Link>
        ) : null}
        {instance.status === "running" ? (
          <ConfirmAction
            label="Stop"
            confirmLabel="Confirm stop"
            busyLabel="Stopping…"
            busy={stopping}
            testId="sandbox-stop"
            hint={
              instance.run?.status === "running" || instance.run?.status === "queued"
                ? "Stopping this sandbox fails its run at the next step."
                : undefined
            }
            onConfirm={() => onStop(instance)}
          />
        ) : null}
        <ConfirmAction
          label="Destroy"
          confirmLabel="Confirm destroy"
          busyLabel="Destroying…"
          busy={destroying}
          danger
          testId="sandbox-destroy"
          hint={
            instance.run?.status === "running" || instance.run?.status === "queued"
              ? "Destroying this sandbox fails its run at the next step."
              : undefined
          }
          onConfirm={() => onDestroy(instance)}
        />
      </div>
    </Card>
  );
}

export function SandboxesSection() {
  const { toast } = useToast();
  const docker = useDockerStatus();
  const state = useSandboxInstances();
  /** In-flight actions by sandbox id ("stop" | "destroy"). */
  const [pending, setPending] = useState<Record<string, "stop" | "destroy">>({});
  /** Optimistic overlays until the next poll lands. */
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());

  const instances =
    state.phase === "ready" ? state.instances.filter((instance) => !removed.has(instance.id)) : [];
  const runningCount = countRunningSandboxes(
    instances.map((instance) =>
      stopped.has(instance.id) && instance.status === "running"
        ? { ...instance, status: "exited" as const }
        : instance,
    ),
  );

  const failToast = useCallback(
    (title: string, cause: unknown): void => {
      toast(
        {
          title,
          description: cause instanceof ApiError ? cause.message : "Unknown error",
          variant: "danger",
        },
        0,
      );
    },
    [toast],
  );

  const onStop = useCallback(
    async (instance: SandboxInstance): Promise<void> => {
      setPending((current) => ({ ...current, [instance.id]: "stop" }));
      try {
        await stopSandboxInstance(instance.id);
        // Optimistic: the container is stopped the moment docker answers.
        setStopped((current) => new Set(current).add(instance.id));
      } catch (cause: unknown) {
        failToast("Stop failed", cause);
      } finally {
        setPending((current) => {
          const next = { ...current };
          delete next[instance.id];
          return next;
        });
      }
    },
    [failToast],
  );

  const onDestroy = useCallback(
    async (instance: SandboxInstance): Promise<void> => {
      setPending((current) => ({ ...current, [instance.id]: "destroy" }));
      setRemoved((current) => new Set(current).add(instance.id)); // optimistic
      try {
        await destroySandboxInstance(instance.id);
      } catch (cause: unknown) {
        // Restore the card; the daemon still lists it.
        setRemoved((current) => {
          const next = new Set(current);
          next.delete(instance.id);
          return next;
        });
        failToast("Destroy failed", cause);
      } finally {
        setPending((current) => {
          const next = { ...current };
          delete next[instance.id];
          return next;
        });
      }
    },
    [failToast],
  );

  return (
    <section aria-label="Sandboxes" id="sandboxes" data-testid="sandboxes-section">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Sandboxes</CardTitle>
            <CardDescription>
              Sandbox containers from sandboxed runs — usage and statuses update live.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {state.phase === "ready" && instances.length > 0 ? (
              <Badge variant={runningCount > 0 ? "info" : "neutral"} data-testid="sandboxes-count">
                {runningCount} running · {instances.length} total
              </Badge>
            ) : null}
            <DockerPill />
          </div>
        </CardHeader>
        <CardContent>
          {docker.status === "ready" && !docker.available ? (
            <p
              className="mb-4 rounded-lg border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-warning"
              data-testid="sandboxes-docker-banner"
            >
              Docker unavailable — sandbox runs cannot start; auto-policy projects execute locally
              until it comes back.
            </p>
          ) : null}

          {state.phase === "loading" ? (
            <SkeletonLines rows={3} />
          ) : state.phase === "error" ? (
            <div className="flex flex-col items-start gap-3 py-2 text-sm">
              <p className="text-danger">{state.message}</p>
              <Button variant="secondary" size="sm" onClick={state.refresh}>
                Retry
              </Button>
            </div>
          ) : instances.length === 0 ? (
            <div data-testid="sandboxes-empty">
              <EmptyState
                icon={<BoxIcon className="size-5" />}
                title="No sandboxes"
                description="Sandboxed runs execute in isolated Docker containers. Set a project's execution mode to sandbox or auto (Project settings → Sandbox), then start a run — its container appears here with live usage."
              />
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="sandbox-grid">
              {instances.map((instance) => {
                const view =
                  stopped.has(instance.id) && instance.status === "running"
                    ? { ...instance, status: "exited" as const }
                    : instance;
                return (
                  <SandboxCard
                    key={instance.id}
                    instance={view}
                    stopping={pending[instance.id] === "stop"}
                    destroying={pending[instance.id] === "destroy"}
                    onStop={(target) => void onStop(target)}
                    onDestroy={(target) => void onDestroy(target)}
                  />
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
