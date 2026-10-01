"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Project, Workflow } from "@openeuler/core";
import { apiFetch } from "@/lib/api";
import { isFreshInstall, isOnboardingCompleted } from "@/lib/onboarding/wizard";

/**
 * Auto-starts the onboarding wizard (#53): on a fresh install (no projects
 * AND no workflows) and before completion is remembered, the dashboard
 * redirects to /welcome. Any failure or non-fresh state is a no-op — the
 * dashboard stays perfectly usable without the wizard.
 */
export function FreshInstallWizardRedirect() {
  const router = useRouter();

  useEffect(() => {
    if (isOnboardingCompleted(window.localStorage)) return;
    let cancelled = false;
    void (async () => {
      try {
        const [projectsBody, workflowsBody] = await Promise.all([
          apiFetch<{ projects: Project[] }>("/api/projects"),
          apiFetch<{ workflows: Workflow[] }>("/api/workflows"),
        ]);
        if (!cancelled && isFreshInstall(projectsBody.projects, workflowsBody.workflows)) {
          router.replace("/welcome");
        }
      } catch {
        // Daemon unreachable: dashboard error states handle it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
