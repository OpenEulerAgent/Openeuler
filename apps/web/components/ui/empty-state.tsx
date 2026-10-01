import type { ReactNode } from "react";

/**
 * Standard empty-state pattern (issue #50): icon slot, title, description,
 * optional call-to-action. Used wherever lists/cards have nothing to show.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={
        "flex flex-col items-center justify-center gap-2 px-6 py-10 text-center " +
        (className ?? "")
      }
    >
      {icon ? (
        <div
          aria-hidden
          className="mb-1 flex size-10 items-center justify-center rounded-full bg-elevated text-muted-fg"
        >
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-fg">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
