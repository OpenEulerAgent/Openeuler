"use client";

import Link from "next/link";
import { useActiveSandboxCount } from "@/lib/sandbox-instances";
import { cn } from "@/lib/cn";
import { EXPANDED_ONLY } from "./Sidebar";

/**
 * Workspace sidebar widget (#112): a small "Sandboxes: N active" chip under
 * the nav linking to the dashboard's sandboxes section. Rendered only while
 * at least one sandbox runs (a cheap 30s poll; unknown → nothing).
 */
export function SandboxCountChip() {
  const count = useActiveSandboxCount();
  if (count === null || count === 0) return null;
  return (
    <Link
      href="/#sandboxes"
      data-testid="sandbox-count-chip"
      title={`${count} sandbox${count === 1 ? "" : "es"} active — open the sandboxes dashboard`}
      className={cn(
        EXPANDED_ONLY,
        "mx-1 mb-1 flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-2",
        "text-xs font-medium text-muted-fg transition-colors hover:bg-elevated hover:text-fg",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
      )}
    >
      <span>Sandboxes</span>
      <span className="inline-flex items-center gap-1.5 font-semibold text-info">
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />
        {count} active
      </span>
    </Link>
  );
}
