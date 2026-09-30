import type { Metadata } from "next";
import { WorkflowEditorView } from "@/components/workflows/WorkflowEditor";

export const metadata: Metadata = { title: "Edit workflow" };

export default async function EditWorkflowPage({
  params,
}: {
  params: Promise<{ id: string; workflowId: string }>;
}) {
  const { id, workflowId } = await params;
  return <WorkflowEditorView projectId={id} workflowId={workflowId} />;
}
