import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { RunCompareView } from "@/components/run/RunCompareView";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonLines } from "@/components/ui/skeleton";
import { parseCompareQuery } from "@/lib/run-compare";

export const metadata: Metadata = { title: "Compare runs" };

/**
 * Run compare (#114): `/runs/compare?a=<id>&b=<id>` — deep-linked from the
 * runs table (select two → Compare). Missing ids fall back to a picker hint
 * instead of a broken comparison.
 */
export default async function RunComparePage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const params = await searchParams;
  const { a, b } = parseCompareQuery(new URLSearchParams(params));

  if (a === null || b === null) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-display font-semibold text-fg">Compare runs</h1>
          <p className="mt-1 text-sm text-muted-fg">
            Pick two runs to see what changed between attempts.
          </p>
        </div>
        <EmptyState
          title="Two run ids needed"
          description="Open the runs table, tick exactly two runs and hit Compare — or share a link like /runs/compare?a=<runId>&b=<runId>."
          action={
            <Link
              href="/"
              className="text-sm font-medium text-link transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Go to the runs table →
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <Suspense fallback={<SkeletonLines rows={8} />}>
      <RunCompareView aId={a} bId={b} />
    </Suspense>
  );
}
