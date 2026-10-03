import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";

/**
 * Per-project secrets API (#93): names-only listing, write-only values,
 * upsert/delete semantics, name validation, and auth coverage in token
 * mode. The raw value must never appear in any response body.
 */

interface ErrorResponseBody {
  error: { code: string; message: string };
}

const SECRET_VALUE = "npat_rt_alpha_bravo_334455";

let workDir: string;
let db: Db;
let key: Buffer;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openeuler-secrets-api-"));
  db = createDatabase({ path: join(workDir, "test.db") });
  key = crypto.getRandomValues(new Uint8Array(32)) as Buffer;
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

const makeRepo = (name: string): string => {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git("init", "-b", "main");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git("add", "-A");
  git("-c", "user.email=test@openeuler.dev", "-c", "user.name=Test", "commit", "-m", "init");
  return dir;
};

const build = (options: { authToken?: string } = {}) =>
  createApp({
    db,
    logger: createLogger("silent"),
    secretsKey: key,
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
  }).app;

const registerProject = async (
  app: ReturnType<typeof build>,
  name = "demo",
  headers: Record<string, string> = {},
): Promise<string> => {
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ path: makeRepo(name) }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { project: { id: string } }).project.id;
};

const putSecret = (app: ReturnType<typeof build>, projectId: string, body: unknown) =>
  app.request(`/api/projects/${projectId}/secrets`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /api/projects/:id/secrets", () => {
  it("lists names + createdAt only — values never appear", async () => {
    const app = build();
    const projectId = await registerProject(app);
    const put = await putSecret(app, projectId, { name: "NPM_TOKEN", value: SECRET_VALUE });
    expect(put.status).toBe(201);

    const res = await app.request(`/api/projects/${projectId}/secrets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      secrets: Array<{ name: string; createdAt: string }>;
    };
    expect(body.secrets).toHaveLength(1);
    expect(body.secrets[0]).toMatchObject({ name: "NPM_TOKEN", createdAt: expect.any(String) });
    expect(Object.keys(body.secrets[0] as object).sort()).toEqual(["createdAt", "name"]);
    expect(JSON.stringify(body)).not.toContain(SECRET_VALUE);
  });

  it("orders by name and 404s for unknown projects", async () => {
    const app = build();
    const projectId = await registerProject(app);
    await putSecret(app, projectId, { name: "ZULU", value: "zulu-value-1" });
    await putSecret(app, projectId, { name: "ALPHA", value: "alpha-value-1" });
    const res = await app.request(`/api/projects/${projectId}/secrets`);
    const body = (await res.json()) as { secrets: Array<{ name: string }> };
    expect(body.secrets.map((s) => s.name)).toEqual(["ALPHA", "ZULU"]);

    expect((await app.request(`/api/projects/${crypto.randomUUID()}/secrets`)).status).toBe(404);
  });
});

describe("PUT /api/projects/:id/secrets", () => {
  it("creates (201) then rotates in place (200, same name, one row)", async () => {
    const app = build();
    const projectId = await registerProject(app);
    const created = await putSecret(app, projectId, { name: "API_KEY", value: "first-value-1" });
    expect(created.status).toBe(201);
    const createdAt = ((await created.json()) as { secret: { createdAt: string } }).secret
      .createdAt;

    const updated = await putSecret(app, projectId, { name: "API_KEY", value: "second-value-2" });
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as { secret: { name: string } };
    expect(body.secret.name).toBe("API_KEY");

    const list = await app.request(`/api/projects/${projectId}/secrets`);
    const names = ((await list.json()) as { secrets: unknown[] }).secrets;
    expect(names).toHaveLength(1);
    expect((names[0] as { createdAt: string }).createdAt).toBe(createdAt);

    // The stored ciphertext actually changed.
    expect(db.projectSecrets.get(projectId, "API_KEY")?.valueEnc).not.toContain("first-value-1");
  });

  it("stores only ciphertext — the raw value is nowhere in the db file page", async () => {
    const app = build();
    const projectId = await registerProject(app);
    await putSecret(app, projectId, { name: "NPM_TOKEN", value: SECRET_VALUE });
    const stored = db.projectSecrets.get(projectId, "NPM_TOKEN");
    expect(stored?.valueEnc).toMatch(/^v1:/);
    expect(stored?.valueEnc).not.toContain(SECRET_VALUE);
  });

  it.each([
    ["lowercase", "npm_token"],
    ["leading digit", "1_TOKEN"],
    ["dash", "MY-TOKEN"],
    ["empty", ""],
    ["too long", "X".repeat(65)],
    ["missing", undefined],
  ])("rejects name %s with 422", async (_label, name) => {
    const app = build();
    const projectId = await registerProject(app);
    const body: Record<string, string> = { value: "some-value-1" };
    if (name !== undefined) body["name"] = name;
    const res = await putSecret(app, projectId, body);
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty value and unknown keys (strict body)", async () => {
    const app = build();
    const projectId = await registerProject(app);
    expect((await putSecret(app, projectId, { name: "OK_NAME", value: "" })).status).toBe(422);
    expect(
      (await putSecret(app, projectId, { name: "OK_NAME", value: "v", projectId: "x" })).status,
    ).toBe(422);
  });

  it("404s for an unknown project", async () => {
    const app = build();
    expect(
      (await putSecret(app, crypto.randomUUID(), { name: "NPM_TOKEN", value: "v-123456" })).status,
    ).toBe(404);
  });

  it("503s with SECRETS_UNAVAILABLE when the daemon has no key configured", async () => {
    const app = createApp({ db, logger: createLogger("silent") }).app;
    const projectId = await registerProject(app);
    const res = await putSecret(app, projectId, { name: "NPM_TOKEN", value: "v-123456" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("SECRETS_UNAVAILABLE");
  });
});

describe("DELETE /api/projects/:id/secrets/:name", () => {
  it("removes the secret, then 404s", async () => {
    const app = build();
    const projectId = await registerProject(app);
    await putSecret(app, projectId, { name: "NPM_TOKEN", value: SECRET_VALUE });
    const gone = await app.request(`/api/projects/${projectId}/secrets/NPM_TOKEN`, {
      method: "DELETE",
    });
    expect(gone.status).toBe(204);
    expect((await app.request(`/api/projects/${projectId}/secrets`)).json()).resolves.toMatchObject(
      { secrets: [] },
    );
    expect(
      (await app.request(`/api/projects/${projectId}/secrets/NPM_TOKEN`, { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect(
      (
        (await (
          await app.request(`/api/projects/${projectId}/secrets/NPM_TOKEN`, { method: "DELETE" })
        ).json()) as ErrorResponseBody
      ).error.code,
    ).toBe("SECRET_NOT_FOUND");
  });

  it("keeps other projects' secrets of the same name", async () => {
    const app = build();
    const first = await registerProject(app, "one");
    const second = await registerProject(app, "two");
    await putSecret(app, first, { name: "SHARED", value: "value-one-1" });
    await putSecret(app, second, { name: "SHARED", value: "value-two-2" });
    expect(
      (await app.request(`/api/projects/${first}/secrets/SHARED`, { method: "DELETE" })).status,
    ).toBe(204);
    const remaining = (
      (await (await app.request(`/api/projects/${second}/secrets`)).json()) as {
        secrets: unknown[];
      }
    ).secrets;
    expect(remaining).toHaveLength(1);
  });
});

describe("secrets under token auth (#92)", () => {
  it("requires the bearer token like every other /api route", async () => {
    const token = "s3cret-bearer-93";
    const auth = { Authorization: `Bearer ${token}` };
    const app = build({ authToken: token });
    const projectId = await registerProject(app, "demo", auth);

    const unauthorized = await app.request(`/api/projects/${projectId}/secrets`);
    expect(unauthorized.status).toBe(401);

    const authorized = await app.request(`/api/projects/${projectId}/secrets`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(authorized.status).toBe(200);

    const rejectedPut = await app.request(`/api/projects/${projectId}/secrets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify({ name: "NPM_TOKEN", value: "v" }),
    });
    expect(rejectedPut.status).toBe(401);
  });
});
