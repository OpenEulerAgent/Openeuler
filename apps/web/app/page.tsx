import { ActiveRunsCard } from "@/components/ActiveRunsCard";
import { RecentProjectsCard } from "@/components/RecentProjectsCard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-display font-semibold text-fg">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-fg">
          Overview of your Openeuler daemon, projects and runs.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Recent projects</CardTitle>
              <CardDescription>Repositories registered with the daemon.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <RecentProjectsCard />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Active runs</CardTitle>
              <CardDescription>
                Workflow runs currently queued or executing, polled from /api/runs/stats.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ActiveRunsCard />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
