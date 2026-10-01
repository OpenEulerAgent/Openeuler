import { describe, expect, it, vi } from "vitest";
import {
  environmentBlocksContinue,
  fetchSystemCheck,
  systemCheckRows,
  type SystemCheck,
  type SystemCheckFetcher,
} from "@/lib/system-check";

const healthy: SystemCheck = {
  git: { ok: true, version: "2.43.0" },
  opencode: { ok: true, version: "1.18.34", authenticated: true },
  worktrees: { ok: true, path: "/home/dev/.openeuler/worktrees" },
};

describe("systemCheckRows", () => {
  it("renders three green rows for a healthy environment", () => {
    const rows = systemCheckRows(healthy);
    expect(rows.map((row) => row.id)).toEqual(["git", "opencode", "worktrees"]);
    expect(rows.every((row) => row.status === "ok")).toBe(true);
    expect(rows[0]?.detail).toBe("git 2.43.0");
    expect(rows[1]?.detail).toBe("opencode 1.18.34 · authenticated");
    expect(rows[2]?.detail).toContain("/home/dev/.openeuler/worktrees");
  });

  it("missing git is an error row with the daemon hint", () => {
    const rows = systemCheckRows({ ...healthy, git: { ok: false, hint: "install git" } });
    const git = rows[0];
    expect(git).toMatchObject({ id: "git", status: "error" });
    expect(git?.hint).toBe("install git");
  });

  it("missing opencode is a warning mentioning the fake driver", () => {
    const rows = systemCheckRows({
      ...healthy,
      opencode: {
        ok: false,
        hint: "install the opencode CLI from https://opencode.ai/docs/install",
      },
    });
    const opencode = rows[1];
    expect(opencode?.status).toBe("warn");
    expect(opencode?.hint).toMatch(/opencode\.ai\/docs\/install/);
  });

  it("unauthenticated opencode warns with the exact login command", () => {
    const rows = systemCheckRows({
      ...healthy,
      opencode: {
        ok: true,
        version: "1.18.34",
        authenticated: false,
        hint: "Run: opencode auth login",
      },
    });
    const opencode = rows[1];
    expect(opencode?.status).toBe("warn");
    expect(opencode?.detail).toContain("not authenticated");
    expect(opencode?.hint).toBe("Run: opencode auth login");
  });

  it("an unwritable worktree store is an error row", () => {
    const rows = systemCheckRows({ ...healthy, worktrees: { ok: false, path: "/nope" } });
    expect(rows[2]).toMatchObject({ id: "worktrees", status: "error" });
    expect(rows[2]?.detail).toContain("/nope");
  });
});

describe("environmentBlocksContinue", () => {
  it("only git and worktrees block; opencode problems never do", () => {
    expect(environmentBlocksContinue(healthy)).toBe(false);
    expect(environmentBlocksContinue({ ...healthy, opencode: { ok: false, hint: "x" } })).toBe(
      false,
    );
    expect(environmentBlocksContinue({ ...healthy, git: { ok: false } })).toBe(true);
    expect(environmentBlocksContinue({ ...healthy, worktrees: { ok: false, path: null } })).toBe(
      true,
    );
  });
});

describe("fetchSystemCheck", () => {
  it("GETs /api/system/check (refresh appends the bypass query)", async () => {
    const paths: string[] = [];
    const fetcher = vi.fn(async (path: string) => {
      paths.push(path);
      return healthy;
    });

    await fetchSystemCheck(fetcher as unknown as SystemCheckFetcher);
    await fetchSystemCheck(fetcher as unknown as SystemCheckFetcher, { refresh: true });
    expect(paths).toEqual(["/api/system/check", "/api/system/check?refresh=1"]);
  });
});
