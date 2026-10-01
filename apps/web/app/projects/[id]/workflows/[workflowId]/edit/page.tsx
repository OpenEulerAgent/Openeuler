import type { Metadata } from "next";
import { CanvasEditorLoader } from "@/components/workflows/canvas/CanvasEditorLoader";

export const metadata: Metadata = { title: "Edit workflow graph" };

/** The canvas editor (#46): the main edit UX for a workflow's graph. */
export default async function EditWorkflowGraphPage({
  params,
}: {
  params: Promise<{ id: string; workflowId: string }>;
}) {
  const { id, workflowId } = await params;
  return <CanvasEditorLoader projectId={id} workflowId={workflowId} />;
}
