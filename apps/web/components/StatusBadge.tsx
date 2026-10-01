import type { ReactNode } from "react";
import { Badge, statusMeta, type BadgeStatus } from "@/components/ui/badge";

export type { BadgeStatus } from "@/components/ui/badge";
export type { StatusMeta as BadgeStyle } from "@/components/ui/badge";

export { statusMeta as statusBadgeStyle } from "@/components/ui/badge";

/**
 * Status badge for runs/steps/nodes: a thin wrapper over the Badge primitive
 * mapping every status (queued/running/success/failed/aborted/interrupted,
 * plus neutral) to the canonical variant + label from the design system.
 */
export function StatusBadge({
  status,
  children,
  className,
}: {
  status: BadgeStatus;
  children?: ReactNode;
  className?: string;
}) {
  const meta = statusMeta(status);
  return (
    <Badge variant={meta.variant} className={className}>
      <span
        aria-hidden
        className={
          status === "running"
            ? "size-1.5 animate-pulse rounded-full bg-current"
            : "size-1.5 rounded-full bg-current"
        }
      />
      {children ?? meta.label}
    </Badge>
  );
}
