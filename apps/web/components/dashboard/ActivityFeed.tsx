"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonLines } from "@/components/ui/skeleton";
import { InboxIcon, PlayIcon } from "@/components/shell/icons";
import {
  ACTIVITY_PAGE_SIZE,
  activityErrorMessage,
  fetchActivityFeed,
  isOpsActivityType,
  type ActivityItem,
  type ActivityType,
} from "@/lib/activity";
import { formatRelativeAge } from "@/lib/time";

type FeedState =
  | { phase: "loading" }
  | { phase: "ready"; items: ActivityItem[]; nextCursor?: number }
  | { phase: "error"; message: string };

const TYPE_VARIANT: Record<ActivityType, BadgeVariant> = {
  "project.created": "accent",
  "workflow.created": "info",
  "run.started": "info",
  "run.completed": "success",
  "run.failed": "danger",
  "run.aborted": "warning",
  "run.interrupted": "warning",
  // ops.* rows never render a badge (OpsRow below); entries only keep the
  // record exhaustive over the API's type union.
  "ops.daemon-boot": "neutral",
  "ops.recovery-sweep": "neutral",
  "ops.gc": "neutral",
  "ops.image-pull": "neutral",
  "ops.image-build": "neutral",
};

const TYPE_ICON: Record<ActivityType, string> = {
  "project.created": "◇",
  "workflow.created": "◆",
  "run.started": "▶",
  "run.completed": "✓",
  "run.failed": "✕",
  "run.aborted": "■",
  "run.interrupted": "⚠",
  "ops.daemon-boot": "⚙",
  "ops.recovery-sweep": "⚙",
  "ops.gc": "⚙",
  "ops.image-pull": "⬇",
  "ops.image-build": "⛏",
};

/** Icon block for one feed item (text glyphs — no per-type art assets yet). */
function ActivityGlyph({ type }: { type: ActivityType }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-elevated text-xs text-muted-fg"
    >
      {TYPE_ICON[type]}
    </span>
  );
}

/**
 * ops.* system line (#94): daemon-level events (boot, recovery sweep, GC)
 * render as one small gray line — no glyph bubble, badge or run link.
 */
function OpsRow({ item }: { item: ActivityItem }) {
  return (
    <li className="first:pt-0" data-testid="activity-ops-item">
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-fg">
        <span aria-hidden className="shrink-0">
          ⚙
        </span>
        <span className="min-w-0 truncate">{item.message}</span>
        <span className="ml-auto shrink-0 whitespace-nowrap">
          {formatRelativeAge(item.createdAt)}
        </span>
      </div>
    </li>
  );
}

function FeedRow({ item }: { item: ActivityItem }) {
  const runHref = item.run === undefined ? null : `/runs/${encodeURIComponent(item.run.id)}`;
  const body = (
    <span className="min-w-0">
      <span className="block truncate text-sm text-fg">{item.message}</span>
      <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-fg">
        <span>{formatRelativeAge(item.createdAt)}</span>
        {item.project ? <span className="truncate">· {item.project.name}</span> : null}
      </span>
    </span>
  );
  return (
    <li className="first:pt-0">
      <div className="flex items-start gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-elevated/60">
        <ActivityGlyph type={item.type} />
        {runHref !== null ? (
          <Link
            href={runHref}
            className="min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {body}
          </Link>
        ) : (
          <div className="min-w-0 flex-1">{body}</div>
        )}
        <Badge variant={TYPE_VARIANT[item.type]} className="mt-0.5 shrink-0">
          {item.type.split(".")[1]}
        </Badge>
      </div>
    </li>
  );
}

/**
 * Dashboard activity feed (#51): aggregated run/workflow/project events,
 * newest first, cursor-paginated with a Load-more button.
 */
export function ActivityFeed() {
  const [state, setState] = useState<FeedState>({ phase: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    fetchActivityFeed()
      .then((page) => {
        if (mounted.current) {
          setState({ phase: "ready", items: page.items, nextCursor: page.nextCursor });
        }
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          setState({ phase: "error", message: activityErrorMessage(cause) });
        }
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadMore = useCallback(async (): Promise<void> => {
    if (state.phase !== "ready" || state.nextCursor === undefined) return;
    setLoadingMore(true);
    try {
      const page = await fetchActivityFeed(state.nextCursor, ACTIVITY_PAGE_SIZE);
      if (mounted.current) {
        setState((current) =>
          current.phase === "ready"
            ? {
                phase: "ready",
                items: [...current.items, ...page.items],
                nextCursor: page.nextCursor,
              }
            : current,
        );
      }
    } catch {
      // Keep the current page; the next Load-more click retries.
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }, [state]);

  const reload = useCallback(async (): Promise<void> => {
    setState({ phase: "loading" });
    try {
      const page = await fetchActivityFeed();
      if (mounted.current) {
        setState({ phase: "ready", items: page.items, nextCursor: page.nextCursor });
      }
    } catch (cause: unknown) {
      if (mounted.current) {
        setState({ phase: "error", message: activityErrorMessage(cause) });
      }
    }
  }, []);

  return (
    <Card data-testid="activity-feed">
      <CardHeader>
        <div>
          <CardTitle>Activity</CardTitle>
          <CardDescription>Runs, workflows and projects across the daemon.</CardDescription>
        </div>
        {state.phase === "error" ? (
          <Button variant="secondary" size="sm" onClick={() => void reload()}>
            Retry
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {state.phase === "loading" ? (
          <SkeletonLines rows={6} />
        ) : state.phase === "error" ? (
          <div className="flex flex-col items-start gap-3 py-2 text-sm">
            <p className="text-danger">{state.message}</p>
            <p className="text-xs text-muted-fg">Activity appears once the daemon is reachable.</p>
          </div>
        ) : state.items.length === 0 ? (
          <EmptyState
            icon={<InboxIcon className="size-5" />}
            title="No activity yet"
            description="Runs, workflow creations and project registrations land here as they happen."
            action={
              <Link
                href="/projects"
                className="text-sm font-medium text-link transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Start with a project →
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-4">
            <ul className="divide-y divide-border" aria-label="Activity feed">
              {state.items.map((item) =>
                isOpsActivityType(item.type) ? (
                  <OpsRow key={item.id} item={item} />
                ) : (
                  <FeedRow key={item.id} item={item} />
                ),
              )}
            </ul>
            {state.nextCursor !== undefined ? (
              <Button
                variant="secondary"
                size="sm"
                loading={loadingMore}
                onClick={() => void loadMore()}
              >
                Load more
              </Button>
            ) : (
              <p className="flex items-center gap-1.5 text-xs text-muted-fg">
                <PlayIcon className="size-3" aria-hidden />
                That is all the activity there is.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
