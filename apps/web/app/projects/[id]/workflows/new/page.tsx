import type { Metadata } from "next";
import { NewWorkflowForm } from "@/components/workflows/canvas/NewWorkflowForm";

export const metadata: Metadata = { title: "New workflow" };

/** Create a workflow (name + starter graph), then edit it on the canvas. */
export default async function NewWorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NewWorkflowForm projectId={id} />;
}
