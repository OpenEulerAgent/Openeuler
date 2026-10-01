import type { Metadata } from "next";
import { ProjectsView } from "@/components/workspace/ProjectsView";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-display font-semibold text-fg">Projects</h1>
        <p className="mt-1 text-sm text-muted-fg">
          Open a local git working copy to browse its files and run the agent against it.
        </p>
      </div>
      <ProjectsView />
    </div>
  );
}
