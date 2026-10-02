"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AuthStatusCard } from "@/components/settings/AuthStatusCard";
import { SettingsHub } from "@/components/settings/SettingsHub";
import { useThemeContext } from "@/components/ThemeProvider";
import { useSidebarPreference } from "@/components/shell/sidebar-preference";
import { daemonBaseUrl } from "@/lib/api";
import { isOnboardingCompleted } from "@/lib/onboarding/wizard";
import { toggleSidebarPreference } from "@/lib/sidebar";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Settings shell (issue #50 → hub in #95): local preferences (theme, sidebar,
 * wizard rerun), the daemon access card (#92), the daemon facts hub
 * (System / Drivers / Concurrency / Storage / Danger zone) and the API base
 * URL in use.
 */
export default function SettingsPage() {
  const router = useRouter();
  const { theme, setTheme } = useThemeContext();
  const [sidebarPref, setSidebarPref] = useSidebarPreference();
  const [onboardingCompleted, setOnboardingCompleted] = useState(true);

  useEffect(() => {
    setOnboardingCompleted(isOnboardingCompleted(window.localStorage));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-display font-semibold text-fg">Settings</h1>
        <p className="mt-1 text-sm text-muted-fg">
          Preferences and daemon facts. Danger zone actions maintain the local data.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Dark is the default theme; light is opt-in.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Badge variant={theme === "dark" ? "accent" : "neutral"}>dark (default)</Badge>
          <Badge variant={theme === "light" ? "accent" : "neutral"}>light</Badge>
          <Button variant="secondary" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            Switch to {theme === "dark" ? "light" : "dark"} theme
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Sidebar</CardTitle>
            <CardDescription>
              Default state of the left sidebar; the choice persists across reloads.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Badge variant={sidebarPref === "expanded" ? "accent" : "neutral"}>expanded</Badge>
          <Badge variant={sidebarPref === "collapsed" ? "accent" : "neutral"}>collapsed</Badge>
          <Button
            variant="secondary"
            onClick={() => setSidebarPref(toggleSidebarPreference(sidebarPref))}
          >
            Default to {sidebarPref === "expanded" ? "collapsed" : "expanded"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Getting started</CardTitle>
            <CardDescription>
              The setup wizard checks your environment, opens a project and launches a starter.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Badge variant={onboardingCompleted ? "success" : "neutral"}>
            {onboardingCompleted ? "completed" : "not completed"}
          </Badge>
          <Button variant="secondary" onClick={() => router.push("/welcome")}>
            Re-run setup wizard
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Daemon</CardTitle>
            <CardDescription>API base URL used by this browser session.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <p className="truncate rounded-md border border-border bg-elevated px-3 py-2 font-mono text-sm text-fg">
            {daemonBaseUrl()}
          </p>
          <p className="mt-2 text-xs text-muted-fg">
            Configured via NEXT_PUBLIC_DAEMON_URL at build time.
          </p>
        </CardContent>
      </Card>

      <AuthStatusCard />

      <SettingsHub />
    </div>
  );
}
