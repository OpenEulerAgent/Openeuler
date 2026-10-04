import type { RunStatus, StepRunStatus } from "@openeuler/core";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Badge primitive (issue #50) + the canonical status mapping. StatusBadge
 * (components/StatusBadge) wraps this for run/step/node statuses so every
 * status in the app renders identically.
 */

export type BadgeVariant =
  "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "outline";

const BASE_CLASS =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: "bg-elevated text-muted-fg",
  accent: "bg-accent text-accent-fg",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
  info: "bg-info-subtle text-info",
  outline: "border border-border text-fg",
};

export function Badge({
  variant = "neutral",
  className,
  children,
  ...rest
}: {
  variant?: BadgeVariant;
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn(BASE_CLASS, VARIANT_CLASSES[variant], className)} {...rest}>
      {children}
    </span>
  );
}

/**
 * Every status a run/step/node can carry, plus a neutral non-status.
 * `awaiting` mirrors the run-graph fold's visual status for an approval
 * gate wait (#118); `awaiting_approval` is the StepRun row status.
 */
export type BadgeStatus = RunStatus | StepRunStatus | "awaiting" | "neutral";

export interface StatusMeta {
  label: string;
  variant: BadgeVariant;
}

/**
 * Canonical status → (label, badge variant) mapping:
 * queued → neutral, running → info, success → success, failed → danger,
 * aborted → warning (user-stopped but noteworthy), interrupted → warning
 * (daemon died under the run — needs resume/retry attention).
 */
export const STATUS_META: Record<BadgeStatus, StatusMeta> = {
  neutral: { label: "Neutral", variant: "neutral" },
  queued: { label: "Queued", variant: "neutral" },
  running: { label: "Running", variant: "info" },
  awaiting: { label: "Awaiting approval", variant: "warning" },
  awaiting_approval: { label: "Awaiting approval", variant: "warning" },
  success: { label: "Success", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
  aborted: { label: "Aborted", variant: "warning" },
  interrupted: { label: "Interrupted", variant: "warning" },
};

export function statusMeta(status: BadgeStatus): StatusMeta {
  return STATUS_META[status];
}
