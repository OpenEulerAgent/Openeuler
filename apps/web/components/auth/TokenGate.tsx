"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { onUnauthorized, takePendingRetry } from "@/lib/auth-gate";
import { clearStoredToken, storeToken } from "@/lib/token";

/**
 * Full-page token gate (#92): renders whenever the daemon answers 401 (the
 * bearer token is missing or wrong). Enter the daemon's `OPENEULER_TOKEN` →
 * save → the failed action is retried with the new token; on success the
 * page reloads so SSE connections pick up the token too.
 */
export function TokenGate({ reload = (): void => window.location.reload() }: { reload?: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      onUnauthorized(() => {
        setError(null);
        setOpen(true);
      }),
    [],
  );

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const save = async (): Promise<void> => {
    const token = value.trim();
    if (token.length === 0 || busy) {
      if (token.length === 0) setError("Enter the daemon token first");
      return;
    }
    setBusy(true);
    setError(null);
    storeToken(token);

    const retry = takePendingRetry();
    if (retry === null) {
      // Nothing to replay (e.g. a failed EventSource) — heal globally.
      setOpen(false);
      setBusy(false);
      reload();
      return;
    }
    try {
      await retry();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Daemon rejected this token too — clear it and let the user retry.
        clearStoredToken();
        setError("The daemon rejected this token — check OPENEULER_TOKEN and try again");
        setBusy(false);
        return;
      }
      // Failed for a non-auth reason (e.g. daemon briefly down) — the token
      // is likely fine; heal globally.
    }
    setOpen(false);
    setBusy(false);
    reload();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Daemon token required"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-bg/80 p-4 backdrop-blur-sm"
    >
      <Card className="w-full max-w-md">
        <CardHeader>
          <div>
            <CardTitle>Daemon token required</CardTitle>
            <CardDescription>
              The daemon rejected the last request (401). Enter its OPENEULER_TOKEN to continue —
              it is stored in this browser only.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Input
              ref={inputRef}
              type="password"
              name="openeuler-token"
              autoComplete="off"
              placeholder="OPENEULER_TOKEN"
              value={value}
              invalid={error !== null}
              onChange={(event) => setValue(event.target.value)}
              aria-label="Daemon token"
            />
            {error ? (
              <p className="text-xs text-danger" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Not now
              </Button>
              <Button type="submit" loading={busy}>
                Save token
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
