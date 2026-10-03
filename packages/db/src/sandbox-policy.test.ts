import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Db } from "./index.js";

/**
 * Projects.sandbox_policy persistence (#101): the JSON column round-trips
 * through the core schema on both write and read — invalid policies never
 * store, corrupted columns never load.
 */

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openeuler-policy-"));
  db = createDatabase({ path: join(dir, "test.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const project = () => ({
  id: crypto.randomUUID(),
  path: "/tmp/demo",
  name: "demo",
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
});

describe("project sandbox policy repo (#101)", () => {
  it("creates projects without a policy (column NULL, key absent)", () => {
    const created = db.projects.create(project());
    expect(created.sandboxPolicy).toBeUndefined();
    expect(db.projects.get(created.id)?.sandboxPolicy).toBeUndefined();
  });

  it("round-trips a saved policy through get/list/getMany", () => {
    const created = db.projects.create(project());
    const updated = db.projects.setSandboxPolicy(created.id, {
      executionMode: "sandbox",
      image: "openeuler/worker:latest",
      cpus: 4,
      memoryMb: 4096,
      network: "limited",
      cachePaths: ["/root/.cache"],
      keepForDebug: true,
    });
    expect(updated?.sandboxPolicy).toEqual({
      executionMode: "sandbox",
      image: "openeuler/worker:latest",
      cpus: 4,
      memoryMb: 4096,
      network: "limited",
      cachePaths: ["/root/.cache"],
      keepForDebug: true,
    });

    const loaded = db.projects.get(created.id);
    expect(loaded?.sandboxPolicy).toEqual(updated?.sandboxPolicy);
    expect(db.projects.list()[0]?.sandboxPolicy).toBeDefined();
    expect(db.projects.getMany([created.id])[0]?.sandboxPolicy).toBeDefined();
  });

  it("replaces the whole policy on a second set", () => {
    const created = db.projects.create(project());
    db.projects.setSandboxPolicy(created.id, {
      executionMode: "sandbox",
      image: "busybox:1.36",
      cpus: 8,
    });
    const second = db.projects.setSandboxPolicy(created.id, { executionMode: "local" });
    // Whole-policy replace: the first save's image/resources are gone.
    expect(second?.sandboxPolicy).toEqual({ executionMode: "local" });
  });

  it("returns undefined for an unknown project", () => {
    expect(db.projects.setSandboxPolicy("ghost", { executionMode: "auto" })).toBeUndefined();
  });

  it("validates on write: out-of-clamp policies refuse to store", () => {
    const created = db.projects.create(project());
    expect(() =>
      db.projects.setSandboxPolicy(created.id, { executionMode: "auto", cpus: 99 }),
    ).toThrow();
    expect(() =>
      db.projects.setSandboxPolicy(created.id, { executionMode: "auto", memoryMb: 8 }),
    ).toThrow();
    // Nothing was stored.
    expect(db.projects.get(created.id)?.sandboxPolicy).toBeUndefined();
  });

  it("validates on read: a corrupted column fails closed instead of leaking", () => {
    const created = db.projects.create(project());
    db.projects.setSandboxPolicy(created.id, { executionMode: "sandbox", cpus: 2 });
    db.sqlite
      .prepare("update projects set sandbox_policy = ? where id = ?")
      .run(JSON.stringify({ executionMode: "sandbox", cpus: 999 }), created.id);
    expect(() => db.projects.get(created.id)).toThrow();
  });
});
