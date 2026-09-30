import type { Metadata } from "next";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold text-slate-900">Projects</h1>
      <p className="text-sm text-slate-500">
        Project management arrives with the daemon projects API (#6). For now, head back to the
        dashboard.
      </p>
    </div>
  );
}
