import type { Metadata } from "next";

export const metadata: Metadata = { title: "Runs" };

export default function RunsPage() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold text-slate-900">Runs</h1>
      <p className="text-sm text-slate-500">
        Run history and live run views arrive with the runs API. For now, head back to the
        dashboard.
      </p>
    </div>
  );
}
