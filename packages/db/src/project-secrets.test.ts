import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@openeuler/core";
import { createDatabase } from "./index.js";
import type { Db } from "./index.js";

const uuid = (): string => crypto.randomUUID();
const iso = (): string => new Date().toISOString();

const makeProject = (over: Partial<Project> = {}): Project => ({
  id: uuid(),
  path: "/srv/repos/demo",
  name: "demo",
  defaultBranch: "main",
  createdAt: iso(),
  ...over,
});

let dir: string;
let db: Db;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openeuler-secrets-"));
  db = createDatabase({ path: join(dir, "test.db") });
  project = db.projects.create(makeProject());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("projectSecrets repo", () => {
  it("set → listNames shows the name (and never a value column)", () => {
    db.projectSecrets.set(project.id, "NPM_TOKEN", "v1:enc:abc:def");
    const names = db.projectSecrets.listNames(project.id);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatchObject({ name: "NPM_TOKEN", createdAt: expect.any(String) });
  });

  it("set twice upserts: one row, value replaced, createdAt preserved", () => {
    const first = db.projectSecrets.set(project.id, "API_KEY", "v1:enc:one:one");
    const second = db.projectSecrets.set(project.id, "API_KEY", "v1:enc:two:two");
    expect(db.projectSecrets.listNames(project.id)).toHaveLength(1);
    expect(second.createdAt).toBe(first.createdAt);
    expect(db.projectSecrets.get(project.id, "API_KEY")?.valueEnc).toBe("v1:enc:two:two");
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.updatedAt).getTime(),
    );
  });

  it("names are unique per project but shared across projects", () => {
    const other = db.projects.create(makeProject({ id: uuid(), name: "other" }));
    db.projectSecrets.set(project.id, "API_KEY", "v1:a:a:a");
    db.projectSecrets.set(other.id, "API_KEY", "v1:b:b:b");
    expect(db.projectSecrets.list(project.id)).toHaveLength(1);
    expect(db.projectSecrets.list(other.id)).toHaveLength(1);
    expect(db.projectSecrets.get(project.id, "API_KEY")?.valueEnc).toBe("v1:a:a:a");
    expect(db.projectSecrets.get(other.id, "API_KEY")?.valueEnc).toBe("v1:b:b:b");
  });

  it("listNames orders by name", () => {
    db.projectSecrets.set(project.id, "ZULU", "v1:z:z:z");
    db.projectSecrets.set(project.id, "ALPHA", "v1:a:a:a");
    expect(db.projectSecrets.listNames(project.id).map((s) => s.name)).toEqual(["ALPHA", "ZULU"]);
  });

  it("delete removes exactly the named secret of that project", () => {
    const other = db.projects.create(makeProject({ id: uuid(), name: "other" }));
    db.projectSecrets.set(project.id, "NPM_TOKEN", "v1:a:a:a");
    db.projectSecrets.set(other.id, "NPM_TOKEN", "v1:b:b:b");
    expect(db.projectSecrets.delete(project.id, "NPM_TOKEN")).toBe(true);
    expect(db.projectSecrets.get(project.id, "NPM_TOKEN")).toBeUndefined();
    expect(db.projectSecrets.listNames(project.id)).toHaveLength(0);
    // The other project's secret survives.
    expect(db.projectSecrets.get(other.id, "NPM_TOKEN")).toBeDefined();
    expect(db.projectSecrets.delete(project.id, "NPM_TOKEN")).toBe(false);
    expect(db.projectSecrets.delete(project.id, "NOPE")).toBe(false);
  });

  it("deleteAllForProject clears the project's secrets only", () => {
    const other = db.projects.create(makeProject({ id: uuid(), name: "other" }));
    db.projectSecrets.set(project.id, "A", "v1:a:a:a");
    db.projectSecrets.set(project.id, "B", "v1:b:b:b");
    db.projectSecrets.set(other.id, "A", "v1:c:c:c");
    expect(db.projectSecrets.deleteAllForProject(project.id)).toBe(2);
    expect(db.projectSecrets.listNames(project.id)).toHaveLength(0);
    expect(db.projectSecrets.listNames(other.id)).toHaveLength(1);
  });
});
