import { cn } from "@/lib/cn";

/** Loading placeholder block (issue #50) — pulses until real content lands. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-elevated", className)} />;
}

/** Three stacked line skeletons — the standard "content loading" pattern. */
export function SkeletonLines({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2.5 py-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-4", index === rows - 1 ? "w-2/5" : index % 2 === 0 ? "w-full" : "w-4/5")}
        />
      ))}
    </div>
  );
}
