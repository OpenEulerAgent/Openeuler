"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchAuthStatus } from "@/lib/auth-status";
import { clearStoredToken, getStoredToken } from "@/lib/token";

/**
 * Daemon access card for the settings page (#92): shows whether the daemon
 * runs with token auth (open `GET /api/system/auth-status`) and whether
 * this browser has a token saved.
 */
export function AuthStatusCard() {
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAuthRequired(null);
    setFailed(false);
    fetchAuthStatus()
      .then((status) => {
        if (!cancelled) setAuthRequired(status.authRequired);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setHasToken(getStoredToken() !== null);
  }, []);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Daemon access</CardTitle>
          <CardDescription>
            Bearer-token auth is opt-in on the daemon (OPENEULER_TOKEN env var).
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        {authRequired === null ? (
          <Badge variant={failed ? "danger" : "neutral"}>{failed ? "unknown" : "checking…"}</Badge>
        ) : (
          <Badge variant={authRequired ? "warning" : "success"}>
            {authRequired ? "Auth enabled" : "Auth disabled"}
          </Badge>
        )}
        {authRequired === true ? (
          hasToken ? (
            <>
              <Badge variant="accent">token saved in this browser</Badge>
              <Button
                variant="secondary"
                onClick={() => {
                  clearStoredToken();
                  setHasToken(false);
                }}
              >
                Forget token
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted-fg">
              No token saved — the app prompts for it on the next rejected request.
            </p>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
