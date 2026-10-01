import type { Metadata } from "next";
import Link from "next/link";
import { WorkflowsList } from "@/components/workflows/WorkflowsList";

export const metadata: Metadata = { title: "Workflows" };

export default async function ProjectWorkflowsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          href={`/projects/${encodeURIComponent(id)}`}
          className="text-sm font-medium text-muted-fg transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          ← Back to workspace
        </Link>
      </div>
      <WorkflowsList projectId={id} />
    </div>
  );
}
