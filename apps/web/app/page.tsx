import { Suspense } from "react";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { DashboardRunsTable } from "@/components/dashboard/DashboardRunsTable";
import { FreshInstallWizardRedirect } from "@/components/dashboard/FreshInstallWizardRedirect";
import { ProjectCardsRow } from "@/components/dashboard/ProjectCardsRow";
import { SandboxesSection } from "@/components/dashboard/SandboxesSection";
import { SkeletonLines } from "@/components/ui/skeleton";

/** Dashboard 2.0 (#51): project cards on top, activity feed + live runs table. */
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* Fresh install (no projects, no workflows): straight to the wizard (#53). */}
      <FreshInstallWizardRedirect />
      <div>
        <h1 className="text-display font-semibold text-fg">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-fg">
          Your projects, live runs and everything that happened lately.
        </p>
      </div>

      <section aria-label="Projects">
        <ProjectCardsRow />
      </section>

      {/* Sandboxes dashboard (#112): active containers, between the project
          cards and the activity/runs grid. */}
      <SandboxesSection />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(320px,2fr)_3fr]">
        <ActivityFeed />
        <Suspense fallback={<SkeletonLines rows={8} />}>
          <DashboardRunsTable />
        </Suspense>
      </div>
    </div>
  );
}
