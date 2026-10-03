import type { Db } from "@openeuler/db";
import type { SandboxHandle, SandboxLogEntry } from "@openeuler/sandbox";

/**
 * Bounded sandbox-log streaming into the run event log (#104).
 *
 * While a run's sandbox exists, its container stdout/stderr lines become
 * first-class run history: the tailer polls `handle.logs({ since: cursor })`
 * every `pollIntervalMs` (follow-ish; simpler than `docker logs --follow`
 * attach, and provider-agnostic) and appends ONE `sandbox.log` event per
 * line, in emission order.
 *
 * ## Bounded ring — drop-oldest
 *
 * The persisted `sandbox.log` events per run are capped at
 * {@link SANDBOX_LOG_EVENT_CAP} (last N kept): when appending would exceed
 * the cap, the OLDEST persisted `sandbox.log` rows for the run are deleted
 * (`db.events.deleteOldestByType` — the tailer is the sole writer of the
 * type, so its in-memory counters stay authoritative). When the tailer
 * stops it appends ONE `sandbox.log-truncated { dropped, kept }` marker
 * (per run) whenever anything was evicted — `dropped` is the exact number
 * of lines that fell out of the ring.
 *
 * ## Boundary dedupe
 *
 * `since` filtering is inclusive at provider timestamp precision (docker
 * parses timestamps to ns, the contract exposes epoch-ms `at`), so a poll
 * can re-deliver lines already appended. The cursor therefore advances to
 * the NEWEST `at` observed in a batch — docker stamps every line at write
 * time, so any future line on ANY stream is newer than every line in the
 * batch, and a quiet stream can never pin the cursor into a full re-fetch
 * loop (#149). Each stream still keeps a bounded recent-key history
 * ({@link StreamLogJoiner}) as a safety net; a poll's already-seen
 * PREFIX (the longest history-suffix ∩ batch-prefix match over
 * `(at, line)` keys) is dropped before appending — correct even for bursts
 * of identical lines, because matching is over key SEQUENCES. Entries
 * without `at` fall back to line-only keys.
 *
 * ## Provider markers
 *
 * Lines matching {@link PROVIDER_TRUNCATION_MARKER} are provider-internal
 * bookkeeping (docker's per-snapshot byte-cap notice), not container
 * output — they are dropped before persistence and never counted by the
 * ring (#149).
 */

/** Max persisted `sandbox.log` events per run (the ring size). */
export const SANDBOX_LOG_EVENT_CAP = 2000;

/** Default poll interval for the follow-ish log tail. */
export const DEFAULT_SANDBOX_LOG_POLL_INTERVAL_MS = 500;

/**
 * Recent-key history per stream for boundary dedupe (bounded memory). Sized
 * to cover a full cap-burst re-delivered around the cursor: docker stamps
 * log lines at ns precision but the contract exposes epoch-ms `at`, so a
 * poll can re-deliver every line sharing the cursor's millisecond — the
 * joiner must be able to match that entire overlap. Bursts larger than this
 * split across a boundary poll may still duplicate (documented residual;
 * the ring cap keeps the log bounded either way).
 */
const JOINER_HISTORY = 8192;

/** Bound for one logs() poll (and the final flush) so stop() never hangs. */
const POLL_TIMEOUT_MS = 10_000;

/**
 * Provider-internal truncation notice (docker.ts emits one per stream when
 * a snapshot crosses its byte cap). Transport bookkeeping, not container
 * output — filtered before persistence so it never leaks into run history.
 */
const PROVIDER_TRUNCATION_MARKER = /^\[openeuler\] (stdout|stderr) log snapshot truncated/;

const entryKey = (entry: SandboxLogEntry): string =>
  entry.at === undefined ? entry.line : `${entry.at}\u0000${entry.line}`;

/**
 * Per-stream overlap joiner: `join(batch)` returns the trailing entries of
 * `batch` that were NOT already consumed (dropping the longest suffix of
 * the recent history that matches a prefix of the batch — the classic
 * overlapping-log-merge). Exported for unit tests.
 */
export class StreamLogJoiner {
  private readonly history: string[] = [];

  constructor(private readonly maxHistory = JOINER_HISTORY) {}

  /** Keys of the entries already consumed, oldest first (bounded; test aid). */
  keys(): readonly string[] {
    return this.history;
  }

  join(batch: readonly SandboxLogEntry[]): SandboxLogEntry[] {
    if (batch.length === 0) return [];
    const keys = batch.map(entryKey);
    const maxOverlap = Math.min(this.history.length, keys.length);
    let overlap = 0;
    for (let candidate = maxOverlap; candidate > 0; candidate -= 1) {
      let match = true;
      for (let index = 0; index < candidate; index += 1) {
        if (this.history[this.history.length - candidate + index] !== keys[index]) {
          match = false;
          break;
        }
      }
      if (match) {
        overlap = candidate;
        break;
      }
    }
    const fresh = batch.slice(overlap);
    for (const key of keys.slice(overlap)) {
      this.history.push(key);
      if (this.history.length > this.maxHistory) this.history.shift();
    }
    return fresh as SandboxLogEntry[];
  }
}

export interface SandboxLogTailerOptions {
  db: Db;
  handle: SandboxHandle;
  runId: string;
  /** Provider-scoped sandbox id stamped onto every emitted event. */
  sandboxId: string;
  /** Redacts a line before persistence (project secrets, #93). */
  redact: (text: string) => string;
  /** Poll interval; default {@link DEFAULT_SANDBOX_LOG_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Ring cap; default {@link SANDBOX_LOG_EVENT_CAP}. */
  cap?: number;
  /** Warn sink for transient poll failures (never fatal). */
  onWarn?: (message: string) => void;
}

export interface SandboxLogTailer {
  /**
   * Stops polling after one final flush and appends the single
   * `sandbox.log-truncated` marker when lines were evicted. Idempotent;
   * never throws.
   */
  stop(): Promise<void>;
}

/** Starts the tail loop for one sandbox; call `stop()` at dispose. */
export function startSandboxLogTailer(options: SandboxLogTailerOptions): SandboxLogTailer {
  const { db, handle, runId, sandboxId, redact, onWarn } = options;
  const pollIntervalMs = Math.max(
    10,
    options.pollIntervalMs ?? DEFAULT_SANDBOX_LOG_POLL_INTERVAL_MS,
  );
  const cap = Math.max(1, options.cap ?? SANDBOX_LOG_EVENT_CAP);

  const joiners = { stdout: new StreamLogJoiner(), stderr: new StreamLogJoiner() };
  // Start slightly before creation: containers can log immediately, and the
  // joiner removes any re-delivered overlap.
  let cursor = Date.now() - 1_000;
  /** `sandbox.log` rows currently persisted for the run. */
  let persisted = 0;
  /** Total lines lost from the ring (batch heads skipped + rows evicted). */
  let dropped = 0;
  let stopped = false;
  let waker: (() => void) | null = null;
  let stopPromise: Promise<void> | null = null;

  const warn = (err: unknown, what: string): void => {
    onWarn?.(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const appendEvent = (entry: SandboxLogEntry): void => {
    db.events.append(runId, {
      type: "sandbox.log",
      sandboxId,
      stream: entry.stream,
      line: redact(entry.line),
    });
    persisted += 1;
  };

  /** Appends fresh entries, evicting the oldest persisted rows past the cap. */
  const appendBounded = (entries: readonly SandboxLogEntry[]): void => {
    if (entries.length === 0) return;
    if (entries.length >= cap) {
      // The ring ends up as the last `cap` entries of this batch alone:
      // drop everything persisted, append only the tail (bounded writes).
      if (persisted > 0) dropped += db.events.deleteOldestByType(runId, "sandbox.log", persisted);
      persisted = 0;
      const skip = entries.length - cap;
      if (skip > 0) dropped += skip;
      for (const entry of entries.slice(skip)) appendEvent(entry);
      return;
    }
    for (const entry of entries) appendEvent(entry);
    const overflow = persisted - cap;
    if (overflow > 0) {
      const deleted = db.events.deleteOldestByType(runId, "sandbox.log", overflow);
      dropped += deleted;
      persisted -= deleted;
    }
  };

  /** One follow-ish poll: snapshot since the cursor, dedupe, append, advance. */
  const pollOnce = async (): Promise<void> => {
    const batch: SandboxLogEntry[] = [];
    const collected = (async () => {
      for await (const entry of await handle.logs({ since: cursor })) batch.push(entry);
    })();
    const timeout = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), POLL_TIMEOUT_MS);
      timer.unref?.();
    });
    const outcome = await Promise.race([collected.then(() => "done" as const), timeout]);
    if (outcome === "timeout") {
      // A stuck poll must not hold stop() hostage; swallow the eventual
      // settlement of the background collection.
      collected.catch(() => undefined);
      warn(new Error("logs poll exceeded its bound"), "sandbox log poll skipped");
      return;
    }
    if (batch.length === 0) return;

    // Drop provider-internal truncation markers before anything else: they
    // are transport bookkeeping, not container output (#149).
    const lines = batch.filter((entry) => !PROVIDER_TRUNCATION_MARKER.test(entry.line));
    if (lines.length === 0) return;

    // Advance the cursor to the NEWEST timestamp seen in this batch. Docker
    // stamps each line at write time, so any future line on ANY stream is
    // newer than every line here — taking max (not min across streams)
    // means a quiet stream cannot pin the cursor into a full re-fetch every
    // poll (#149); the joiners below still drop any inclusive-`since`
    // re-delivery as a safety net.
    let newest = 0;
    for (const entry of lines) {
      if (entry.at !== undefined && entry.at > newest) newest = entry.at;
    }
    if (newest > cursor) cursor = newest;

    const freshStdout = joiners.stdout.join(lines.filter((e) => e.stream === "stdout"));
    const freshStderr = joiners.stderr.join(lines.filter((e) => e.stream === "stderr"));
    const freshStdoutSet = new Set(freshStdout);
    const freshStderrSet = new Set(freshStderr);
    appendBounded(
      lines.filter((e) => (e.stream === "stdout" ? freshStdoutSet.has(e) : freshStderrSet.has(e))),
    );
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        waker = null;
        resolve();
      }, ms);
      waker = () => {
        clearTimeout(timer);
        waker = null;
        resolve();
      };
    });

  const loop = (async () => {
    while (!stopped) {
      try {
        await pollOnce();
      } catch (err) {
        warn(err, "sandbox log poll failed");
      }
      if (stopped) break;
      await sleep(pollIntervalMs);
    }
  })();

  const flushAndMark = async (): Promise<void> => {
    try {
      await pollOnce();
    } catch (err) {
      warn(err, "sandbox log final flush failed");
    }
    if (dropped > 0) {
      try {
        db.events.append(runId, {
          type: "sandbox.log-truncated",
          sandboxId,
          dropped,
          kept: persisted,
        });
      } catch (err) {
        warn(err, "sandbox log truncation marker failed");
      }
    }
  };

  return {
    stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise;
      stopped = true;
      stopPromise = (async () => {
        waker?.();
        await loop.catch((err: unknown) => warn(err, "sandbox log tail loop failed"));
        await flushAndMark();
      })();
      return stopPromise;
    },
  };
}
