"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes } from "@/lib/settings";
import { formatRelativeAge } from "@/lib/time";
import {
  deleteSandboxImage,
  fetchSandboxImages,
  imageRefOf,
  isImageInUseError,
  startSandboxImageBuild,
  startSandboxImagePull,
  waitForSandboxJob,
  type SandboxImageEntry,
} from "@/lib/sandbox-api";

/**
 * Settings → Sandbox section (#100): the image catalog (ours + common
 * bases), a pull form and a build-from-Dockerfile form, each driving an
 * async daemon job polled to completion with an inline progress row, and
 * per-image delete with the in-use conflict surfaced. Build constraint
 * (v0.2): the Dockerfile builds with an EMPTY context — no COPY/ADD files.
 */

/** Client-side mirror of the daemon's `^[a-z0-9._-]+$` build-name rule. */
const BUILD_NAME_PATTERN = /^[a-z0-9._-]+$/;

interface InlineJob {
  id: string;
  label: string;
}

export function SandboxImagesCard() {
  const { toast } = useToast();
  const [images, setImages] = useState<SandboxImageEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [jobs, setJobs] = useState<InlineJob[]>([]);
  const [pullRef, setPullRef] = useState("");
  const [buildName, setBuildName] = useState("");
  const [dockerfileText, setDockerfileText] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [confirming, setConfirming] = useState<SandboxImageEntry | null>(null);

  const load = useCallback(() => {
    fetchSandboxImages()
      .then((payload) => {
        setImages(payload);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dropJob = useCallback((id: string) => {
    setJobs((current) => current.filter((job) => job.id !== id));
  }, []);

  // Aborts in-flight job polls when the card unmounts (navigating away from
  // Settings mid-pull/build), so no setState/toast fires on a dead component.
  const jobAbortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      jobAbortRef.current?.abort();
    },
    [],
  );

  /** Starts a job, shows its inline row, polls to completion, refreshes. */
  const runJob = useCallback(
    async (
      start: () => Promise<{ jobId: string }>,
      label: (jobId: string) => string,
      doneToast: string,
    ) => {
      let jobId: string;
      try {
        ({ jobId } = await start());
      } catch (err) {
        toast({
          title: "Failed to start job",
          description: err instanceof Error ? err.message : String(err),
          variant: "danger",
        });
        return;
      }
      setJobs((current) => [...current, { id: jobId, label: label(jobId) }]);
      const abort = new AbortController();
      jobAbortRef.current = abort;
      try {
        const job = await waitForSandboxJob(jobId, { signal: abort.signal });
        if (job.status === "failed") {
          toast({
            title: `${label(jobId)} failed`,
            description: job.error ?? "the daemon job failed",
            variant: "danger",
          });
        } else {
          toast({ title: doneToast, variant: "success" });
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        toast({
          title: "Lost track of job",
          description: err instanceof Error ? err.message : String(err),
          variant: "danger",
        });
      } finally {
        if (jobAbortRef.current === abort) jobAbortRef.current = null;
        dropJob(jobId);
        load();
      }
    },
    [dropJob, load, toast],
  );

  const onPull = useCallback(() => {
    const ref = pullRef.trim();
    if (ref === "") return;
    setPullRef("");
    void runJob(
      () => startSandboxImagePull(ref),
      () => `Pulling ${ref}`,
      `Pulled ${ref}`,
    );
  }, [pullRef, runJob]);

  const onBuild = useCallback(() => {
    const name = buildName.trim();
    if (!BUILD_NAME_PATTERN.test(name)) return;
    const dockerfile = dockerfileText.trim();
    const base = baseRef.trim();
    if (dockerfile === "" && base === "") return;
    setBuildName("");
    setDockerfileText("");
    setBaseRef("");
    void runJob(
      () =>
        startSandboxImageBuild({
          name,
          ...(dockerfile === "" ? {} : { dockerfileText: dockerfile }),
          ...(base === "" ? {} : { baseRef: base }),
        }),
      () => `Building openeuler/${name}:latest`,
      `Built openeuler/${name}:latest`,
    );
  }, [baseRef, buildName, dockerfileText, runJob]);

  const onDelete = useCallback(async () => {
    if (confirming === null) return;
    const ref = imageRefOf(confirming);
    setConfirming(null);
    try {
      await deleteSandboxImage(ref);
      toast({ title: `Deleted ${ref}`, variant: "success" });
    } catch (err) {
      toast({
        title: isImageInUseError(err) ? "Image is in use" : "Delete failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "danger",
      });
    } finally {
      load();
    }
  }, [confirming, load, toast]);

  const buildValid =
    BUILD_NAME_PATTERN.test(buildName.trim()) &&
    (dockerfileText.trim() !== "" || baseRef.trim() !== "");

  if (failed && images === null) {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Sandbox</CardTitle>
            <CardDescription>Container images sandboxes run on.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <EmptyState
            title="Could not load sandbox images"
            description="The daemon did not answer the image catalog request."
            action={
              <Button variant="secondary" onClick={load}>
                Retry
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Sandbox</CardTitle>
            <CardDescription>
              Images sandboxes run on: the openeuler/ namespace (built here) plus common base images
              when present locally.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {images === null ? null : images.length === 0 ? (
            <p className="text-sm text-muted-fg">
              No catalog images yet — pull a base or build one below.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Image</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Origin</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {images.map((image) => {
                  const ref = imageRefOf(image);
                  return (
                    <TableRow key={`${ref}-${image.id}`}>
                      <TableCell className="font-mono text-xs text-fg" title={image.id}>
                        {ref}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-fg">
                        {formatBytes(image.sizeBytes)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-fg">
                        {image.createdAt > 0
                          ? formatRelativeAge(new Date(image.createdAt).toISOString())
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={image.ours ? "accent" : "neutral"}>
                          {image.ours ? "ours" : "base"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="danger"
                          size="sm"
                          aria-label={`Delete ${ref}`}
                          onClick={() => setConfirming(image)}
                        >
                          Delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          {jobs.length === 0 ? null : (
            <ul className="flex flex-col gap-1" aria-label="Image jobs">
              {jobs.map((job) => (
                <li
                  key={job.id}
                  data-job-id={job.id}
                  className="rounded-md border border-border bg-elevated px-3 py-1.5 text-sm text-muted-fg"
                  role="status"
                >
                  {job.label}…
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-4">
            <Field
              label="Pull an image"
              hint="any public ref, e.g. busybox:musl"
              htmlFor="sandbox-pull-ref"
            >
              <div className="flex gap-2">
                <Input
                  id="sandbox-pull-ref"
                  value={pullRef}
                  placeholder="busybox:musl"
                  onChange={(event) => setPullRef(event.target.value)}
                />
                <Button variant="secondary" disabled={pullRef.trim() === ""} onClick={onPull}>
                  Pull image
                </Button>
              </div>
            </Field>

            <Field
              label="Build an image"
              hint="tagged openeuler/<name>:latest — empty context, no COPY files"
              htmlFor="sandbox-build-dockerfile"
            >
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Input
                    id="sandbox-build-name"
                    aria-label="Build name"
                    value={buildName}
                    placeholder="name (a-z 0-9 . _ -)"
                    invalid={buildName.trim() !== "" && !BUILD_NAME_PATTERN.test(buildName.trim())}
                    onChange={(event) => setBuildName(event.target.value)}
                  />
                  <Input
                    id="sandbox-build-base"
                    aria-label="Base image"
                    value={baseRef}
                    placeholder="base ref (optional)"
                    onChange={(event) => setBaseRef(event.target.value)}
                  />
                </div>
                <Textarea
                  id="sandbox-build-dockerfile"
                  rows={4}
                  value={dockerfileText}
                  placeholder={"FROM alpine:3.20\nRUN echo hello > /greeting"}
                  onChange={(event) => setDockerfileText(event.target.value)}
                />
                <Button
                  variant="secondary"
                  disabled={!buildValid}
                  onClick={onBuild}
                  className="self-start"
                >
                  Build image
                </Button>
              </div>
            </Field>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirming !== null} onClose={() => setConfirming(null)} label="Delete image">
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-fg">Delete image</h2>
            <p className="mt-1 text-sm text-muted-fg">
              Delete{" "}
              <span className="font-mono">{confirming === null ? "" : imageRefOf(confirming)}</span>{" "}
              from the docker host? Sandboxes running it block the deletion.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void onDelete()}>
              Confirm delete
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
