import type { Metadata } from "next";
import { RunsList } from "@/components/RunsList";

export const metadata: Metadata = { title: "Runs" };

export default function RunsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Runs</h1>
        <p className="mt-1 text-sm text-slate-500">
          Agent executions on the daemon. Open a run to watch its live event stream.
        </p>
      </div>
      <RunsList />
    </div>
  );
}
