import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import type { FileNode } from "@openeuler/core";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";

interface TreeResponseBody {
  entries: FileNode[];
}

interface FileContentResponseBody {
  content: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}

interface ErrorResponseBody {
  error: { code: string; message: string };
}

const PROJECT_ID = "proj-files-1";
const README = "# fixture\n";
const APP_LOG = "app log line\n";
const ZETA = "z\n";
const ALPHA = "export const alpha = 1;\n";
const BETA = "export const beta = 2;\n";
const SECRET = "hunter2\n";
const BIG_BYTES = 300 * 1024;
const BINARY_BLOB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x1a, 0x0a, 0x00, 0x01]);

const bytes = (text: string): number => Buffer.byteLength(text);

let workDir: string;
let root: string;
let outsideDir: string;
let db: Db;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openeuler-files-"));
  root = join(workDir, "repo");
  outsideDir = mkdtempSync(join(tmpdir(), "openeuler-files-outside-"));
  db = createDatabase({ path: join(workDir, "test.db") });
  mkdirSync(root, { recursive: true });

  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "blob.bin"), BINARY_BLOB);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "guide.md"), "# guide\n");
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  writeFileSync(join(root, "src", "alpha.ts"), ALPHA);
  writeFileSync(join(root, "src", "beta.ts"), BETA);
  writeFileSync(join(root, "src", "nested", "deep.ts"), "export const deep = true;\n");
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module\n");
  writeFileSync(join(root, "README.md"), README);
  writeFileSync(join(root, "app.log"), APP_LOG);
  writeFileSync(join(root, "zeta.txt"), ZETA);
  writeFileSync(join(root, "big.txt"), "a".repeat(BIG_BYTES));

  writeFileSync(join(outsideDir, "secret.txt"), SECRET);
  symlinkSync(outsideDir, join(root, "link-out"));
  symlinkSync(join(outsideDir, "secret.txt"), join(root, "secret-link.txt"));
  symlinkSync(join(root, "src"), join(root, "src-link"));

  db.projects.create({
    id: PROJECT_ID,
    path: root,
    name: "fixture",
    defaultBranch: "main",
    createdAt: "2026-09-30T09:00:00.000Z",
  });
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

const build = () => createApp({ db, logger: createLogger("silent") }).app;

const getTree = async (app: ReturnType<typeof build>, query = "") =>
  app.request(`/api/projects/${PROJECT_ID}/tree${query}`);

const tree = async (query = ""): Promise<TreeResponseBody> => {
  const res = await getTree(build(), query);
  expect(res.status).toBe(200);
  return (await res.json()) as TreeResponseBody;
};

const treeError = async (query: string): Promise<ErrorResponseBody> => {
  const res = await getTree(build(), query);
  expect(res.status).toBe(403);
  const body = (await res.json()) as ErrorResponseBody;
  expect(body.error.code).toBe("PATH_ESCAPE");
  return body;
};

const getFile = async (query: string): Promise<Response> =>
  build().request(`/api/projects/${PROJECT_ID}/file${query}`);

const fileError = async (
  query: string,
  status: number,
  code: string,
): Promise<ErrorResponseBody> => {
  const res = await getFile(query);
  expect(res.status).toBe(status);
  const body = (await res.json()) as ErrorResponseBody;
  expect(body.error.code).toBe(code);
  return body;
};

const node = (name: string, type: "file" | "dir", size: number): FileNode => ({ name, type, size });

describe("GET /api/projects/:id/tree", () => {
  it("lists one level with dirs first, then files, alphabetically", async () => {
    const body = await tree();
    expect(body.entries).toEqual([
      node("bin", "dir", 0),
      node("docs", "dir", 0),
      node("link-out", "dir", 0),
      node("src", "dir", 0),
      node("src-link", "dir", 0),
      node("README.md", "file", bytes(README)),
      node("app.log", "file", bytes(APP_LOG)),
      node("big.txt", "file", BIG_BYTES),
      node("secret-link.txt", "file", bytes(SECRET)),
      node("zeta.txt", "file", bytes(ZETA)),
    ]);
  });

  it("hides .git always and node_modules by default", async () => {
    const body = await tree();
    expect(body.entries.map((e) => e.name)).not.toContain(".git");
    expect(body.entries.map((e) => e.name)).not.toContain("node_modules");
  });

  it("includes node_modules with ?includeNodeModules=1 but still hides .git", async () => {
    const body = await tree("?includeNodeModules=1");
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(body.entries.find((e) => e.name === "node_modules")).toEqual(
      node("node_modules", "dir", 0),
    );
  });

  it("lists nested directories, staying one level deep", async () => {
    const body = await tree("?path=src");
    expect(body.entries).toEqual([
      node("nested", "dir", 0),
      node("alpha.ts", "file", bytes(ALPHA)),
      node("beta.ts", "file", bytes(BETA)),
    ]);
  });

  it("accepts '.', empty path, and trailing slashes for the root listing", async () => {
    const dot = await tree("?path=.");
    const empty = await tree("?path=");
    const slashed = await tree("?path=src/");
    expect(dot.entries).toEqual((await tree()).entries);
    expect(empty.entries).toEqual(dot.entries);
    expect(slashed.entries.map((e) => e.name)).toEqual(["nested", "alpha.ts", "beta.ts"]);
  });

  it("follows symlinks that stay inside the project root", async () => {
    const body = await tree("?path=src-link");
    expect(body.entries.map((e) => e.name)).toEqual(["nested", "alpha.ts", "beta.ts"]);
  });

  it("returns 422 when the path is a file", async () => {
    const res = await getTree(build(), "?path=src/alpha.ts");
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PATH_NOT_DIRECTORY");
  });

  it("returns 404 for a missing path", async () => {
    const res = await getTree(build(), "?path=nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PATH_NOT_FOUND");
  });

  it("returns 404 for an unknown project id", async () => {
    const res = await build().request("/api/projects/unknown/tree");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("GET /api/projects/:id/file", () => {
  it("returns exact text content with size and no flags", async () => {
    const res = await getFile("?path=src/alpha.ts");
    expect(res.status).toBe(200);
    expect((await res.json()) as FileContentResponseBody).toEqual({
      content: ALPHA,
      truncated: false,
      binary: false,
      size: bytes(ALPHA),
    });
  });

  it("truncates content beyond the 256KB cap and reports the true size", async () => {
    const res = await getFile("?path=big.txt");
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileContentResponseBody;
    expect(body.size).toBe(BIG_BYTES);
    expect(body.truncated).toBe(true);
    expect(body.binary).toBe(false);
    expect(body.content.length).toBe(256 * 1024);
    expect(body.content).toBe("a".repeat(256 * 1024));
  });

  it("does not truncate a file at exactly the cap", async () => {
    writeFileSync(join(root, "exact.txt"), "b".repeat(256 * 1024));
    const res = await getFile("?path=exact.txt");
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileContentResponseBody;
    expect(body).toMatchObject({ truncated: false, binary: false, size: 256 * 1024 });
  });

  it("detects binary files by sniffing null bytes and returns no content", async () => {
    const res = await getFile("?path=bin/blob.bin");
    expect(res.status).toBe(200);
    expect((await res.json()) as FileContentResponseBody).toEqual({
      content: "",
      truncated: false,
      binary: true,
      size: BINARY_BLOB.length,
    });
  });

  it("returns an empty (but non-binary) payload for an empty file", async () => {
    writeFileSync(join(root, "empty.txt"), "");
    const res = await getFile("?path=empty.txt");
    expect(res.status).toBe(200);
    expect((await res.json()) as FileContentResponseBody).toEqual({
      content: "",
      truncated: false,
      binary: false,
      size: 0,
    });
  });

  it("returns 404 for a missing file", async () => {
    await fileError("?path=missing.txt", 404, "PATH_NOT_FOUND");
  });

  it("returns 422 when the path is a directory", async () => {
    await fileError("?path=src", 422, "PATH_NOT_FILE");
  });

  it("rejects an empty or missing path with 422", async () => {
    await fileError("", 422, "VALIDATION_ERROR");
    await fileError("?path=", 422, "VALIDATION_ERROR");
  });

  it("rejects paths containing null bytes", async () => {
    await fileError("?path=src/alph%00a.ts", 422, "INVALID_PATH");
  });

  it("returns 404 for an unknown project id", async () => {
    const res = await build().request("/api/projects/unknown/file?path=README.md");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("path traversal is rejected with 403 PATH_ESCAPE", () => {
  const TRAVERSALS = [
    "?path=../../etc/passwd",
    "?path=..",
    "?path=/etc/passwd",
    "?path=..%2f..%2fetc%2fpasswd",
    "?path=%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "?path=%2Fetc%2Fpasswd",
  ];

  for (const query of TRAVERSALS) {
    it(`tree rejects ${query}`, async () => {
      await treeError(query);
    });
  }

  it("file rejects ../../etc/passwd", async () => {
    const res = await getFile("?path=../../etc/passwd");
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PATH_ESCAPE");
  });

  it("file rejects an absolute path outside the root", async () => {
    const res = await getFile("?path=/etc/passwd");
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PATH_ESCAPE");
  });

  it("file rejects URL-encoded traversal", async () => {
    const res = await getFile("?path=..%2f..%2fetc%2fpasswd");
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PATH_ESCAPE");
  });

  it("tree rejects a symlink pointing outside the root", async () => {
    await treeError("?path=link-out");
  });

  it("file rejects a file reached through an escaping directory symlink", async () => {
    const res = await getFile("?path=link-out/secret.txt");
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PATH_ESCAPE");
  });

  it("file rejects a symlinked file outside the root", async () => {
    const res = await getFile("?path=secret-link.txt");
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorResponseBody).error.code).toBe("PATH_ESCAPE");
  });
});
