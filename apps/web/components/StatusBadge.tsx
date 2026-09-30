import type { RunStatus } from "@openeuler/core";
import type { ReactNode } from "react";

export type BadgeStatus = RunStatus | "neutral";

export interface BadgeStyle {
  label: string;
  className: string;
}

const BASE_CLASS =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium";

const BADGE_STYLES: Record<BadgeStatus, BadgeStyle> = {
  neutral: { label: "Neutral", className: "bg-slate-100 text-slate-600" },
  queued: { label: "Queued", className: "bg-slate-100 text-slate-600" },
  running: { label: "Running", className: "bg-blue-100 text-blue-700" },
  success: { label: "Success", className: "bg-emerald-100 text-emerald-700" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700" },
  aborted: { label: "Aborted", className: "bg-amber-100 text-amber-700" },
  interrupted: { label: "Interrupted", className: "bg-violet-100 text-violet-700" },
};

const DOT_CLASSES: Record<BadgeStatus, string> = {
  neutral: "bg-slate-400",
  queued: "bg-slate-400",
  running: "bg-blue-500",
  success: "bg-emerald-500",
  failed: "bg-red-500",
  aborted: "bg-amber-500",
  interrupted: "bg-violet-500",
};

export function statusBadgeStyle(status: BadgeStatus): BadgeStyle {
  return BADGE_STYLES[status];
}

export function StatusBadge({
  status,
  children,
  className,
}: {
  status: BadgeStatus;
  children?: ReactNode;
  className?: string;
}) {
  const style = statusBadgeStyle(status);
  return (
    <span className={`${BASE_CLASS} ${style.className} ${className ?? ""}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${DOT_CLASSES[status]}`} />
      {children ?? style.label}
    </span>
  );
}
