import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunStatus } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { WorktreeManager } from "@openeuler/engine";
import { createApp } from "./app.js";
import { recordDaemonBootActivity } from "./activity.js";
import { createExecutor } from "./executor.js";
import { createLogger } from "./logger.js";
import {
  METRICS_CONTENT_TYPE,
  collectMetrics,
  escapeLabelValue,
  renderMetrics,
} from "./metrics.js";
import { sweepInterruptedRuns } from "./recovery.js";
import { getVersion } from "./version.js";

/**
 * #94: `GET /metrics` — hand-rolled Prometheus text exposition (0.0.4)
 * refreshed on scrape from cheap sqlite counts + in-memory executor state;
 * ops events (`ops.daemon-boot`, `ops.recovery-sweep`) land in the feed.
 */

const TOKEN = "s3cret-metrics-token-94";

interface ApiHarness {
  dir: string;
  db: Db;
  worktrees: WorktreeManager;
  executor: ReturnType<typeof createExecutor>;
  request: (input: string | Request, init?: RequestInit) => Promise<Response>;
  projectId: string;
}

const created: Array<{ db: Db; dir: string }> = [];

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `probe` (with retries) until it returns true; fails after 5s. */
async function until(probe: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error("condition never became true");
    await sleep(10);
  }
}

const setup = (
  fakeOpts: Parameters<typeof createFakeDriver>[0] = {},
  authToken?: string,
): ApiHarness => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-metrics-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const repoPath = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# demo\n");
  git(repoPath, "add", "-A");
  git(repoPath, "-c", "user.email=t@openeuler.dev", "-c", "user.name=T", "commit", "-m", "init");

  const project = db.projects.create({
    id: crypto.randomUUID(),
    path: repoPath,
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });

  const drivers = createDriverRegistry();
  drivers.registerDriver(createFakeDriver(fakeOpts));
  const worktrees = new WorktreeManager({ storeRoot: join(dir, "store") });
  const executor = createExecutor({ db, worktrees, drivers, logger: createLogger("silent") });
  const { app } = createApp({
    db,
    logger: createLogger("silent"),
    executor,
    worktrees,
    ...(authToken === undefined ? {} : { authToken }),
  });

  created.push({ db, dir });
  return {
    dir,
    db,
    worktrees,
    executor,
    request: (input, init) => Promise.resolve(app.request(input, init)),
    projectId: project.id,
  };
};

const seedRun = (h: ApiHarness, id: string, status: RunStatus): void => {
  const now = new Date().toISOString();
  h.db.runs.create({
    id,
    projectId: h.projectId,
    status,
    branch: `openeuler/${id}`,
    iteration: 0,
    createdAt: now,
    updatedAt: now,
  });
};

interface ParsedSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

interface ParsedExposition {
  samples: ParsedSample[];
  helps: Map<string, string>;
  types: Map<string, string>;
}

/** Strict exposition parser: every non-comment line must be `name{labels} value`. */
function parseExposition(text: string): ParsedExposition {
  const samples: ParsedSample[] = [];
  const helps = new Map<string, string>();
  const types = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const comment = /^# (HELP|TYPE) ([a-zA-Z_:][a-zA-Z0-9_:]*) (.+)$/.exec(line);
    if (comment) {
      (comment[1] === "HELP" ? helps : types).set(comment[2] as string, comment[3] as string);
      continue;
    }
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    expect(match, `unparsable sample line: ${line}`).toBeDefined();
    const labels: Record<string, string> = {};
    for (const lm of (match?.[2] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      labels[lm[1] as string] = lm[2] as string;
    }
    const value = Number(match?.[3]);
    expect(Number.isFinite(value), `non-finite sample value on line: ${line}`).toBe(true);
    samples.push({ name: match?.[1] as string, labels, value });
  }
  return { samples, helps, types };
}

const scrape = async (
  h: ApiHarness,
  init?: RequestInit,
): Promise<{ status: number; contentType: string; text: string; exposition: ParsedExposition }> => {
  const res = await h.request("/metrics", init);
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    text,
    // Non-200 bodies (401 JSON) are asserted via status/text, not parsed.
    exposition:
      res.status === 200
        ? parseExposition(text)
        : { samples: [], helps: new Map(), types: new Map() },
  };
};

const runStatusSample = (e: ParsedExposition, status: string): ParsedSample | undefined =>
  e.samples.find((s) => s.name === "openeuler_runs_total" && s.labels["status"] === status);

const valueOf = (e: ParsedExposition, name: string): number | undefined =>
  e.samples.find((s) => s.name === name && Object.keys(s.labels).length === 0)?.value;

const TERMINAL: ReadonlySet<string> = new Set(["success", "failed", "aborted", "interrupted"]);

const awaitStatus = async (
  h: ApiHarness,
  runId: string,
  statuses: ReadonlySet<string>,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = h.db.runs.get(runId);
    if (run !== undefined && statuses.has(run.status)) return;
    if (Date.now() > deadline) throw new Error(`run ${runId} never reached ${[...statuses]}`);
    await sleep(10);
  }
};

const postRun = (h: ApiHarness, prompt: string): Promise<{ id: string }> =>
  h
    .request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: h.projectId, prompt }),
    })
    .then(async (res) => {
      expect(res.status).toBe(202);
      return (await res.json()) as { run: { id: string } };
    })
    .then((body) => body.run);

const ALL_STATUSES: RunStatus[] = [
  "queued",
  "running",
  "success",
  "failed",
  "aborted",
  "interrupted",
];

const EXPECTED_FAMILIES = [
  "openeuler_info",
  "openeuler_uptime_seconds",
  "openeuler_runs_total",
  "openeuler_runs_active",
  "openeuler_queue_depth",
  "openeuler_event_log_rows",
  "openeuler_worktrees_active",
  "openeuler_sandboxes_active",
];

describe("renderMetrics (exposition format)", () => {
  it("emits HELP + TYPE for every family and only parsable samples", () => {
    const { samples, helps, types } = parseExposition(renderMetrics(collectMetrics()));
    const names = new Set(samples.map((s) => s.name));
    for (const family of EXPECTED_FAMILIES) {
      expect(names.has(family), `missing samples for ${family}`).toBe(true);
      expect(helps.get(family), `missing HELP for ${family}`).toBeTruthy();
      expect(types.get(family), `missing TYPE for ${family}`).toBe("gauge");
    }
    // The text ends with exactly one trailing newline.
    const text = renderMetrics(collectMetrics());
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("emits one runs_total sample per status (zeros included) and the info/uptime gauges", () => {
    const snapshot = collectMetrics();
    const { samples } = parseExposition(renderMetrics(snapshot));
    for (const status of ALL_STATUSES) {
      const sample = samples.find(
        (s) => s.name === "openeuler_runs_total" && s.labels["status"] === status,
      );
      expect(sample, `missing runs_total{status="${status}"}`).toBeDefined();
      expect(sample?.value).toBe(0);
    }
    const info = samples.find((s) => s.name === "openeuler_info");
    expect(info?.labels["version"]).toBe(getVersion());
    expect(info?.value).toBe(1);
    expect(
      samples.find((s) => s.name === "openeuler_uptime_seconds")?.value,
    ).toBeGreaterThanOrEqual(0);
    expect(samples.find((s) => s.name === "openeuler_sandboxes_active")?.value).toBe(0);
  });

  it("escapes label values (backslash, quote, newline)", () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(escapeLabelValue("0.0.4")).toBe("0.0.4");
  });
});

describe("collectMetrics (counts against a seeded db)", () => {
  it("computes run/event counts from sqlite and defaults in-memory gauges", () => {
    const dir = mkdtempSync(join(tmpdir(), "openeuler-metrics-db-"));
    const db = createDatabase({ path: join(dir, "test.db") });
    created.push({ db, dir });
    const now = new Date().toISOString();
    const project = db.projects.create({
      id: "p-1",
      path: join(dir, "repo"),
      name: "repo",
      defaultBranch: "main",
      createdAt: now,
    });
    const seed = (id: string, status: RunStatus): void => {
      db.runs.create({
        id,
        projectId: project.id,
        status,
        branch: `openeuler/${id}`,
        iteration: 0,
        createdAt: now,
        updatedAt: now,
      });
    };
    seed("r-queued", "queued");
    seed("r-running", "running");
    seed("r-success-1", "success");
    seed("r-success-2", "success");
    seed("r-failed", "failed");
    db.events.append("r-running", { type: "run.status", status: "running" });
    db.events.append("r-success-1", { type: "run.status", status: "success" });
    db.events.append("r-success-1", { type: "done", output: "ok" });

    const snapshot = collectMetrics({
      db,
      worktrees: new WorktreeManager({ storeRoot: join(dir, "store") }),
    });
    expect(snapshot.runsByStatus).toEqual({
      queued: 1,
      running: 1,
      success: 2,
      failed: 1,
      aborted: 0,
      interrupted: 0,
    });
    expect(snapshot.queueDepth).toBe(1);
    expect(snapshot.eventLogRows).toBe(3);
    expect(snapshot.runsActive).toBe(0);
    expect(snapshot.worktreesActive).toBe(0);
    expect(snapshot.version).toBe(getVersion());

    // The rendered exposition carries the same numbers.
    const { samples } = parseExposition(renderMetrics(snapshot));
    expect(
      samples.find((s) => s.name === "openeuler_runs_total" && s.labels["status"] === "success")
        ?.value,
    ).toBe(2);
    expect(samples.find((s) => s.name === "openeuler_event_log_rows")?.value).toBe(3);
    expect(samples.find((s) => s.name === "openeuler_queue_depth")?.value).toBe(1);
  });
});

describe("GET /metrics (auth matrix)", () => {
  it("serves the exposition without a token in open mode", async () => {
    const h = setup();
    const { status, contentType, exposition } = await scrape(h);
    expect(status).toBe(200);
    expect(contentType).toBe(METRICS_CONTENT_TYPE);
    expect(exposition.samples.find((s) => s.name === "openeuler_info")?.labels["version"]).toBe(
      getVersion(),
    );
  });

  it("requires auth in token mode: 401 without, 200 via bearer header, 200 via ?token=", async () => {
    const h = setup({}, TOKEN);
    const denied = await scrape(h);
    expect(denied.status).toBe(401);
    expect(denied.text).toContain("UNAUTHORIZED");

    const wrong = await scrape(h, { headers: { Authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);

    const header = await scrape(h, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(header.status).toBe(200);
    expect(header.contentType).toBe(METRICS_CONTENT_TYPE);

    const query = await h.request(`/metrics?token=${encodeURIComponent(TOKEN)}`);
    expect(query.status).toBe(200);
    expect(query.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE);
  });
});

describe("GET /metrics (fake-driver run lifecycle)", () => {
  it("gauges move between scrapes across a run lifecycle", { timeout: 15_000 }, async () => {
    const h = setup({ onStart: () => sleep(2_000) });
    const before = (await scrape(h)).exposition;
    expect(valueOf(before, "openeuler_runs_active")).toBe(0);
    expect(runStatusSample(before, "aborted")).toMatchObject({ value: 0 });

    const run = await postRun(h, "gauge me");
    await awaitStatus(h, run.id, new Set(["running"]));
    // The engine flips `running` before creating the worktree — wait for the
    // worktree itself so the mid-run scrape is deterministic.
    await until(() => h.worktrees.activeCount() === 1);

    const during = (await scrape(h)).exposition;
    expect(valueOf(during, "openeuler_runs_active")).toBe(1);
    expect(runStatusSample(during, "running")?.value).toBe(1);
    // The executing run holds a live git worktree.
    expect(valueOf(during, "openeuler_worktrees_active")).toBe(1);
    const eventsDuring = valueOf(during, "openeuler_event_log_rows") ?? 0;
    expect(eventsDuring).toBeGreaterThan(0);

    const abort = await h.request(`/api/runs/${run.id}/abort`, { method: "POST" });
    expect(abort.status).toBe(200);
    await awaitStatus(h, run.id, TERMINAL);
    // The row is terminal before the engine unwinds; runs_active only drops
    // once the executor's in-memory bookkeeping settles.
    await until(() => h.executor.activeRunIds().length === 0);

    const after = (await scrape(h)).exposition;
    expect(valueOf(after, "openeuler_runs_active")).toBe(0);
    expect(runStatusSample(after, "running")?.value).toBe(0);
    expect(runStatusSample(after, "aborted")?.value).toBe(1);
    expect(valueOf(after, "openeuler_event_log_rows") ?? 0).toBeGreaterThanOrEqual(eventsDuring);
  });

  it("counts a successful fake-driver run", async () => {
    const h = setup();
    const run = await postRun(h, "succeed");
    await awaitStatus(h, run.id, TERMINAL);
    const { exposition, status } = await scrape(h);
    expect(status).toBe(200);
    expect(runStatusSample(exposition, "success")?.value).toBe(1);
    expect(valueOf(exposition, "openeuler_runs_active")).toBe(0);
  });
});

describe("ops events (#94) in /api/activity", () => {
  it("shows ops.daemon-boot and the recovery sweep as system feed rows", async () => {
    const h = setup();
    seedRun(h, "r-stuck", "queued");

    recordDaemonBootActivity(h.db, "9.9.9");
    const sweep = await sweepInterruptedRuns({
      db: h.db,
      worktrees: h.worktrees,
      executor: createExecutor({
        db: h.db,
        worktrees: h.worktrees,
        drivers: createDriverRegistry(),
        logger: createLogger("silent"),
      }),
      logger: createLogger("silent"),
    });
    expect(sweep.interruptedRunIds).toEqual(["r-stuck"]);

    const res = await h.request("/api/activity");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ type: string; message: string; project?: unknown; run?: unknown }>;
    };
    const boot = body.items.find((item) => item.type === "ops.daemon-boot");
    expect(boot).toMatchObject({ message: "Daemon v9.9.9 started" });
    expect(boot?.project).toBeUndefined();
    expect(boot?.run).toBeUndefined();

    const sweepItem = body.items.find((item) => item.type === "ops.recovery-sweep");
    expect(sweepItem?.message).toBe("Boot recovery sweep: 1 interrupted run, 0 orphaned worktrees");
    expect(sweepItem?.project).toBeUndefined();
    expect(sweepItem?.run).toBeUndefined();
  });
});

afterEach(() => {
  while (created.length > 0) {
    const item = created.pop() as { db: Db; dir: string };
    item.db.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});
