import type { Metadata } from "next";
import { WelcomeWizard } from "@/components/onboarding/WelcomeWizard";

export const metadata: Metadata = { title: "Welcome" };

/**
 * Onboarding wizard route (#53). Auto-started by the dashboard on a fresh
 * install; always reachable directly and re-runnable from Settings.
 */
export default function WelcomePage() {
  return <WelcomeWizard />;
}
