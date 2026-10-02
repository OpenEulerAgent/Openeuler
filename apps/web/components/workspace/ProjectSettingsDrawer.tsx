"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import {
  deleteProjectSecret,
  fetchProjectSecrets,
  isSecretsUnavailable,
  putProjectSecret,
  secretNameIssue,
  type ProjectSecretName,
} from "@/lib/secrets-api";

/**
 * Project settings drawer (#93). v0.2 ships the Secrets pane: per-project
 * env vars injected into every run, stored encrypted on the daemon. Values
 * are write-only — the list shows names, the form never echoes what was
 * typed, and nothing secret is ever rendered.
 */

const formatCreated = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
};

export function ProjectSettingsDrawer({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [secrets, setSecrets] = useState<ProjectSecretName[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadFailed(false);
    setUnavailable(false);
    try {
      setSecrets(await fetchProjectSecrets(projectId));
    } catch (cause) {
      if (isSecretsUnavailable(cause)) {
        setUnavailable(true);
        setSecrets([]);
        return;
      }
      setLoadFailed(true);
      setSecrets([]);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async () => {
    const trimmedName = name.trim();
    if (saving || trimmedName.length === 0 || value.length === 0) return;
    const issue = secretNameIssue(trimmedName);
    if (issue !== null) {
      setFormError(issue);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const existed = secrets?.some((secret) => secret.name === trimmedName) ?? false;
      await putProjectSecret(projectId, trimmedName, value);
      setName("");
      setValue("");
      toast({
        variant: "success",
        title: existed ? `Rotated ${trimmedName}` : `Saved ${trimmedName}`,
        description: "The value is stored encrypted and injected into this project's runs.",
      });
      await refresh();
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : "Failed to save the secret";
      setFormError(message);
      toast({ variant: "danger", title: "Could not save secret", description: message });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (secretName: string) => {
    setConfirmingDelete(null);
    try {
      await deleteProjectSecret(projectId, secretName);
      toast({ variant: "success", title: `Deleted ${secretName}` });
      await refresh();
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : "Failed to delete the secret";
      toast({ variant: "danger", title: `Could not delete ${secretName}`, description: message });
    }
  };

  return (
    <Drawer open onClose={onClose} label="Project settings">
      <h2 className="text-title font-semibold text-fg">Project settings</h2>
      <p className="mt-0.5 text-sm text-muted-fg">
        Credentials for this project&apos;s runs. Values are stored encrypted on the daemon and
        redacted from all run output.
      </p>

      <section className="mt-5" aria-label="Secrets">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-fg">Secrets</h3>
          {secrets !== null && secrets.length > 0 ? (
            <Badge variant="neutral">{secrets.length}</Badge>
          ) : null}
        </div>

        {unavailable ? (
          <p className="mt-3 rounded-md border border-border bg-elevated px-3 py-2 text-xs text-muted-fg">
            This daemon has no secret key loaded, so secrets are unavailable. Restart the daemon
            with a writable data directory (or set <code>OPENEULER_SECRET_KEY</code>) to enable
            them.
          </p>
        ) : null}

        {loadFailed ? (
          <div className="mt-3 flex flex-col items-start gap-2 text-sm">
            <p className="text-danger">Could not load secrets.</p>
            <Button variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        ) : secrets === null ? (
          <p className="mt-3 text-sm text-muted-fg" role="status">
            Loading secrets…
          </p>
        ) : secrets.length === 0 ? (
          <EmptyState
            className="py-6"
            title="No secrets yet"
            description="Add an env var like NPM_TOKEN and every run of this project receives it."
          />
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
            {secrets.map((secret) => (
              <li key={secret.name} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm font-medium text-fg">{secret.name}</p>
                  <p className="text-xs text-muted-fg">added {formatCreated(secret.createdAt)}</p>
                </div>
                {confirmingDelete === secret.name ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => void remove(secret.name)}
                      aria-label={`Confirm delete ${secret.name}`}
                    >
                      Delete
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setConfirmingDelete(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setName(secret.name);
                        setValue("");
                        setFormError(null);
                      }}
                    >
                      Rotate
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmingDelete(secret.name)}
                      aria-label={`Delete ${secret.name}`}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field
            label="Name"
            hint="(env-var style, e.g. NPM_TOKEN)"
            htmlFor="secret-name"
            error={formError ?? undefined}
          >
            <Input
              id="secret-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="NPM_TOKEN"
              autoComplete="off"
              spellCheck={false}
              invalid={formError !== null}
            />
          </Field>
          <Field label="Value" hint="(write-only — never displayed again)" htmlFor="secret-value">
            <Input
              id="secret-value"
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="paste the token"
              autoComplete="new-password"
            />
          </Field>
          <div className="flex justify-end">
            <Button
              type="submit"
              loading={saving}
              disabled={name.trim().length === 0 || value.length === 0 || unavailable}
            >
              {secrets?.some((secret) => secret.name === name.trim())
                ? "Rotate secret"
                : "Save secret"}
            </Button>
          </div>
        </form>
      </section>
    </Drawer>
  );
}
