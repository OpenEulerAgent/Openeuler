"use client";

import { useDockerStatus, type DockerStatusState } from "@/lib/docker-status";
import { cn } from "@/lib/cn";

/**
 * Docker availability pill (#106), shown next to the daemon health pill:
 * "Docker ready" / "Docker unavailable" (60s poll). Unavailable is a warning,
 * not an error — auto-policy runs still complete locally.
 */
export function DockerPill() {
  const docker = useDockerStatus();
  return (
    <span
      role="status"
      aria-live="polite"
      title={
        docker.status === "ready" && docker.version !== undefined
          ? `docker ${docker.version}`
          : undefined
      }
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium",
        pillClassName(docker),
      )}
    >
      <span aria-hidden className={cn("size-2 rounded-full", dotClassName(docker))} />
      {pillLabel(docker)}
    </span>
  );
}

function pillClassName(docker: DockerStatusState): string {
  if (docker.status === "ready") {
    return docker.available
      ? "border-success/40 bg-success-subtle text-success"
      : "border-warning/40 bg-warning-subtle text-warning";
  }
  return "border-border bg-elevated text-muted-fg";
}

function dotClassName(docker: DockerStatusState): string {
  if (docker.status === "ready") return docker.available ? "bg-success" : "bg-warning";
  return "animate-pulse bg-muted-fg";
}

function pillLabel(docker: DockerStatusState): string {
  if (docker.status === "ready") return docker.available ? "Docker ready" : "Docker unavailable";
  return docker.status === "checking" ? "Checking Docker…" : "Docker status unknown";
}
