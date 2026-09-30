import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { HealthPill } from "@/components/HealthPill";

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-500">
            Overview of your Openeuler daemon, projects and runs.
          </p>
        </div>
        <HealthPill />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Recent projects" description="Repositories registered with the daemon.">
          <div className="flex flex-col items-start gap-3 py-6 text-sm text-slate-500">
            <p>No projects yet.</p>
            <Button disabled title="Projects API is coming soon (#6)">
              Open a project…
            </Button>
          </div>
        </Card>

        <Card title="Active runs" description="Workflow runs currently queued or executing.">
          <div className="flex flex-col items-start gap-3 py-6 text-sm text-slate-500">
            <p>No active runs.</p>
            <p className="text-xs">Runs appear here once you start a workflow.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
