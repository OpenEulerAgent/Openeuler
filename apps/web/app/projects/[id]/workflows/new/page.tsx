import type { Metadata } from "next";
import { WorkflowEditorView } from "@/components/workflows/WorkflowEditor";

export const metadata: Metadata = { title: "New workflow" };

export default async function NewWorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkflowEditorView projectId={id} />;
}
