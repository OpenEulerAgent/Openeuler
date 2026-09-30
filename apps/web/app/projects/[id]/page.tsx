import type { Metadata } from "next";
import { WorkspaceView } from "@/components/workspace/WorkspaceView";

export const metadata: Metadata = { title: "Project workspace" };

export default async function ProjectWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <WorkspaceView projectId={id} />;
}
