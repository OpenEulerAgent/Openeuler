import type { Metadata } from "next";
import { RunDetailView } from "@/components/run/RunDetailView";

export const metadata: Metadata = { title: "Run detail" };

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunDetailView runId={id} />;
}
