import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";

/**
 * GET /api/system/check tests. Binaries are mocked via PATH stubs: a stub dir
 * is prepended to PATH with `git`/`opencode` shell scripts that append to an
 * invocation log (for cache assertions) and script the variants under test.
 */

interface Harness {
  stubDir: string;
  logPath: string;
  storeRoot: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

const created: string[] = [];

const originalPath = process.env.PATH;

function makeStub(name: string, body: string, executable = true): void {
  const file = join(harness.stubDir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, executable ? 0o755 : 0o644);
}

/** Stub that logs one line per invocation: `<name>:<args joined by space>`. */
function makeLoggingStub(name: string, body: string): void {
  makeStub(name, [`echo "${name}:$*" >> "${harness.logPath}"`, body].join("\n"));
}

let harness: Harness;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-system-"));
  const stubDir = join(dir, "bin");
  const storeRoot = join(dir, "worktrees");
  mkdirSync(stubDir);
  harness = {
    stubDir,
    logPath: join(dir, "invocations.log"),
    storeRoot,
    request: () => Promise.resolve(new Response()),
  };
  created.push(dir);
  process.env.PATH = `${stubDir}:${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

const appFor = (system: Record<string, unknown> = {}): Harness["request"] => {
  const { app } = createApp({
    logger: createLogger("silent"),
    system: { storeRoot: harness.storeRoot, ...system },
  });
  return (path, init) => Promise.resolve(app.request(path, init));
};

interface CheckBody {
  git: { ok: boolean; version?: string; hint?: string };
  opencode: { ok: boolean; version?: string; authenticated?: boolean; hint?: string };
  worktrees: { ok: boolean; path: string | null };
}

const check = async (
  request: Harness["request"],
  query = "",
): Promise<{ status: number; body: CheckBody }> => {
  const res = await request(`/api/system/check${query}`);
  return { status: res.status, body: (await res.json()) as CheckBody };
};

const logLines = (): string[] =>
  existsSync(harness.logPath)
    ? readFileSync(harness.logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
    : [];

const logCount = (name: string): number =>
  logLines().filter((line) => line.startsWith(`${name}:`)).length;

describe("GET /api/system/check", () => {
  it("reports everything green when git and an authenticated opencode are on PATH", async () => {
    makeLoggingStub("git", `echo "git version 2.43.0"`);
    makeLoggingStub(
      "opencode",
      `if [ "$1" = "--version" ]; then echo "1.18.34"; exit 0; fi
if [ "$1" = "auth" ]; then echo "provider status"; echo "github  ✓ authenticated"; exit 0; fi
exit 1`,
    );

    const { status, body } = await check(appFor());
    expect(status).toBe(200);
    expect(body.git).toEqual({ ok: true, version: "2.43.0" });
    expect(body.opencode).toEqual({ ok: true, version: "1.18.34", authenticated: true });
    expect(body.worktrees).toEqual({ ok: true, path: harness.storeRoot });
    expect(existsSync(harness.storeRoot)).toBe(true);
  });

  it("marks a broken git (version call fails) with ok:false and a hint", async () => {
    makeLoggingStub(
      "opencode",
      `if [ "$1" = "--version" ]; then echo "1.18.34"; exit 0; fi
if [ "$1" = "auth" ]; then echo "github  ✓ authenticated"; exit 0; fi
exit 1`,
    );
    // No git stub, and PATH without the system dirs would break the stub
    // scripts' bash shebang — instead shadow git with a failing stub.
    makeStub("git", `echo "not found" >&2; exit 127`);

    const { body } = await check(appFor());
    expect(body.git.ok).toBe(false);
    expect(body.git.hint).toBeTruthy();
  });

  it("reports git ENOENT when git is genuinely absent from PATH", async () => {
    makeLoggingStub(
      "opencode",
      `if [ "$1" = "--version" ]; then echo "1.18.34"; exit 0; fi
echo "github  ✓ authenticated"`,
    );
    // PATH containing ONLY the stub dir: git resolves to nothing.
    const { app } = createApp({
      logger: createLogger("silent"),
      system: { storeRoot: harness.storeRoot, gitBinary: "git-definitely-not-on-path" },
    });
    const res = await app.request("/api/system/check");
    const body = (await res.json()) as CheckBody;
    expect(body.git.ok).toBe(false);
    expect(body.git.hint).toMatch(/git-scm\.com\/downloads/);
  });

  it("unauthenticated opencode (auth list exits non-zero) surfaces the exact login command", async () => {
    makeLoggingStub("git", `echo "git version 2.43.0"`);
    makeLoggingStub(
      "opencode",
      `if [ "$1" = "--version" ]; then echo "1.18.34"; exit 0; fi
echo "no providers configured" >&2; exit 1`,
    );

    const { body } = await check(appFor());
    expect(body.opencode.ok).toBe(true);
    expect(body.opencode.version).toBe("1.18.34");
    expect(body.opencode.authenticated).toBe(false);
    expect(body.opencode.hint).toContain("Run: opencode auth login");
  });

  it("treats empty auth list output as unauthenticated (tolerant of formats)", async () => {
    makeLoggingStub("git", `echo "git version 2.43.0"`);
    makeLoggingStub(
      "opencode",
      `if [ "$1" = "--version" ]; then echo "1.18.34"; exit 0; fi
exit 0`,
    );

    const { body } = await check(appFor());
    expect(body.opencode.ok).toBe(true);
    expect(body.opencode.authenticated).toBe(false);
    expect(body.opencode.hint).toContain("Run: opencode auth login");
  });

  it("opencode missing entirely: ok:false with install hint, authenticated omitted", async () => {
    makeLoggingStub("git", `echo "git version 2.43.0"`);
    const { app } = createApp({
      logger: createLogger("silent"),
      system: { storeRoot: harness.storeRoot, opencodeBinary: "opencode-definitely-not-on-path" },
    });
    const res = await app.request("/api/system/check");
    const body = (await res.json()) as CheckBody;
    expect(body.opencode.ok).toBe(false);
    expect(body.opencode.authenticated).toBeUndefined();
    expect(body.opencode.hint).toMatch(/opencode\.ai\/docs\/install/);
  });

  it("flags an unwritable worktree store", async () => {
    makeLoggingStub("git", `echo "git version 2.43.0"`);
    makeLoggingStub(
      "opencode",
      `if [ "$1" = "--version" ]; then echo "1.18.34"; exit 0; fi
echo "github  ✓ authenticated"`,
    );
    // A file where the store directory should be: mkdirSync fails (ENOTDIR).
    const blocker = join(harness.stubDir, "..", "blocker");
    writeFileSync(blocker, "in the way");
    const { app } = createApp({
      logger: createLogger("silent"),
      system: { storeRoot: join(blocker, "nested") },
    });
    const res = await app.request("/api/system/check");
    const body = (await res.json()) as CheckBody;
    expect(body.worktrees.ok).toBe(false);
    expect(body.worktrees.path).toBe(join(blocker, "nested"));
  });

  it("caches probes: a second hit within the TTL does not re-spawn binaries", async () => {
    makeLoggingStub("git", `echo "git version 2.43.0"`);
    makeLoggingStub(
      "opencode",
      `if [ "$1" = "--version" ]; then echo "1.18.34"; exit 0; fi
echo "github  ✓ authenticated"`,
    );

    const request = appFor({ cacheTtlMs: 60_000 });
    await check(request);
    await check(request);
    await check(request);

    expect(logCount("git")).toBe(1);
    expect(logCount("opencode")).toBe(2); // --version + auth list, once each
  });

  it("expires the cache after the TTL and re-probes", async () => {
    makeLoggingStub("git", `echo "git version 2.43.0"`);
    makeLoggingStub(
      "opencode",
      `if [ "$1" = "--version" ]; then echo "1.18.34"; exit 0; fi
echo "github  ✓ authenticated"`,
    );

    const request = appFor({ cacheTtlMs: 20 });
    await check(request);
    expect(logCount("git")).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await check(request);
    expect(logCount("git")).toBe(2);
  });

  it("?refresh=1 bypasses the cache and refreshes it", async () => {
    makeLoggingStub("git", `echo "git version 2.43.0"`);
    makeLoggingStub(
      "opencode",
      `if [ "$1" = "--version" ]; then echo "1.18.34"; exit 0; fi
echo "github  ✓ authenticated"`,
    );

    const request = appFor({ cacheTtlMs: 60_000 });
    await check(request);
    await check(request, "?refresh=1");
    expect(logCount("git")).toBe(2);
    // The refreshed result re-populates the cache.
    await check(request);
    expect(logCount("git")).toBe(2);
  });
});
