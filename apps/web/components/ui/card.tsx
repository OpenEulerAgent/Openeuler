import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Card primitive (issue #50): the single source of truth for panel surfaces.
 * Compose as `<Card><CardHeader>…</CardHeader><CardContent>…</CardContent></Card>`.
 */

export function Card({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return (
    <section
      className={cn("rounded-xl border border-border bg-surface p-5 shadow-1", className)}
      {...rest}
    >
      {children}
    </section>
  );
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <header className={cn("flex items-start justify-between gap-3", className)}>{children}</header>
  );
}

export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <h2 className={cn("text-title font-semibold text-fg", className)}>{children}</h2>;
}

export function CardDescription({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <p className={cn("mt-0.5 text-sm text-muted-fg", className)}>{children}</p>;
}

export function CardContent({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mt-4", className)}>{children}</div>;
}
