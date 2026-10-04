"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { humanizeCron, isValidTimezone, nextCronRuns, parseCron } from "@openeuler/core";
import type { WorkflowSchedule } from "@openeuler/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Field, Input, Textarea } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { formatRelativeAge } from "@/lib/time";
import {
  deleteWorkflowSchedule,
  fetchWorkflowSchedule,
  localTimezone,
  putWorkflowSchedule,
} from "@/lib/schedules-api";

/**
 * Workflow schedule drawer (#121): cron + timezone + task template editor
 * with a live humanized schedule, a client-side upcoming-runs preview
 * (computed with the same core cron code the daemon ticks) and a pause
 * toggle. Saving PUTs the full config (daemon-side upsert); one schedule
 * per workflow by construction.
 */

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; schedule: WorkflowSchedule | null };

/** Upcoming-run preview length. */
const PREVIEW_COUNT = 5;

export function ScheduleDrawer({
  open,
  workflowId,
  onClose,
}: {
  open: boolean;
  workflowId: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [enabled, setEnabled] = useState(true);
  const [cron, setCron] = useState("30 9 * * 1-5");
  const [taskTemplate, setTaskTemplate] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = useCallback(() => {
    setState({ phase: "loading" });
    return fetchWorkflowSchedule(workflowId)
      .then((schedule) => {
        setState({ phase: "ready", schedule });
        if (schedule !== null) {
          setEnabled(schedule.enabled);
          setCron(schedule.cron);
          setTaskTemplate(schedule.taskTemplate);
          setTimezone(schedule.timezone);
        } else {
          setEnabled(true);
          setCron("30 9 * * 1-5");
          setTaskTemplate("");
          setTimezone(localTimezone());
        }
      })
      .catch((cause) => {
        setState({
          phase: "error",
          message: cause instanceof ApiError ? cause.message : "Failed to load schedule",
        });
      });
  }, [workflowId]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setConfirmDelete(false);
    reload();
  }, [open, reload]);

  // Client-side preview: strict parse + IANA zone check feed both the
  // humanized schedule and the upcoming list — invalid input degrades to
  // the parse error text and an empty list, never a crash.
  const cronError = useMemo(() => {
    const parsed = parseCron(cron);
    return parsed.ok ? null : parsed.error;
  }, [cron]);
  const timezoneError = useMemo(
    () =>
      timezone.trim().length === 0 || isValidTimezone(timezone.trim()) ? null : "unknown timezone",
    [timezone],
  );
  const humanized = useMemo(() => humanizeCron(cron), [cron]);
  const upcoming = useMemo(
    () =>
      cronError === null && timezoneError === null
        ? nextCronRuns(cron, { timeZone: timezone.trim(), count: PREVIEW_COUNT })
        : [],
    [cron, cronError, timezone, timezoneError],
  );

  const dirty =
    state.phase === "ready" &&
    (state.schedule === null ||
      state.schedule.enabled !== enabled ||
      state.schedule.cron !== cron ||
      state.schedule.taskTemplate !== taskTemplate ||
      state.schedule.timezone !== timezone);

  const run = (action: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    action()
      .catch((cause) => {
        setError(cause instanceof ApiError ? cause.message : "Unexpected error");
      })
      .finally(() => setBusy(false));
  };

  const save = () =>
    run(async () => {
      if (cronError !== null || timezoneError !== null || taskTemplate.trim().length === 0) return;
      const saved = await putWorkflowSchedule({
        workflowId,
        config: {
          enabled,
          cron: cron.trim(),
          taskTemplate,
          timezone: timezone.trim(),
        },
      });
      setState({ phase: "ready", schedule: saved });
    });

  /** Quick pause/resume from the header — PUTs the full config. */
  const togglePaused = () =>
    run(async () => {
      if (state.phase !== "ready" || state.schedule === null) return;
      if (dirty) return;
      const saved = await putWorkflowSchedule({
        workflowId,
        config: {
          enabled: !state.schedule.enabled,
          cron: state.schedule.cron,
          taskTemplate: state.schedule.taskTemplate,
          timezone: state.schedule.timezone,
        },
      });
      setEnabled(saved.enabled);
      setState({ phase: "ready", schedule: saved });
    });

  const remove = () =>
    run(async () => {
      setConfirmDelete(false);
      await deleteWorkflowSchedule(workflowId);
      await reload();
    });

  return (
    <Drawer open={open} onClose={onClose} label="Workflow schedule">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-title font-semibold text-fg">Schedule</h2>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-fg">
        The daemon ticks every minute and queues a run of the latest revision — cron is evaluated in
        your timezone&apos;s wall clock, and a slot is skipped (logged in the activity feed) while a
        previous run is still active.
      </p>

      {state.phase === "loading" ? (
        <p className="mt-4 rounded-lg border border-border p-3 text-sm text-muted-fg">
          Loading schedule…
        </p>
      ) : null}
      {state.phase === "error" ? (
        <p
          className="mt-4 rounded-lg border border-danger/50 bg-danger-subtle p-3 text-sm text-danger"
          role="alert"
        >
          {state.message}
        </p>
      ) : null}

      {state.phase === "ready" && state.schedule !== null ? (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-schedule-status>
          <Badge variant={state.schedule.enabled ? "success" : "neutral"}>
            {state.schedule.enabled ? "enabled" : "paused"}
          </Badge>
          <span className="text-xs text-muted-fg">
            saved {formatRelativeAge(state.schedule.updatedAt)} ago
            {state.schedule.lastFiredAt === undefined
              ? " · never fired"
              : ` · last slot ${formatRelativeAge(state.schedule.lastFiredAt)} ago`}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            disabled={dirty}
            onClick={togglePaused}
            loading={busy}
          >
            {state.schedule.enabled ? "Pause" : "Resume"}
          </Button>
        </div>
      ) : null}

      {state.phase === "ready" ? (
        <div className="mt-4 flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm text-fg" data-schedule-enabled>
            <input
              id="schedule-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="size-4 rounded border-border accent-accent"
            />
            <span>
              Enabled
              <span className="ml-1 font-normal text-muted-fg">(uncheck to pause)</span>
            </span>
          </label>

          <Field
            label="Cron"
            hint="(5-field: minute hour day-of-month month day-of-week)"
            htmlFor="schedule-cron"
            error={cronError ?? undefined}
          >
            <Input
              id="schedule-cron"
              value={cron}
              invalid={cronError !== null}
              onChange={(event) => setCron(event.target.value)}
              placeholder="30 9 * * 1-5"
              className="font-mono"
            />
          </Field>
          <p className="-mt-2 text-xs text-muted-fg" data-schedule-humanized>
            {humanized}
          </p>

          <Field
            label="Timezone"
            hint="(IANA, wall-clock)"
            htmlFor="schedule-timezone"
            error={timezoneError ?? undefined}
          >
            <Input
              id="schedule-timezone"
              value={timezone}
              invalid={timezoneError !== null}
              onChange={(event) => setTimezone(event.target.value)}
              placeholder={localTimezone()}
              className="font-mono"
            />
          </Field>

          <Field
            label="Task template"
            hint="(the task every scheduled run carries)"
            htmlFor="schedule-task"
            error={
              taskTemplate.trim().length === 0
                ? "task template must be a non-empty string"
                : undefined
            }
          >
            <Textarea
              id="schedule-task"
              value={taskTemplate}
              rows={3}
              onChange={(event) => setTaskTemplate(event.target.value)}
              placeholder="Nightly dependency audit and fix"
            />
          </Field>

          <div>
            <h3 className="text-sm font-semibold text-fg">Next {PREVIEW_COUNT} runs</h3>
            <ul className="mt-2 flex flex-col gap-1" data-schedule-upcoming>
              {upcoming.length === 0 ? (
                <li className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-fg">
                  Fix the schedule above to preview upcoming runs.
                </li>
              ) : null}
              {upcoming.map((iso) => (
                <li
                  key={iso}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg"
                >
                  {new Date(iso).toLocaleString()}
                  <span className="ml-2 font-sans text-muted-fg">({iso})</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={save}
              loading={busy}
              disabled={
                cronError !== null ||
                timezoneError !== null ||
                taskTemplate.trim().length === 0 ||
                !dirty
              }
            >
              Save schedule
            </Button>
            {state.schedule !== null ? (
              <Button
                variant="danger"
                size="sm"
                className="ml-auto"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            ) : null}
          </div>

          {confirmDelete ? (
            <div className="flex flex-col gap-2 rounded-lg border border-danger/50 bg-danger-subtle p-3">
              <p className="text-sm text-fg">Delete this schedule? Runs stop scheduling now.</p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
                <Button variant="danger" size="sm" onClick={remove} loading={busy}>
                  Delete schedule
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </Drawer>
  );
}
