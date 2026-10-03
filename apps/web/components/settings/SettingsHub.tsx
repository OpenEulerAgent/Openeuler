"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { SkeletonLines } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { SandboxImagesCard } from "@/components/settings/SandboxImagesCard";
import {
  DEFAULT_PURGE_DAYS,
  PURGE_CONFIRM_WORD,
  fetchSystemSettings,
  formatBytes,
  formatUptime,
  maintenanceToast,
  runMaintenance,
  usagePercent,
  type MaintenanceAction,
  type SystemSettings,
} from "@/lib/settings";

/**
 * Settings hub (#95): daemon facts cards (System, Drivers, Concurrency,
 * Storage), the Sandbox section (#100: image catalog + pull/build/delete),
 * and the Danger Zone maintenance actions. Everything is read-only except
 * maintenance and sandbox images; each action confirms in a dialog
 * (type-to-confirm for the purge), reports its outcome as a toast, and
 * refreshes the payload.
 */
export function SettingsHub() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<MaintenanceAction | null>(null);
  const [busyAction, setBusyAction] = useState<MaintenanceAction | null>(null);

  const load = useCallback((refresh = false) => {
    fetchSystemSettings(undefined, { refresh })
      .then((payload) => {
        setSettings(payload);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const copy = useCallback(
    async (label: string, value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        toast({ title: "Copied to clipboard", description: label, variant: "info" });
      } catch {
        toast({ title: "Copy failed", description: label, variant: "danger" });
      }
    },
    [toast],
  );

  const execute = useCallback(
    async (action: MaintenanceAction, days?: number) => {
      setBusyAction(action);
      try {
        const result = await runMaintenance(action, days === undefined ? {} : { days });
        const toastCopy = maintenanceToast(result);
        toast({ title: toastCopy.title, description: toastCopy.description, variant: "success" });
        load(true);
      } catch (err) {
        toast({
          title: "Maintenance failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "danger",
        });
      } finally {
        setBusyAction(null);
        setConfirming(null);
      }
    },
    [load, toast],
  );

  if (failed && settings === null) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            title="Could not load daemon settings"
            description="The daemon did not answer the settings request."
            action={
              <Button variant="secondary" onClick={() => load(true)}>
                Retry
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  const s = settings;
  return (
    <>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>System</CardTitle>
            <CardDescription>Daemon build, uptime and data locations.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {s === null ? (
            <SkeletonLines rows={4} />
          ) : (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Fact label="Version">{s.version}</Fact>
              <Fact label="Uptime">{formatUptime(s.uptimeSeconds)}</Fact>
              <Fact label="Database">
                <span
                  className="block truncate font-mono text-xs text-fg"
                  title={s.dbPath ?? undefined}
                >
                  {s.dbPath ?? "not configured"}
                </span>
                <span className="text-xs text-muted-fg">{formatBytes(s.dbBytes)}</span>
                {s.dbPath === null ? null : (
                  <CopyButton onClick={() => void copy("Database path", s.dbPath ?? "")} />
                )}
              </Fact>
              <Fact label="Worktree store">
                <span className="block truncate font-mono text-xs text-fg" title={s.worktreeRoot}>
                  {s.worktreeRoot}
                </span>
                <CopyButton onClick={() => void copy("Worktree store path", s.worktreeRoot)} />
              </Fact>
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Drivers</CardTitle>
            <CardDescription>
              Registered agent drivers; the first one is the default.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          {s === null ? (
            <SkeletonLines rows={2} />
          ) : s.drivers.length === 0 ? (
            <p className="text-sm text-muted-fg">No drivers registered.</p>
          ) : (
            s.drivers.map((driver) => (
              <Badge key={driver.id} variant={driver.id === s.defaultDriver ? "accent" : "neutral"}>
                {driver.id}
                {driver.id === s.defaultDriver ? " (default)" : ""}
              </Badge>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Concurrency</CardTitle>
            <CardDescription>How many runs execute at once.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {s === null ? (
            <SkeletonLines rows={2} />
          ) : (
            <>
              <p className="text-sm text-fg">
                <span className="font-semibold">{s.maxConcurrentRuns}</span> concurrent{" "}
                {s.maxConcurrentRuns === 1 ? "run" : "runs"}
              </p>
              <p className="mt-1 text-xs text-muted-fg">
                Read-only — set MAX_CONCURRENT_RUNS in the daemon environment and restart to change.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Storage</CardTitle>
            <CardDescription>
              Bytes on disk; bars share one scale (the larger usage is full width).
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {s === null ? (
            <SkeletonLines rows={3} />
          ) : (
            <StorageRows
              worktreeBytes={s.worktreeBytes}
              worktreeRoot={s.worktreeRoot}
              dbBytes={s.dbBytes}
              dbPath={s.dbPath}
            />
          )}
        </CardContent>
      </Card>

      {/* Sandbox section (#100): image catalog + pull/build/delete forms. */}
      <SandboxImagesCard />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Danger zone</CardTitle>
            <CardDescription>
              Destructive maintenance. Every action asks for confirmation first.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <DangerRow
            title="Prune worktrees"
            description="Remove orphaned run worktrees from the store. Live worktrees are never touched."
            buttonLabel="Prune worktrees"
            disabled={busyAction !== null}
            onOpen={() => setConfirming("prune-worktrees")}
          />
          <DangerRow
            title="Purge old events"
            description="Delete the event log of terminal runs older than a cutoff. Runs themselves are kept."
            buttonLabel="Purge old events"
            disabled={busyAction !== null}
            onOpen={() => setConfirming("purge-events")}
          />
          <DangerRow
            title="Vacuum database"
            description="Rebuild the SQLite file to reclaim space left by deletions."
            buttonLabel="Vacuum database"
            disabled={busyAction !== null}
            onOpen={() => setConfirming("vacuum")}
          />
        </CardContent>
      </Card>

      <MaintenanceDialog
        action={confirming}
        busy={busyAction !== null && busyAction === confirming}
        onClose={() => setConfirming(null)}
        onConfirm={(action, days) => void execute(action, days)}
      />
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-fg">{label}</dt>
      <dd className="flex flex-col gap-1 text-sm text-fg">{children}</dd>
    </div>
  );
}

function CopyButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="self-start" onClick={onClick}>
      Copy
    </Button>
  );
}

function UsageBar({ label, value, max }: { label: string; value: number | null; max: number }) {
  const percent = usagePercent(value, max);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-mono text-xs text-fg" title={label}>
          {label}
        </span>
        <span className="text-xs text-muted-fg">{formatBytes(value)}</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-elevated"
        role="progressbar"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function StorageRows({
  worktreeBytes,
  worktreeRoot,
  dbBytes,
  dbPath,
}: {
  worktreeBytes: number | null;
  worktreeRoot: string;
  dbBytes: number | null;
  dbPath: string | null;
}) {
  const scale = Math.max(worktreeBytes ?? 0, dbBytes ?? 0, 1);
  return (
    <div className="flex flex-col gap-4">
      <UsageBar label={worktreeRoot} value={worktreeBytes} max={scale} />
      <UsageBar label={dbPath ?? "database"} value={dbBytes} max={scale} />
    </div>
  );
}

function DangerRow({
  title,
  description,
  buttonLabel,
  disabled,
  onOpen,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  disabled: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{title}</p>
        <p className="text-xs text-muted-fg">{description}</p>
      </div>
      <Button variant="danger" disabled={disabled} onClick={onOpen}>
        {buttonLabel}
      </Button>
    </div>
  );
}

const DIALOG_COPY: Record<MaintenanceAction, { title: string; body: string; confirm: string }> = {
  "prune-worktrees": {
    title: "Prune worktrees",
    body: "Orphaned run worktree directories will be removed from the store. Live worktrees of existing runs are never touched.",
    confirm: "Confirm prune",
  },
  "purge-events": {
    title: "Purge old events",
    body: "The event log of terminal runs older than the cutoff will be deleted. The runs themselves (and their diffs) are kept.",
    confirm: "Confirm purge",
  },
  vacuum: {
    title: "Vacuum database",
    body: "The SQLite database file will be rebuilt in place to reclaim disk space. This can take a moment on large databases.",
    confirm: "Confirm vacuum",
  },
};

function MaintenanceDialog({
  action,
  busy,
  onClose,
  onConfirm,
}: {
  action: MaintenanceAction | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (action: MaintenanceAction, days?: number) => void;
}) {
  const [days, setDays] = useState<string>(String(DEFAULT_PURGE_DAYS));
  const [confirmWord, setConfirmWord] = useState("");

  // Reset the form whenever a dialog opens.
  useEffect(() => {
    if (action !== null) {
      setDays(String(DEFAULT_PURGE_DAYS));
      setConfirmWord("");
    }
  }, [action]);

  if (action === null) return null;
  const copy = DIALOG_COPY[action];
  const parsedDays = Number.parseInt(days, 10);
  const daysValid =
    action !== "purge-events" ||
    (Number.isInteger(parsedDays) && parsedDays >= 0 && parsedDays <= 3650);
  const typedOk = action !== "purge-events" || confirmWord.trim() === PURGE_CONFIRM_WORD;

  return (
    <Dialog open={action !== null} onClose={onClose} label={copy.title} disableClose={busy}>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold text-fg">{copy.title}</h2>
          <p className="mt-1 text-sm text-muted-fg">{copy.body}</p>
        </div>
        {action === "purge-events" ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm text-fg">
              Delete events of terminal runs older than (days)
              <Input
                id="purge-days"
                type="number"
                min={0}
                value={days}
                invalid={!daysValid}
                onChange={(event) => setDays(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-fg">
              Type <span className="font-mono font-semibold">{PURGE_CONFIRM_WORD}</span> to confirm
              <Input
                id="purge-confirm"
                value={confirmWord}
                placeholder={PURGE_CONFIRM_WORD}
                onChange={(event) => setConfirmWord(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy || !daysValid || !typedOk}
            onClick={() => onConfirm(action, action === "purge-events" ? parsedDays : undefined)}
          >
            {copy.confirm}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
