import { describe, expect, it, vi } from "vitest";
import {
  fetchSystemSettings,
  formatBytes,
  formatUptime,
  maintenanceToast,
  runMaintenance,
  usagePercent,
  type SettingsFetcher,
  type SystemSettings,
} from "@/lib/settings";

const settings: SystemSettings = {
  version: "0.2.0",
  dbPath: "/data/openeuler.db",
  dbBytes: 2048,
  worktreeRoot: "/wt",
  worktreeBytes: null,
  drivers: [{ id: "fake" }, { id: "opencode" }],
  defaultDriver: "fake",
  maxConcurrentRuns: 2,
  authEnabled: false,
  uptimeSeconds: 61,
};

describe("fetchSystemSettings (#95)", () => {
  it("GETs /api/system/settings and returns the payload", async () => {
    const fetcher = vi.fn(async () => settings);
    await expect(fetchSystemSettings(fetcher as unknown as SettingsFetcher)).resolves.toEqual(
      settings,
    );
    expect(fetcher).toHaveBeenCalledWith("/api/system/settings");
  });

  it("appends ?refresh=1 when refresh is set", async () => {
    const paths: string[] = [];
    const fetcher = vi.fn(async (path: string) => {
      paths.push(path);
      return settings;
    });
    await fetchSystemSettings(fetcher as unknown as SettingsFetcher, { refresh: true });
    expect(paths).toEqual(["/api/system/settings?refresh=1"]);
  });
});

describe("runMaintenance (#95)", () => {
  it("POSTs the action as JSON", async () => {
    const bodies: Array<string | undefined> = [];
    const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? init.body : undefined);
      return { action: "vacuum", dbBytes: 1024 };
    });
    await expect(
      runMaintenance("vacuum", {}, fetcher as unknown as SettingsFetcher),
    ).resolves.toEqual({ action: "vacuum", dbBytes: 1024 });
    expect(bodies).toEqual([JSON.stringify({ action: "vacuum" })]);
  });

  it("includes days only for purge-events", async () => {
    const bodies: Array<unknown> = [];
    const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
      bodies.push(init?.body === undefined ? undefined : JSON.parse(init.body as string));
      return { action: "purge-events", deleted: 3, dbBytes: 10 };
    });
    const asFetcher = fetcher as unknown as SettingsFetcher;
    await runMaintenance("purge-events", { days: 7 }, asFetcher);
    await runMaintenance("prune-worktrees", { days: 7 }, asFetcher);
    expect(bodies).toEqual([{ action: "purge-events", days: 7 }, { action: "prune-worktrees" }]);
  });
});

describe("formatBytes", () => {
  it("formats across units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1_500_000)).toBe("1.4 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  it("returns — for null/undefined/invalid", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-5)).toBe("—");
  });
});

describe("formatUptime", () => {
  it("formats seconds, minutes, hours and days", () => {
    expect(formatUptime(42)).toBe("42s");
    expect(formatUptime(61)).toBe("1m 01s");
    expect(formatUptime(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(formatUptime(5 * 86_400 + 3 * 3600)).toBe("5d 3h");
  });

  it("returns — for invalid input", () => {
    expect(formatUptime(-1)).toBe("—");
    expect(formatUptime(Number.NaN)).toBe("—");
  });
});

describe("usagePercent", () => {
  it("clamps and rounds", () => {
    expect(usagePercent(25, 100)).toBe(25);
    expect(usagePercent(150, 100)).toBe(100);
    expect(usagePercent(null, 100)).toBe(0);
    expect(usagePercent(10, 0)).toBe(0);
  });
});

describe("maintenanceToast", () => {
  it("reports prune counts, including leftovers", () => {
    expect(maintenanceToast({ action: "prune-worktrees", removed: 2, remaining: 0 })).toEqual({
      title: "Worktrees pruned",
      description: "2 orphaned directories removed",
    });
    expect(maintenanceToast({ action: "prune-worktrees", removed: 1, remaining: 3 })).toEqual({
      title: "Worktrees pruned",
      description: "1 removed · 3 could not be removed",
    });
  });

  it("reports purge counts with the new db size", () => {
    expect(maintenanceToast({ action: "purge-events", deleted: 9, dbBytes: 2048 })).toEqual({
      title: "Event log purged",
      description: "9 events deleted · database now 2.0 KB",
    });
    expect(maintenanceToast({ action: "purge-events", deleted: 1, dbBytes: null })).toEqual({
      title: "Event log purged",
      description: "1 event deleted",
    });
  });

  it("reports the vacuumed size", () => {
    expect(maintenanceToast({ action: "vacuum", dbBytes: 4096 })).toEqual({
      title: "Database vacuumed",
      description: "Database is now 4.0 KB",
    });
  });
});
