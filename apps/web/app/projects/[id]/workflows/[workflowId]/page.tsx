import { redirect } from "next/navigation";

/**
 * The step-list editor was replaced by the graph canvas (#46); this route
 * now forwards to the canvas editor so old links keep working.
 */
export default async function EditWorkflowRedirectPage({
  params,
}: {
  params: Promise<{ id: string; workflowId: string }>;
}) {
  const { id, workflowId } = await params;
  redirect(`/projects/${encodeURIComponent(id)}/workflows/${encodeURIComponent(workflowId)}/edit`);
}
