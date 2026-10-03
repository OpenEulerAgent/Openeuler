"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProjectSandboxPolicy, SandboxNetworkMode } from "@openeuler/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { fetchProjectPolicy, patchProjectPolicy, policyIssue } from "@/lib/policy-api";
import { fetchSandboxImages, type SandboxImageEntry } from "@/lib/sandbox-api";
import {
  deleteProjectSecret,
  fetchProjectSecrets,
  isSecretsUnavailable,
  putProjectSecret,
  secretNameIssue,
  type ProjectSecretName,
} from "@/lib/secrets-api";

/**
 * Project settings drawer (#93 secrets, #101 sandbox policy). v0.2 ships
 * two panes: per-project env vars (values write-only, stored encrypted on
 * the daemon) and the sandbox policy (execution mode, image, resources,
 * network exposure) every sandboxed run of the project executes under.
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
        Credentials and sandbox defaults for this project&apos;s runs. Secret values are stored
        encrypted on the daemon and redacted from all run output.
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

      <SandboxPolicySection projectId={projectId} />
    </Drawer>
  );
}

/** Clamp bounds mirrored from the core schema messages. */
const CPUS_MIN = 1;
const CPUS_MAX = 8;
const MEMORY_MB_MIN = 512;
const MEMORY_MB_MAX = 8192;
const MEMORY_MB_STEP = 256;

const EXECUTION_MODE_COPY: Record<string, string> = {
  auto: "auto — prefer a sandbox when one is available, otherwise run on the daemon host",
  local: "local — always run directly on the daemon host (no sandboxing)",
  sandbox: "sandbox — always run inside a sandbox; a run fails fast when no image is configured",
};

type PolicyLoad = "loading" | "failed" | "ready";

/**
 * The Sandbox pane (#101): edits the project's whole sandbox policy and
 * PATCHes it. Fields left empty mean "not set" (the provider's own default
 * applies); the image picker lists the daemon's image catalog with the
 * daemon-built `openeuler/` images first.
 */
function SandboxPolicySection({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [load, setLoad] = useState<PolicyLoad>("loading");
  const [images, setImages] = useState<SandboxImageEntry[] | null>(null);
  // v0.2 default: "local" — sandboxed execution is opt-in (#102).
  const [mode, setMode] = useState<ProjectSandboxPolicy["executionMode"]>("local");
  const [image, setImage] = useState("");
  const [cpus, setCpus] = useState(2);
  const [memoryMb, setMemoryMb] = useState(2048);
  const [network, setNetwork] = useState<"" | SandboxNetworkMode>("");
  const [keepForDebug, setKeepForDebug] = useState(false);
  /** Carried through on save (the v0.2 form does not edit it). */
  const [cachePaths, setCachePaths] = useState<string[] | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(() => {
    setLoad("loading");
    fetchProjectPolicy(projectId)
      .then((policy) => {
        if (policy !== null) {
          setMode(policy.executionMode);
          setImage(policy.image ?? "");
          setCpus(policy.cpus ?? 2);
          setMemoryMb(policy.memoryMb ?? 2048);
          setNetwork(policy.network ?? "");
          setKeepForDebug(policy.keepForDebug === true);
          setCachePaths(policy.cachePaths);
        }
        setLoad("ready");
      })
      .catch(() => setLoad("failed"));
    fetchSandboxImages()
      .then((catalog) =>
        setImages(
          [...catalog].sort(
            (a, b) => Number(b.ours) - Number(a.ours) || a.repository.localeCompare(b.repository),
          ),
        ),
      )
      .catch(() => setImages(null));
  }, [projectId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const applySaved = (policy: ProjectSandboxPolicy): void => {
    setMode(policy.executionMode);
    setImage(policy.image ?? "");
    setCpus(policy.cpus ?? 2);
    setMemoryMb(policy.memoryMb ?? 2048);
    setNetwork(policy.network ?? "");
    setKeepForDebug(policy.keepForDebug === true);
    setCachePaths(policy.cachePaths);
  };

  const submit = async () => {
    if (saving) return;
    const trimmedImage = image.trim();
    const next = {
      executionMode: mode,
      ...(trimmedImage.length === 0 ? {} : { image: trimmedImage }),
      cpus,
      memoryMb,
      ...(network === "" ? {} : { network }),
      keepForDebug,
      ...(cachePaths === undefined ? {} : { cachePaths }),
    };
    const issue = policyIssue(next);
    if (issue !== null) {
      setError(issue);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await patchProjectPolicy(projectId, next as ProjectSandboxPolicy);
      applySaved(saved);
      toast({
        variant: "success",
        title: "Sandbox policy saved",
        description: "Sandboxed runs of this project will use these defaults.",
      });
    } catch (cause) {
      const detail =
        cause instanceof ApiError && cause.details && cause.details.length > 0
          ? `${cause.message} (${cause.details[0]?.path}: ${cause.details[0]?.message})`
          : cause instanceof ApiError
            ? cause.message
            : "Failed to save the sandbox policy";
      setError(detail);
      toast({ variant: "danger", title: "Could not save policy", description: detail });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-6 border-t border-border pt-5" aria-label="Sandbox">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-fg">
        Sandbox policy
      </h3>

      {load === "loading" ? (
        <p className="mt-3 text-sm text-muted-fg" role="status">
          Loading sandbox policy…
        </p>
      ) : load === "failed" ? (
        <div className="mt-3 flex flex-col items-start gap-2 text-sm">
          <p className="text-danger">Could not load the sandbox policy.</p>
          <Button variant="secondary" onClick={loadAll}>
            Retry
          </Button>
        </div>
      ) : (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          data-sandbox-policy-form
        >
          <Field label="Execution mode" htmlFor="policy-execution-mode" hint="(per project)">
            <Select
              id="policy-execution-mode"
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as ProjectSandboxPolicy["executionMode"])
              }
            >
              <option value="auto">auto</option>
              <option value="local">local</option>
              <option value="sandbox">sandbox</option>
            </Select>
            <p className="text-xs text-muted-fg" data-execution-mode-copy>
              {EXECUTION_MODE_COPY[mode] ?? ""}
            </p>
          </Field>

          <Field
            label="Image"
            hint="(required for sandbox runs)"
            htmlFor="policy-image"
            error={error?.includes("image") === true && error !== null ? error : undefined}
          >
            {images !== null &&
            images.length > 0 &&
            (image === "" ||
              images.some((entry) => `${entry.repository}:${entry.tag}` === image)) ? (
              <Select
                id="policy-image"
                value={image}
                onChange={(event) => setImage(event.target.value)}
              >
                <option value="">not set</option>
                {images.map((entry) => {
                  const ref = `${entry.repository}:${entry.tag}`;
                  return (
                    <option key={`${entry.id}-${ref}`} value={ref}>
                      {entry.ours ? "★ " : ""}
                      {ref}
                    </option>
                  );
                })}
              </Select>
            ) : (
              <Input
                id="policy-image"
                value={image}
                onChange={(event) => setImage(event.target.value)}
                placeholder="openeuler/worker:latest"
                className="font-mono"
                spellCheck={false}
                autoComplete="off"
              />
            )}
            <p className="text-xs text-muted-fg">
              {images !== null && images.length > 0
                ? "From the daemon image catalog (★ = built via this daemon). Manage images in Settings → Sandbox."
                : "No catalog images available — type a reference or pull one in Settings → Sandbox."}
            </p>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="CPUs" hint={`(${CPUS_MIN}–${CPUS_MAX} cores)`} htmlFor="policy-cpus">
              <div className="flex items-center gap-2">
                <input
                  id="policy-cpus"
                  type="range"
                  min={CPUS_MIN}
                  max={CPUS_MAX}
                  step={1}
                  value={cpus}
                  onChange={(event) => setCpus(Number(event.target.value))}
                  className="w-full accent-accent"
                  aria-label="CPUs"
                />
                <Input
                  id="policy-cpus-num"
                  type="number"
                  min={CPUS_MIN}
                  max={CPUS_MAX}
                  step={1}
                  value={cpus}
                  onChange={(event) => setCpus(Number(event.target.value))}
                  className="w-16"
                  aria-label="CPUs (number)"
                />
              </div>
            </Field>
            <Field
              label="Memory"
              hint={`(${MEMORY_MB_MIN}–${MEMORY_MB_MAX} MiB)`}
              htmlFor="policy-memory"
            >
              <div className="flex items-center gap-2">
                <input
                  id="policy-memory"
                  type="range"
                  min={MEMORY_MB_MIN}
                  max={MEMORY_MB_MAX}
                  step={MEMORY_MB_STEP}
                  value={memoryMb}
                  onChange={(event) => setMemoryMb(Number(event.target.value))}
                  className="w-full accent-accent"
                  aria-label="Memory (MiB)"
                />
                <Input
                  id="policy-memory-num"
                  type="number"
                  min={MEMORY_MB_MIN}
                  max={MEMORY_MB_MAX}
                  step={MEMORY_MB_STEP}
                  value={memoryMb}
                  onChange={(event) => setMemoryMb(Number(event.target.value))}
                  className="w-20"
                  aria-label="Memory in MiB (number)"
                />
              </div>
            </Field>
          </div>

          <Field label="Network" htmlFor="policy-network">
            <Select
              id="policy-network"
              value={network}
              onChange={(event) => setNetwork(event.target.value as "" | SandboxNetworkMode)}
            >
              <option value="">not set (provider default)</option>
              <option value="none">none — fully isolated, not even DNS</option>
              <option value="limited">limited — dedicated bridge, DNS works</option>
              <option value="default">default — normal outbound access</option>
            </Select>
            {network === "limited" ? (
              <p className="text-xs text-warning" data-limited-note>
                Honest limits: in v0.2 “limited” gives a dedicated bridge network with working DNS
                but does NOT filter egress yet — outbound traffic is allowed.
              </p>
            ) : null}
          </Field>

          <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-elevated/40 p-3">
            <label htmlFor="policy-keep-for-debug" className="text-sm text-fg">
              Keep sandboxes for debug
              <span className="block text-xs font-normal text-muted-fg">
                Do not destroy failed runs&apos; sandboxes so they can be inspected afterwards.
              </span>
            </label>
            <input
              id="policy-keep-for-debug"
              type="checkbox"
              checked={keepForDebug}
              onChange={(event) => setKeepForDebug(event.target.checked)}
              className="mt-1 size-4 accent-accent"
            />
          </div>

          {error !== null ? (
            <p className="text-xs text-danger" role="alert" data-policy-error>
              {error}
            </p>
          ) : null}

          <div className="flex justify-end">
            <Button type="submit" loading={saving}>
              Save policy
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
