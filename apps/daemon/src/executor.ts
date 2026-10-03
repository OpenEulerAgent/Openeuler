import type { ProjectSandboxPolicy, Run, RunStatus } from "@openeuler/core";
import { hostingKeepAliveMinutes, MAX_HOSTING_EXTEND_MINUTES } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import type {
  AgentExecOptions,
  AgentExecSeam,
  AgentHandle,
  DriverRegistry,
} from "@openeuler/drivers";
import {
  createFlowEngine,
  buildRunSandboxSpec,
  DEFAULT_DRIVER_ID,
  runPortList,
  SANDBOX_WORKSPACE_PATH,
} from "@openeuler/engine";
import type { RunSandboxAcquirer, WorktreeManager } from "@openeuler/engine";
import { SandboxError, dockerAvailable } from "@openeuler/sandbox";
import type {
  SandboxHandle,
  SandboxHostPorts,
  SandboxProvider,
  SandboxStatus,
} from "@openeuler/sandbox";
import pLimit from "p-limit";
import { recordRunStatusActivity, recordSandboxKeptActivity } from "./activity.js";
import {
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_SANDBOX_CAP_RETRY_MS,
  resolveMaxConcurrentRuns,
  resolveMaxSandboxes,
} from "./concurrency.js";
import type { Logger } from "./logger.js";
import { createSecretsSupport, type SecretsSupport } from "./secrets.js";
import { startSandboxLogTailer, type SandboxLogTailer } from "./sandbox-log-tailer.js";

export { DEFAULT_DRIVER_ID };

export { DEFAULT_MAX_CONCURRENT_RUNS, resolveMaxConcurrentRuns };

/** Effective execution placement of a run after policy + availability resolve. */
export type EffectiveExecutionMode = "local" | "sandbox";

/**
 * Resolves a run's effective execution mode (#102):
 * - unset policy or `"local"` → local (the v0.2 default; zero regression)
 * - `"sandbox"` → sandbox (image must be configured, else the run fails
 *   with the typed, actionable `SANDBOX_INVALID_SPEC` error)
 * - `"auto"` → sandbox when docker is available, else local
 */
export function resolveExecutionMode(
  policy: ProjectSandboxPolicy | undefined,
  dockerIsAvailable: boolean,
): EffectiveExecutionMode {
  const mode = policy?.executionMode ?? "local";
  if (mode === "sandbox") return "sandbox";
  if (mode === "auto") return dockerIsAvailable ? "sandbox" : "local";
  return "local";
}

/**
 * One previewable port on a run (#107), as served by `GET /api/runs/:id`:
 * declared ports carry a live host mapping while the sandbox lives;
 * detected-but-undeclared ports carry the declare-to-preview hint instead
 * (v0.2 cut: only declared ports are published).
 */
export interface RunPortView {
  /** Container-side port number. */
  container: number;
  /**
   * Ephemeral host port, present only while the sandbox is alive AND the
   * port is published (declared). Gone with the sandbox.
   */
  host?: number;
  /** True when the port was declared on the run at creation. */
  declared: boolean;
  /** Present when the port cannot be previewed (not declared, v0.2). */
  hint?: string;
}

/** Hint for a detected port that v0.2 cannot publish (#107 documented cut). */
export const UNDECLARED_PORT_HINT =
  "detected in run output; declare ports on the run to preview it (v0.2 publishes declared ports only)";

/**
 * Builds a run's port views (#107): declared ports first (declaration
 * order), then detected-but-undeclared ones, capped at 3. `host` comes from
 * the live sandbox's `hostPorts()` map (only declared ports are published);
 * an empty map renders post-sandbox/undeclared views without a host. Pure.
 */
export function buildRunPortViews(
  declared: readonly number[] | undefined,
  detected: readonly number[] | undefined,
  hostPorts: SandboxHostPorts,
): RunPortView[] {
  return runPortList(declared, detected).map((container) => {
    const isDeclared = (declared ?? []).includes(container);
    const host = hostPorts[container];
    return {
      container,
      ...(isDeclared && host !== undefined ? { host } : {}),
      declared: isDeclared,
      ...(!isDeclared ? { hint: UNDECLARED_PORT_HINT } : {}),
    };
  });
}

/** Sandbox snapshot on the run detail payload (`GET /api/runs/:id`). */
export interface RunSandboxInfo {
  /** Provider-scoped sandbox id (container name). */
  id: string;
  /** Image the sandbox runs. */
  image: string;
  /** Lifecycle status when queried. */
  status: SandboxStatus;
  /**
   * Port views while the sandbox is alive (#107): declared ports with
   * their live host mapping, detected-undeclared ones with the hint.
   * Absent when the run tracks no ports at all.
   */
  ports?: RunPortView[];
}

/**
 * Hosting view on the run detail payload (#110): present while the run is
 * hosted (`hostedUntil` on the row) — the expiry timestamp plus the live
 * host port mappings of the kept sandbox. `ports` is empty when this
 * daemon no longer owns a handle (e.g. after a restart, until expiry).
 */
export interface RunHostingView {
  /** ISO timestamp the hosted sandbox expires. */
  until: string;
  /** Live container→host mappings while the sandbox is alive. */
  ports: Array<{ container: number; host: number }>;
  /** True while the hosting can be extended (capped 24h from "now"). */
  extendable: boolean;
}

/**
 * Builds a run's hosting view (#110): `null` unless the row is hosted;
 * otherwise the expiry plus whatever live mappings `sandboxInfo` reports.
 * Pure — routes compose it with the executor's live snapshot.
 */
export function buildRunHostingView(
  run: Run,
  sandbox: RunSandboxInfo | undefined,
): RunHostingView | null {
  if (run.hostedUntil === undefined) return null;
  const ports = (sandbox?.ports ?? [])
    .filter((port) => port.host !== undefined)
    .map((port) => ({ container: port.container, host: port.host as number }));
  return { until: run.hostedUntil, ports, extendable: true };
}

/**
 * One global run-status transition, broadcast on the executor's listener
 * bus (#51): pushed on `GET /api/runs/stream`, recorded into the activity
 * feed when feed-worthy. `projectId` lets dashboards bucket without a row
 * fetch; `workflowRevision` resolves the run's pinned graph snapshot.
 */
export interface RunStatusNotification {
  runId: string;
  status: RunStatus;
  projectId: string;
  workflowRevision?: { id: string; number: number };
}

export type RunStatusListener = (event: RunStatusNotification) => void;

/** Extra per-run execution options not persisted on the Run row (v1). */
export interface StartRunOptions {
  model?: string;
  mode?: "auto" | "ask";
}

/** Outcome of {@link Executor.abortRun}; routes map this to HTTP statuses. */
export type AbortRunResult =
  | { outcome: "aborted" }
  | { outcome: "not_found" }
  | { outcome: "not_abortable"; status: RunStatus };

/** Outcome of {@link Executor.stopHosting}; routes map this to HTTP statuses. */
export type HostingStopResult = { outcome: "stopped" } | { outcome: "not_hosted" };

/** Outcome of {@link Executor.extendHosting}; routes map this to HTTP statuses. */
export type HostingExtendResult =
  { outcome: "extended"; until: string } | { outcome: "not_hosted" };

export interface Executor {
  /**
   * Begins background execution of a queued run. Never throws and never
   * blocks: all failures are captured into the run row (`failed` + error).
   * The run waits in the scheduler (staying `queued`) until both its
   * project's turn and a global concurrency slot are free.
   */
  startRun(runId: string, opts?: StartRunOptions): void;
  /**
   * Aborts a queued/running run: calls `handle.abort()` when the agent already
   * started, otherwise marks the run aborted directly (a run still waiting in
   * the scheduler is dropped from the queue without ever starting). Driver
   * abort failures propagate to the caller (routes map them to 5xx).
   */
  abortRun(runId: string): Promise<AbortRunResult>;
  /** Ids of runs currently executing or queued in the scheduler (in memory). */
  activeRunIds(): string[];
  /**
   * Subscribes to every global run-status transition (queued admission,
   * running start, terminal) — the bus behind `GET /api/runs/stream` (#51).
   * Returns an unsubscribe function.
   */
  onRunStatus(listener: RunStatusListener): () => void;
  /**
   * Live sandbox of a run, when it has one (#102): `{ id, image, status }`
   * looked up in the executor's active map (a sandbox lives exactly as long
   * as its run's execution). Undefined = local execution or no live run.
   * A HOSTED sandbox (#110) stays in the map past run success until its
   * TTL expires or Stop hosting fires, so previews keep resolving.
   */
  sandboxInfo(runId: string): Promise<RunSandboxInfo | undefined>;
  /**
   * Stops a hosted run's sandbox now (#110): destroys the container,
   * clears `hostedUntil` (the run row stays `success`). `not_hosted`
   * when the run is not currently hosted (409 at the route).
   */
  stopHosting(runId: string): Promise<HostingStopResult>;
  /**
   * Extends a hosted run's TTL (#110): `hostedUntil` moves to
   * `min(now + minutes, now + 24h)` and never shrinks. `not_hosted`
   * when the run is not currently hosted (409 at the route).
   */
  extendHosting(runId: string, minutes: number): Promise<HostingExtendResult>;
  /** Configured global concurrency cap (`MAX_CONCURRENT_RUNS`). */
  maxConcurrentRuns: number;
  /** Best-effort graceful stop: aborts active runs and waits briefly for them. */
  shutdown(): Promise<void>;
}

export interface ExecutorOptions {
  db: Db;
  worktrees: WorktreeManager;
  drivers: DriverRegistry;
  logger: Logger;
  /** Driver used for ad-hoc runs; defaults to `OPENEULER_DRIVER`, then `"fake"`. */
  driverId?: string;
  /**
   * How many runs may execute at once (global semaphore). Defaults to
   * `$MAX_CONCURRENT_RUNS` (integer >= 1), then
   * {@link DEFAULT_MAX_CONCURRENT_RUNS}.
   */
  maxConcurrentRuns?: number;
  /** How long {@link Executor.shutdown} waits for active runs to settle. */
  shutdownSettleMs?: number;
  /**
   * Master key for per-project secrets (#93). When set, the executor loads
   * each run's project secrets at run start: values are decrypted into the
   * driver env and every persisted write (events, outputs, diffs, errors,
   * activity payloads, run-tagged log fields) is redacted. Unset = runs
   * execute without secret injection or redaction.
   */
  secretsKey?: Buffer;
  /**
   * Sandboxed run execution (#102). Absent = every run executes locally
   * (byte-identical to pre-v0.2). When set, runs of projects whose policy
   * resolves to sandbox (`sandbox`, or `auto` + docker available) get ONE
   * sandbox per run: the run's worktree bind-mounted rw (+`:cached`) at
   * `/workspace`, one named cache volume per `policy.cachePaths`, labels
   * `{ run: <runId> }`, destroyed when the run turns terminal — unless
   * `policy.keepForDebug` keeps it (recorded as an ops activity). The
   * provider instance should be shared with the sandbox image routes.
   */
  sandbox?: {
    provider: SandboxProvider;
    /**
     * Docker availability probe backing `executionMode: "auto"`; injectable
     * for tests. Defaults to `dockerAvailable()` from `@openeuler/sandbox`
     * (30s cache).
     */
    isDockerAvailable?: () => Promise<boolean>;
    /**
     * Poll interval for the sandbox log tailer (#104) — container
     * stdout/stderr lines are appended as `sandbox.log` events while the
     * run's sandbox exists. Default 500ms.
     */
    logPollIntervalMs?: number;
    /**
     * Ring cap: max persisted `sandbox.log` events per run (drop-oldest,
     * one `sandbox.log-truncated` marker). Default 2000.
     */
    logCap?: number;
    /**
     * Upper bound on live provider sandboxes (#105). A sandbox-mode run
     * dequeued while the provider is at the cap stays `queued` and is
     * re-enqueued after `capRetryMs`. Defaults to `$MAX_SANDBOXES`
     * (integer >= 2), then 8.
     */
    maxSandboxes?: number;
    /**
     * Delay before a sandbox-capped run is re-enqueued (#105). Default
     * 30s; tests shrink it.
     */
    capRetryMs?: number;
  };
}

interface ActiveRun {
  runId: string;
  /** Project whose gate serializes this run against siblings. */
  projectId: string;
  /** Live driver handle of the step currently executing, if any. */
  handle?: AgentHandle;
  abortRequested: boolean;
  done: Promise<void>;
}

/**
 * The ONE sandbox backing a sandboxed run (#102): the handle, its policy
 * flags, and the per-exec AbortControllers that turn a sandbox stop into
 * rejections of the driver's in-flight exec commands.
 */
interface ActiveSandbox {
  runId: string;
  projectId: string;
  handle: SandboxHandle;
  image: string;
  /** `policy.keepForDebug`: keep the container after the run turns terminal. */
  keepForDebug: boolean;
  /**
   * True once the sandbox was HOSTED past run success (#110): the entry
   * stays in the map (previews keep resolving) until the TTL sweeper or
   * Stop hosting destroys it.
   */
  hosted: boolean;
  /** True once the container has been asked to stop (idempotence guard). */
  stopped: boolean;
  /** In-flight exec cancellations (wired to the driver's exec seam). */
  execControllers: Set<AbortController>;
  /** Container log tailer (#104); stopped (final flush + marker) at dispose. */
  tailer: SandboxLogTailer | null;
  /** Cancels in-flight execs and stops the container (abort path). */
  stop: () => Promise<void>;
}

/**
 * Per-project serialization gate: at most one run per project is scheduled at
 * a time. `holderRunId` is the run currently occupying the project's turn;
 * `waiters` are later runs for the same project, FIFO by start order.
 */
interface ProjectGate {
  holderRunId: string;
  waiters: Array<{ runId: string; resolve: () => void }>;
}

const TERMINAL_STATUSES = new Set<RunStatus>(["success", "failed", "aborted", "interrupted"]);

const isTerminal = (status: RunStatus): boolean => TERMINAL_STATUSES.has(status);

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `{ workflowRevision: { id, number } }` slice for a pinned run, if resolvable. */
function revisionRef(
  db: Db,
  workflowRevisionId: string | undefined,
): { workflowRevision?: { id: string; number: number } } {
  if (workflowRevisionId === undefined) return {};
  const revision = db.workflowRevisions.get(workflowRevisionId);
  return revision === undefined
    ? {}
    : { workflowRevision: { id: revision.id, number: revision.number } };
}

/**
 * Schedules runs for background execution and owns the live-run bookkeeping
 * (abort, shutdown, duplicate-start guards) plus the concurrency scheduler:
 *
 * - **Global semaphore** — a `p-limit(concurrency)` gate caps how many runs
 *   execute at once (`MAX_CONCURRENT_RUNS`, default 2). Runs awaiting a slot
 *   simply stay `queued` in the db; the engine only flips them to `running`
 *   once the slot is acquired and execution starts.
 * - **Per-project serialization** — before joining the global queue a run
 *   must also hold its project's gate (only one active run per project at a
 *   time; a second run for the same project waits — `queued` — until the
 *   first is terminal). The gate is a `Map<projectId, gate>` released when
 *   the run leaves the scheduler, so different projects still run in
 *   parallel up to the global cap.
 *
 * Lock order is always project-gate → global-slot (executing runs never wait
 * on a gate), so the two layers cannot deadlock. The actual multi-step
 * execution — worktree, prompt templating, step runs, event persistence —
 * lives in the flow engine (`@openeuler/engine`) and stays isolated per
 * runId (one worktree/branch per run, no shared mutable executor state);
 * this wrapper keeps the daemon-specific lifecycle concerns out of the HTTP
 * layer: routes only call `startRun`/`abortRun`, and the engine never throws
 * into callers.
 */
export function createExecutor(options: ExecutorOptions): Executor {
  const { db, worktrees, drivers, logger } = options;
  const driverId = options.driverId ?? process.env["OPENEULER_DRIVER"] ?? DEFAULT_DRIVER_ID;
  const maxConcurrentRuns =
    options.maxConcurrentRuns ?? resolveMaxConcurrentRuns(process.env["MAX_CONCURRENT_RUNS"]);
  if (maxConcurrentRuns < 1 || !Number.isInteger(maxConcurrentRuns)) {
    throw new Error(`maxConcurrentRuns must be an integer >= 1 (got ${maxConcurrentRuns})`);
  }
  const shutdownSettleMs = options.shutdownSettleMs ?? 2_000;
  /**
   * #105: global cap on live provider sandboxes — a sandbox-mode run
   * dequeued at the cap stays `queued` (delay-requeued below), so sandboxes
   * behave like a second, coarser resource queue behind MAX_CONCURRENT_RUNS.
   */
  const maxSandboxes =
    options.sandbox?.maxSandboxes ?? resolveMaxSandboxes(process.env["MAX_SANDBOXES"]);
  const capRetryMs = options.sandbox?.capRetryMs ?? DEFAULT_SANDBOX_CAP_RETRY_MS;
  /** Per-project secrets support (#93); undefined when no master key is configured. */
  const secrets: SecretsSupport | undefined =
    options.secretsKey === undefined ? undefined : createSecretsSupport(db, options.secretsKey);
  const active = new Map<string, ActiveRun>();
  /**
   * Live run sandboxes (#102): runId → the sandbox created for the current
   * execution. Populated by the engine's acquire hook, emptied by the
   * executor's dispose (terminal / abort), read by `sandboxInfo()`.
   * #110: HOSTED sandboxes stay in the map past run success (until their
   * TTL expires or Stop hosting fires) so previews keep resolving.
   */
  const activeSandboxes = new Map<string, ActiveSandbox>();
  const runStatusListeners = new Set<RunStatusListener>();
  /**
   * Last status broadcast per run id: the stalled-driver abort race
   * terminalizes the row both in the executor and (later) in the engine,
   * and identical consecutive frames would leak to every stream client —
   * the same dedupe the activity writer gets from `latestForRun`.
   */
  const lastPublishedStatus = new Map<string, RunStatus>();

  /**
   * Broadcasts one transition on the bus (never throws into callers; a dead
   * listener is dropped, not fatal). Identical consecutive per-run frames
   * are suppressed.
   */
  function publishRunStatus(event: RunStatusNotification): void {
    if (lastPublishedStatus.get(event.runId) === event.status) return;
    lastPublishedStatus.delete(event.runId);
    lastPublishedStatus.set(event.runId, event.status);
    if (lastPublishedStatus.size > 4_096) {
      const oldest = lastPublishedStatus.keys().next().value;
      if (oldest !== undefined) lastPublishedStatus.delete(oldest);
    }
    for (const listener of [...runStatusListeners]) {
      try {
        listener(event);
      } catch (err) {
        logger.error({ err, runId: event.runId }, "run-status listener failed");
      }
    }
  }

  /**
   * Fresh redaction transform for a run's project (#93): applied to the
   * executor's own persisted writes (activity payloads, failure errors)
   * and its run-tagged log lines. No-ops when secrets are not configured.
   */
  function redactorFor(projectId: string): (text: string) => string {
    return secrets === undefined ? (text) => text : secrets.redactorForProject(projectId);
  }

  /**
   * Records the feed entry (when feed-worthy) and broadcasts the transition
   * for a run whose row already carries the new status. Used both from the
   * engine's `run.status` hook and the executor's own out-of-engine
   * terminalizations (abort before start, belt-and-braces failure, shutdown).
   */
  function notifyRunStatus(runId: string): void {
    try {
      const run = db.runs.get(runId);
      if (run === undefined) return;
      recordRunStatusActivity(db, runId, run.status, redactorFor(run.projectId));
      publishRunStatus({
        runId,
        status: run.status,
        projectId: run.projectId,
        ...revisionRef(db, run.workflowRevisionId),
      });
    } catch (err) {
      logger.error({ err, runId }, "run-status notification failed");
    }
  }

  /** Cancels a sandbox's in-flight execs and stops its container (idempotent). */
  async function stopSandbox(entry: ActiveSandbox): Promise<void> {
    // Cancel every in-flight exec first (their promises reject, which
    // settles the driver handles as aborted), then stop the container.
    for (const controller of [...entry.execControllers]) controller.abort();
    entry.execControllers.clear();
    if (!entry.stopped) {
      entry.stopped = true;
      await entry.handle.stop().catch((err: unknown) => {
        logger.warn({ err, runId: entry.runId }, "sandbox stop failed during abort");
      });
    }
  }

  /** Builds the driver exec seam bound to one run's sandbox handle (#102/#104). */
  function execSeamFor(entry: ActiveSandbox): AgentExecSeam {
    const mapOpts = (opts?: {
      timeoutMs?: number;
      env?: Record<string, string>;
    }): Parameters<SandboxHandle["exec"]>[1] => ({
      cwd: SANDBOX_WORKSPACE_PATH,
      ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts?.env === undefined || Object.keys(opts.env).length === 0
        ? {}
        : { env: { ...opts.env } }),
    });
    const cancelMessage = (cmd: string[]): SandboxError =>
      new SandboxError(
        "SANDBOX_UNAVAILABLE",
        `sandbox exec cancelled (sandbox stopped): ${cmd.join(" ")}`,
      );
    return {
      kind: "sandbox",
      run: (cmd, opts) =>
        new Promise((resolve, reject) => {
          const controller = new AbortController();
          entry.execControllers.add(controller);
          let settled = false;
          const settle = (finish: () => void): void => {
            if (settled) return;
            settled = true;
            entry.execControllers.delete(controller);
            controller.signal.removeEventListener("abort", onAbort);
            finish();
          };
          const onAbort = (): void => settle(() => reject(cancelMessage(cmd)));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          entry.handle.exec(cmd, mapOpts(opts)).then(
            (result) => settle(() => resolve(result)),
            (err) => settle(() => reject(err)),
          );
        }),
      // #104: live-streaming variant — same abort wiring (the cancel both
      // kills the CLI child and rejects `exited`, which settles the driver
      // handle as aborted). Present whenever the provider handle implements
      // `execStream`; drivers without streaming support fall back to `run`.
      ...(typeof entry.handle.execStream === "function"
        ? {
            runStream: (cmd: string[], opts?: AgentExecOptions) => {
              const controller = new AbortController();
              entry.execControllers.add(controller);
              const inner = entry.handle.execStream(cmd, mapOpts(opts));
              let settled = false;
              const settle = (finish: () => void): void => {
                if (settled) return;
                settled = true;
                entry.execControllers.delete(controller);
                controller.signal.removeEventListener("abort", onAbort);
                finish();
              };
              let rejectExit!: (error: SandboxError) => void;
              const onAbort = (): void => {
                inner.cancel?.();
                settle(() => rejectExit(cancelMessage(cmd)));
              };
              const exited = new Promise<{ code: number }>((resolve, reject) => {
                rejectExit = reject;
                controller.signal.addEventListener("abort", onAbort, { once: true });
                inner.exited.then(
                  (exit) => settle(() => resolve({ code: exit.code })),
                  (err) => settle(() => reject(err)),
                );
              });
              return { events: inner.events, exited };
            },
          }
        : {}),
      stop: () => stopSandbox(entry),
    };
  }

  /**
   * The engine's sandbox acquire hook (#102): resolves the run's effective
   * mode from PROJECT policy (v0.2 deviation: node `sandboxOverrides` are
   * validated/stored but per-node sandboxes are post-v0.2), creates ONE
   * sandbox per run (worktree → `/workspace`, cache volumes, `{run}` label)
   * and returns the exec seam the engines hand to every driver start.
   * Returns undefined for local runs; typed SandboxError throws fail the
   * run with an actionable message.
   */
  const acquireRunSandbox: RunSandboxAcquirer | undefined =
    options.sandbox === undefined
      ? undefined
      : async (run, worktreePath) => {
          const project = db.projects.get(run.projectId);
          const policy = project?.sandboxPolicy;
          const isDockerAvailable = options.sandbox?.isDockerAvailable ?? (() => dockerAvailable());
          if (resolveExecutionMode(policy, await isDockerAvailable()) === "local") {
            return undefined;
          }
          if (project === undefined || policy === undefined) {
            // Unreachable (mode would be local); defensive.
            return undefined;
          }
          // #110 restart hygiene: a sandbox left over from a pre-restart
          // execution of this run (the daemon died mid-run; the recovery
          // sweep marked it interrupted and the user resumed) must not
          // linger beside the fresh one — both carry the same `run` label,
          // which would confuse hosting stops and the GC. Best-effort
          // destroy by label before creating (normally a no-op list).
          try {
            const stale = await options.sandbox!.provider.list({ run: run.id });
            for (const summary of stale) {
              if (options.sandbox!.provider.destroy === undefined) break;
              await options.sandbox!.provider.destroy(summary.id);
              logger.info(
                { runId: run.id, sandbox: summary.id },
                "stale pre-restart sandbox destroyed before re-acquire",
              );
            }
          } catch (err) {
            logger.warn({ err, runId: run.id }, "stale sandbox cleanup before acquire failed");
          }
          // Container env deliberately carries NO secrets: they ride per-exec
          // through the seam (docker inspect must not leak secret values).
          const spec = buildRunSandboxSpec({
            policy,
            runId: run.id,
            projectId: project.id,
            worktreePath,
            env: { OPENEULER_RUN_ID: run.id, OPENEULER_PROJECT_ID: project.id },
            // #107: declared ports are published for the sandbox's lifetime.
            ports: run.ports,
          });
          const handle = await options.sandbox!.provider.create(spec);
          const entry: ActiveSandbox = {
            runId: run.id,
            projectId: project.id,
            handle,
            image: spec.image,
            keepForDebug: policy.keepForDebug === true,
            hosted: false,
            stopped: false,
            execControllers: new Set(),
            // #104: tail container stdout/stderr into the run event log
            // (bounded ring, redacted) from create until dispose.
            tailer: startSandboxLogTailer({
              db,
              handle,
              runId: run.id,
              sandboxId: handle.id,
              redact: redactorFor(project.id),
              ...(options.sandbox!.logPollIntervalMs === undefined
                ? {}
                : { pollIntervalMs: options.sandbox!.logPollIntervalMs }),
              ...(options.sandbox!.logCap === undefined ? {} : { cap: options.sandbox!.logCap }),
              onWarn: (message) => logger.warn({ runId: run.id, sandbox: handle.id }, message),
            }),
            stop: async () => {
              await stopSandbox(entry);
            },
          };
          activeSandboxes.set(run.id, entry);
          logger.info(
            { runId: run.id, sandbox: handle.id, image: spec.image, projectId: project.id },
            "run sandbox created (sandboxed execution)",
          );
          return { workspacePath: SANDBOX_WORKSPACE_PATH, exec: execSeamFor(entry) };
        };

  /**
   * Disposes a run's sandbox when its execution ends (#102): stop the log
   * tailer first (#104 — final flush + truncation marker while the container
   * still exists), then destroy the container, or keep it (ops-activity
   * recorded) when the policy says so. Best-effort — a failed destroy is
   * logged, never thrown into the caller.
   *
   * #110 hosting: a SUCCESSFUL sandboxed run that requested hosting AND
   * declared ports keeps its sandbox alive instead — the entry stays in the
   * active map (previews keep resolving through `sandboxInfo`), the tailer
   * gets its final flush, and `hostedUntil` lands on the row. Aborted and
   * failed runs NEVER host (hosting applies to success only); a hosting
   * request without declared ports is silently ignored (nothing to preview).
   */
  async function disposeSandbox(runId: string): Promise<void> {
    const entry = activeSandboxes.get(runId);
    if (entry === undefined) return;
    const run = db.runs.get(runId);
    if (
      run !== undefined &&
      run.status === "success" &&
      run.hosting?.enabled === true &&
      (run.ports?.length ?? 0) > 0
    ) {
      entry.hosted = true;
      await entry.tailer?.stop().catch((err: unknown) => {
        logger.warn({ err, runId }, "sandbox log tailer stop failed");
      });
      const until = new Date(
        Date.now() + hostingKeepAliveMinutes(run.hosting) * 60_000,
      ).toISOString();
      db.runs.update(runId, { hostedUntil: until });
      logger.info(
        { runId, sandbox: entry.handle.id, until },
        "run hosted past success — sandbox kept alive for previews (TTL armed)",
      );
      return;
    }
    activeSandboxes.delete(runId);
    await entry.tailer?.stop().catch((err: unknown) => {
      logger.warn({ err, runId }, "sandbox log tailer stop failed");
    });
    if (entry.keepForDebug) {
      recordSandboxKeptActivity(db, {
        runId,
        container: entry.handle.id,
        image: entry.image,
      });
      logger.info(
        { runId, sandbox: entry.handle.id },
        "sandbox kept for debug (policy.keepForDebug) — remove it manually when done",
      );
      return;
    }
    try {
      await entry.handle.destroy();
      logger.info({ runId, sandbox: entry.handle.id }, "run sandbox destroyed");
    } catch (err) {
      logger.warn(
        { err, runId, sandbox: entry.handle.id },
        "sandbox destroy failed (container may leak; check docker ps)",
      );
    }
  }

  /**
   * Destroys every provider sandbox labeled with this run id (#110 stop
   * fallback): used when the row is hosted but THIS executor holds no
   * handle — i.e. the hosting outlived a daemon restart. Best-effort.
   */
  async function destroyProviderSandboxesFor(runId: string): Promise<void> {
    if (options.sandbox === undefined) return;
    try {
      const summaries = await options.sandbox.provider.list({ run: runId });
      for (const summary of summaries) {
        if (options.sandbox.provider.destroy === undefined) {
          logger.warn(
            { runId, sandbox: summary.id },
            "hosting stop: provider cannot destroy by id — sandbox left in place",
          );
          continue;
        }
        await options.sandbox.provider.destroy(summary.id).catch((err: unknown) => {
          logger.warn({ err, runId, sandbox: summary.id }, "hosting stop: destroy failed");
        });
      }
    } catch (err) {
      logger.warn({ err, runId }, "hosting stop: provider list failed");
    }
  }

  /**
   * Stops a hosted run's sandbox now (#110): the row's `hostedUntil`
   * clears first (the run stays `success`), then the container goes —
   * through the executor-owned handle when there is one, else by label.
   */
  async function stopHosting(runId: string): Promise<HostingStopResult> {
    const run = db.runs.get(runId);
    if (run === undefined || run.hostedUntil === undefined) {
      return { outcome: "not_hosted" };
    }
    db.runs.update(runId, { hostedUntil: null });
    const entry = activeSandboxes.get(runId);
    if (entry !== undefined && entry.hosted) {
      activeSandboxes.delete(runId);
      await entry.tailer?.stop().catch(() => {});
      try {
        await entry.handle.destroy();
      } catch (err) {
        logger.warn(
          { err, runId, sandbox: entry.handle.id },
          "hosted sandbox destroy failed (stop hosting)",
        );
      }
    } else {
      await destroyProviderSandboxesFor(runId);
    }
    logger.info({ runId }, "hosting stopped (manual) — sandbox destroyed, run stays success");
    return { outcome: "stopped" };
  }

  /**
   * Extends a hosted run's TTL (#110): `hostedUntil += minutes`, capped
   * 24h from now (a fresh extend just re-arms the cap window) and never
   * shrinking below the current expiry.
   */
  async function extendHosting(runId: string, minutes: number): Promise<HostingExtendResult> {
    const run = db.runs.get(runId);
    if (run === undefined || run.hostedUntil === undefined) {
      return { outcome: "not_hosted" };
    }
    const now = Date.now();
    const current = Date.parse(run.hostedUntil);
    const base = Number.isFinite(current) ? current : now;
    const next = Math.min(base + minutes * 60_000, now + MAX_HOSTING_EXTEND_MINUTES * 60_000);
    const until = new Date(Math.max(base, next)).toISOString();
    db.runs.update(runId, { hostedUntil: until });
    logger.info({ runId, until, minutes }, "hosted run TTL extended");
    return { outcome: "extended", until };
  }

  const engine = createFlowEngine({
    db,
    worktrees,
    drivers,
    logger,
    onRunStatus: (runId) => notifyRunStatus(runId),
    ...(secrets === undefined ? {} : { loadRunSecrets: secrets.loadRunSecrets }),
    ...(acquireRunSandbox === undefined ? {} : { acquireRunSandbox }),
  });

  /** Global semaphore: at most `maxConcurrentRuns` runs execute at once. */
  const limit = pLimit(maxConcurrentRuns);
  /** Per-project gates: projectId → the run holding the project's turn + waiters. */
  const projectGates = new Map<string, ProjectGate>();
  /**
   * Pending sandbox-cap retries (#105): runId → the delay-requeue timer.
   * The runs are NOT in `active` (their row stays `queued`), so abort and
   * shutdown clear these timers explicitly.
   */
  const sandboxCapRetries = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * #105: true when this project's runs execute in sandboxes AND the
   * provider is at `maxSandboxes` live containers. Local runs never block;
   * provider hiccups degrade to "not at cap" (the create attempt itself
   * surfaces typed errors).
   */
  async function sandboxCapReached(projectId: string): Promise<boolean> {
    if (options.sandbox === undefined) return false;
    const project = db.projects.get(projectId);
    const policy = project?.sandboxPolicy;
    const isDockerAvailable = options.sandbox.isDockerAvailable ?? (() => dockerAvailable());
    if (resolveExecutionMode(policy, await isDockerAvailable()) !== "sandbox") return false;
    try {
      return (await options.sandbox.provider.list()).length >= maxSandboxes;
    } catch (err) {
      logger.warn({ err, projectId }, "sandbox cap check failed (assuming below cap)");
      return false;
    }
  }

  /**
   * Delay-requeues a sandbox-capped run (#105): after `capRetryMs` the run
   * re-enters the scheduler (fresh policy/cap checks) unless it went
   * terminal or was restarted meanwhile. The timer is unref'd and cleared
   * by abort/shutdown.
   */
  function scheduleSandboxCapRetry(runId: string, opts: StartRunOptions | undefined): void {
    if (sandboxCapRetries.has(runId)) return;
    const timer = setTimeout(() => {
      sandboxCapRetries.delete(runId);
      const row = db.runs.get(runId);
      if (row === undefined || isTerminal(row.status) || active.has(runId)) return;
      startRun(runId, opts);
    }, capRetryMs);
    timer.unref?.();
    sandboxCapRetries.set(runId, timer);
    logger.info(
      { runId, maxSandboxes, retryInMs: capRetryMs },
      "sandbox cap reached — run stays queued, retry scheduled",
    );
  }

  /** Clears a pending cap retry (abort path) so it cannot fire later. */
  function clearSandboxCapRetry(runId: string): void {
    const timer = sandboxCapRetries.get(runId);
    if (timer === undefined) return;
    clearTimeout(timer);
    sandboxCapRetries.delete(runId);
  }

  /** Resolves when it is this run's turn for the project; FIFO per project. */
  function acquireProjectGate(projectId: string, runId: string): Promise<void> {
    const gate = projectGates.get(projectId);
    if (gate === undefined) {
      projectGates.set(projectId, { holderRunId: runId, waiters: [] });
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      gate.waiters.push({ runId, resolve });
    });
  }

  /**
   * Hands the project's turn to the next waiter (if any). Only the current
   * holder may release; anything else is a no-op (e.g. a cancelled waiter
   * that was never the holder).
   */
  function releaseProjectGate(projectId: string, runId: string): void {
    const gate = projectGates.get(projectId);
    if (gate === undefined || gate.holderRunId !== runId) return;
    const next = gate.waiters.shift();
    if (next === undefined) {
      projectGates.delete(projectId);
      return;
    }
    gate.holderRunId = next.runId;
    next.resolve();
  }

  /**
   * Drops a queued waiter (abort before start). Its acquire promise is
   * resolved anyway so the run's `done` bookkeeping settles; the scheduler
   * skip-check then finishes it without executing or touching the gate.
   */
  function cancelProjectWaiter(projectId: string, runId: string): void {
    const gate = projectGates.get(projectId);
    if (gate === undefined) return;
    const index = gate.waiters.findIndex((waiter) => waiter.runId === runId);
    if (index === -1) return;
    const [waiter] = gate.waiters.splice(index, 1) as [{ runId: string; resolve: () => void }];
    waiter.resolve();
  }

  function failRun(runId: string, message: string): void {
    try {
      const run = db.runs.get(runId);
      const redact = run === undefined ? (text: string) => text : redactorFor(run.projectId);
      logger.error({ runId, error: redact(message) }, "run failed");
      if (!run || isTerminal(run.status)) return;
      db.runs.update(runId, { status: "failed", error: redact(message) });
      notifyRunStatus(runId);
    } catch (err) {
      logger.error({ err, runId }, "marking run failed failed");
    }
  }

  /** Moves queued/live step runs to a terminal status (abort before engine start). */
  function settleStepRuns(runId: string, status: RunStatus): void {
    for (const step of db.stepRuns.listByRun(runId)) {
      if (!isTerminal(step.status)) {
        db.stepRuns.update(step.id, { status });
      }
    }
  }

  /** Aborts a run the engine never started: row + step runs, no engine events. */
  function abortBeforeStart(runId: string, projectId: string): void {
    cancelProjectWaiter(projectId, runId);
    db.runs.updateStatus(runId, "aborted");
    settleStepRuns(runId, "aborted");
    notifyRunStatus(runId);
    logger.info({ runId }, "run aborted before start");
  }

  async function execute(entry: ActiveRun, opts: StartRunOptions | undefined): Promise<void> {
    const { runId } = entry;
    try {
      await engine.executeRun(
        runId,
        {
          isAbortRequested: () => entry.abortRequested,
          onHandle: (handle) => {
            entry.handle = handle;
          },
        },
        { driverId, ...opts },
      );
    } catch (err) {
      // Belt and braces: the engine funnels failures into the run row itself.
      failRun(runId, describeError(err));
    } finally {
      // #102 FIRST: the run's sandbox (if any) is destroyed/kept before the
      // run leaves the active set, so "executor idle" implies "no sandbox of
      // the run is still being torn down".
      await disposeSandbox(runId);
      active.delete(runId);
    }
  }

  function startRun(runId: string, opts?: StartRunOptions): void {
    const existing = active.get(runId);
    if (existing || sandboxCapRetries.has(runId)) {
      logger.warn({ runId }, "startRun ignored: run is already executing or queued");
      return;
    }
    const run = db.runs.get(runId);
    if (!run) {
      logger.warn({ runId }, "startRun ignored: unknown run");
      return;
    }
    const entry: ActiveRun = {
      runId,
      projectId: run.projectId,
      abortRequested: false,
      done: Promise.resolve(),
    };
    active.set(runId, entry);
    // Queued admission is itself a transition the dashboard cares about
    // (queue badges / new table rows). No feed entry: `queued` is not
    // feed-worthy — the feed starts at run.started.
    publishRunStatus({
      runId,
      status: "queued",
      projectId: run.projectId,
      ...revisionRef(db, run.workflowRevisionId),
    });
    // Deferred so the HTTP response for POST /api/runs is not interleaved with
    // the engine's first (synchronous) bookkeeping steps. The run then waits
    // for its project's turn, joins the global semaphore queue, executes, and
    // releases the project turn on the way out (terminal, one way or another).
    entry.done = Promise.resolve()
      .then(async () => {
        await acquireProjectGate(run.projectId, runId);
        const row = db.runs.get(runId);
        if (entry.abortRequested || row === undefined || isTerminal(row.status)) {
          // Aborted while queued (or lost): never hand it to the engine. The
          // gate release is a no-op unless this run held the project turn.
          releaseProjectGate(run.projectId, runId);
          active.delete(runId);
          return;
        }
        // #105: sandbox cap — a sandbox-mode run dequeued while the provider
        // sits at MAX_SANDBOXES stays `queued` and re-enters the scheduler
        // after capRetryMs (the row keeps its queued status; nothing runs).
        if (await sandboxCapReached(run.projectId)) {
          releaseProjectGate(run.projectId, runId);
          active.delete(runId);
          scheduleSandboxCapRetry(runId, opts);
          return;
        }
        try {
          await limit(() => execute(entry, opts));
        } finally {
          releaseProjectGate(run.projectId, runId);
        }
      })
      .catch((err: unknown) => {
        logger.error({ err, runId }, "executor crashed unexpectedly");
        failRun(runId, describeError(err));
        releaseProjectGate(run.projectId, runId);
        active.delete(runId);
      });
  }

  async function abortRun(runId: string): Promise<AbortRunResult> {
    const run = db.runs.get(runId);
    if (!run) return { outcome: "not_found" };
    if (isTerminal(run.status)) {
      return { outcome: "not_abortable", status: run.status };
    }

    const entry = active.get(runId);
    if (!entry) {
      // Queued but never handed to the executor (or lost across a restart).
      // #105: a pending sandbox-cap retry is cancelled with it.
      clearSandboxCapRetry(runId);
      abortBeforeStart(runId, run.projectId);
      return { outcome: "aborted" };
    }

    entry.abortRequested = true;
    if (run.status === "queued" && entry.handle === undefined) {
      // Still waiting in the scheduler: drop it from the queue and finalize
      // directly; the engine no-ops if a slot is acquired afterwards.
      abortBeforeStart(runId, entry.projectId);
      return { outcome: "aborted" };
    }

    if (entry.handle) {
      await entry.handle.abort();
    }
    // Sandboxed runs (#102): the driver abort cancels in-flight sandbox
    // execs; stop the container too (idempotent). Destroy happens in the
    // execution's dispose pass (honoring keepForDebug).
    const sandbox = activeSandboxes.get(runId);
    if (sandbox !== undefined) {
      await sandbox.stop();
    }
    const current = db.runs.get(runId);
    if (current && !isTerminal(current.status)) {
      db.runs.updateStatus(runId, "aborted");
      settleStepRuns(runId, "aborted");
      // The engine emits (and records) the terminal transition itself when
      // its event loop observes the abort; when the driver stalls mid-stream
      // it may not settle within any useful window, so record here too —
      // the activity writer dedupes an identical terminal entry.
      notifyRunStatus(runId);
    }
    logger.info({ runId }, "run aborted");
    return { outcome: "aborted" };
  }

  async function shutdown(): Promise<void> {
    // #105: cancel pending sandbox-cap retries — their runs stay `queued`
    // rows (the next boot's recovery sweep settles them, like any crash).
    for (const timer of sandboxCapRetries.values()) clearTimeout(timer);
    sandboxCapRetries.clear();
    const entries = [...active.values()];
    if (entries.length === 0) return;
    logger.info({ runs: entries.map((entry) => entry.runId) }, "executor shutdown: aborting runs");
    for (const entry of entries) {
      entry.abortRequested = true;
      const run = db.runs.get(entry.runId);
      if (run && !isTerminal(run.status)) {
        if (run.status === "queued") {
          // Scheduler-queued: drop from the queue and finalize without start.
          cancelProjectWaiter(entry.projectId, entry.runId);
          db.runs.updateStatus(entry.runId, "aborted");
          settleStepRuns(entry.runId, "aborted");
          notifyRunStatus(entry.runId);
        } else {
          db.runs.updateStatus(entry.runId, "aborted");
        }
      }
      await entry.handle?.abort().catch(() => {});
      // #102: stop the run's sandbox (cancels any exec the driver could
      // not reach); the dispose pass after `done` destroys or keeps it.
      const sandbox = activeSandboxes.get(entry.runId);
      if (sandbox !== undefined) await sandbox.stop().catch(() => {});
    }
    await Promise.race([
      Promise.allSettled(entries.map((entry) => entry.done)),
      delay(shutdownSettleMs),
    ]);
    // Final settle pass: step rows the engine could not settle within the
    // window (abort race lost to a slow driver) must not linger as zombies —
    // the run row is already `aborted`, never `interrupted` (that status is
    // reserved for the boot sweep of a dead daemon).
    for (const entry of entries) {
      const run = db.runs.get(entry.runId);
      if (run && run.status === "aborted") {
        settleStepRuns(entry.runId, "aborted");
      }
    }
    // #102: sandboxes of runs that did not settle within the window would
    // otherwise leak containers — destroy them best-effort (debug-kept
    // sandboxes are exempt by design).
    for (const entry of entries) {
      const sandbox = activeSandboxes.get(entry.runId);
      if (sandbox === undefined) continue;
      activeSandboxes.delete(entry.runId);
      // #104: flush the log tail before the container goes away.
      await sandbox.tailer?.stop().catch(() => {});
      if (sandbox.keepForDebug) {
        recordSandboxKeptActivity(db, {
          runId: entry.runId,
          container: sandbox.handle.id,
          image: sandbox.image,
        });
        continue;
      }
      await sandbox.handle.destroy().catch((err: unknown) => {
        logger.warn({ err, runId: entry.runId }, "sandbox destroy during shutdown failed");
      });
    }
    logger.info("executor shutdown complete");
  }

  return {
    startRun,
    abortRun,
    shutdown,
    activeRunIds: () => [...active.keys()],
    onRunStatus: (listener: RunStatusListener): (() => void) => {
      runStatusListeners.add(listener);
      return () => {
        runStatusListeners.delete(listener);
      };
    },
    async sandboxInfo(runId): Promise<RunSandboxInfo | undefined> {
      const entry = activeSandboxes.get(runId);
      if (entry === undefined) return undefined;
      let status: SandboxStatus;
      try {
        status = await entry.handle.status();
      } catch {
        // Provider hiccup: report the last known lifecycle state.
        status = entry.stopped ? "stopped" : "running";
      }
      // #107: live port views — declared ports mapped through the sandbox's
      // hostPorts() (a stopped sandbox publishes nothing), detected-undeclared
      // ones with the declare-to-preview hint.
      let hostPorts: SandboxHostPorts = {};
      if (!entry.stopped) {
        hostPorts = await entry.handle.hostPorts().catch((err: unknown) => {
          logger.warn({ err, runId }, "sandbox hostPorts() failed");
          return {};
        });
      }
      const run = db.runs.get(runId);
      const ports = buildRunPortViews(run?.ports, run?.detectedPorts, hostPorts);
      return {
        id: entry.handle.id,
        image: entry.image,
        status,
        ...(ports.length === 0 ? {} : { ports }),
      };
    },
    maxConcurrentRuns,
    stopHosting,
    extendHosting,
  };
}
