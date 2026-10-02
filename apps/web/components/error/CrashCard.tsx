"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchHealth, type HealthState } from "@/lib/health";

/**
 * Shared crash card for every `error.tsx` boundary (#96): a "Something went
 * wrong" panel with Retry (`reset()` — Next remounts the crashed segment —
 * plus `router.refresh()` to revalidate server data), Copy diagnostics
 * (route, timestamp, daemon health snapshot, user agent, stack tail), and a
 * Go home link. Rendered inside the segment's layout, so the app shell
 * (sidebar, toasts) survives; `global-error.tsx` covers total shell failure.
 */

export interface CrashCardProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/** Diagnostics keep at most this many stack lines (#96). */
export const STACK_TAIL_LINES = 15;

/** Last `maxLines` non-empty stack lines, with an omission notice when cut. */
export function stackTail(stack: string | null | undefined, maxLines = STACK_TAIL_LINES): string {
  if (typeof stack !== "string" || stack.length === 0) return "(no stack available)";
  const lines = stack.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length <= maxLines) return lines.join("\n");
  const omitted = lines.length - maxLines;
  return `… ${omitted} earlier line${omitted === 1 ? "" : "s"} omitted …\n${lines.slice(-maxLines).join("\n")}`;
}

/** One-line rendering of a health snapshot for the diagnostics report. */
export function formatHealthState(state: HealthState): string {
  switch (state.status) {
    case "checking":
      return "checking";
    case "healthy":
      return state.uptime === undefined
        ? `healthy (v${state.version})`
        : `healthy (v${state.version}, up ${state.uptime}s)`;
    case "degraded":
      return `degraded — ${state.message}`;
  }
}

export interface DiagnosticsInput {
  route: string;
  timestamp: string;
  health: string;
  userAgent: string;
  name: string;
  message: string;
  digest?: string;
  stack: string | null;
}

/** Assembles the clipboard report: stable labeled lines over the stack tail. */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const lines = [
    "Openeuler crash report",
    `Route: ${input.route}`,
    `Time: ${input.timestamp}`,
    `Error: ${input.name}: ${input.message}`,
    input.digest === undefined ? null : `Digest: ${input.digest}`,
    `Health: ${input.health}`,
    `User agent: ${input.userAgent}`,
    `Stack (last ${STACK_TAIL_LINES} lines):`,
    stackTail(input.stack),
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

type CopyState = "idle" | "copying" | "copied" | "failed";

const COPY_LABEL: Record<CopyState, string> = {
  idle: "Copy diagnostics",
  copying: "Copying…",
  copied: "Diagnostics copied",
  failed: "Copy failed",
};

export function CrashCard({ error, reset }: CrashCardProps) {
  const router = useRouter();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const isDev = process.env.NODE_ENV !== "production";

  const handleRetry = useCallback(() => {
    // reset() unmounts the crashed subtree and re-renders the segment; the
    // refresh revalidates its server data in the same gesture.
    router.refresh();
    reset();
  }, [reset, router]);

  const handleCopy = useCallback(async () => {
    setCopyState("copying");
    try {
      // fetchHealth never throws (degraded collapse), so this stays one shot.
      const health = await fetchHealth();
      const text = buildDiagnostics({
        route: window.location.pathname,
        timestamp: new Date().toISOString(),
        health: formatHealthState(health),
        userAgent: navigator.userAgent,
        name: error.name,
        message: error.message,
        digest: error.digest,
        stack: error.stack ?? null,
      });
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }, [error]);

  return (
    <Card role="alert" className="mx-auto mt-10 max-w-xl" data-testid="crash-card">
      <CardHeader>
        <div>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription>
            An unexpected error broke this page. Retry, or copy the diagnostics for a bug report.
          </CardDescription>
        </div>
      </CardHeader>
      {isDev ? (
        <CardContent>
          <pre className="overflow-x-auto rounded-lg border border-border bg-elevated px-3 py-2 font-mono text-xs text-muted-fg">
            {`${error.name}: ${error.message}`}
            {error.digest ? `\nDigest: ${error.digest}` : ""}
          </pre>
        </CardContent>
      ) : null}
      <CardContent className="flex flex-wrap items-center gap-2">
        <Button onClick={handleRetry}>Retry</Button>
        <Button
          variant="secondary"
          onClick={() => void handleCopy()}
          disabled={copyState === "copying" || copyState === "copied"}
        >
          {COPY_LABEL[copyState]}
        </Button>
        <ButtonLink href="/" variant="ghost">
          Go home
        </ButtonLink>
      </CardContent>
    </Card>
  );
}
