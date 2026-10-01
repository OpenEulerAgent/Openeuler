import type { Metadata } from "next";
import { Suspense } from "react";
import { SkeletonLines } from "@/components/ui/skeleton";
import { RunDetailView } from "@/components/run/RunDetailView";

export const metadata: Metadata = { title: "Run detail" };

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<SkeletonLines rows={6} />}>
      <RunDetailView runId={id} />
    </Suspense>
  );
}
