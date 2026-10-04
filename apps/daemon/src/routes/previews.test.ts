import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Run } from "@openeuler/core";
import type { Db } from "@openeuler/db";
import { createDatabase } from "@openeuler/db";
import { createApp } from "../app.js";
import type { Executor, RunPortView, RunSandboxInfo } from "../executor.js";
import { UNDECLARED_PORT_HINT } from "../executor.js";
import {
  createPreviewProxy,
  forwardableHeaders,
  forwardableSearch,
  parsePreviewPath,
  resolvePreviewTarget,
} from "../preview-proxy.js";
import { createLogger } from "../logger.js";

/**
 * #108 local preview-proxy tests: resolution matrix (404/403/410/422/502),
 * method/header/body passthrough against a real local HTTP target,
 * hop-by-hop stripping, CRLF smuggling, auth, frame headers, load, and the
 * timeout path. The real-sandbox round-trip (busybox httpd) lives in
 * `previews.integration.test.ts`.
 */

interface EchoHit {
  method: string;
  /** Raw request-target exactly as the target server received it. */
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface Harness {
  dir: string;
  db: Db;
  /** Id of the harness project runs live under. */
  projectId: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  hits: EchoHit[];
  targetPort: number;
  setSandbox: (runId: string, ports: RunPortView[] | undefined) => void;
}

interface TargetServer {
  server: Server;
  port: number;
  hits: EchoHit[];
}

/** Local echo target: records raw requests, answers with an echo payload. */
const startEchoTarget = async (): Promise<TargetServer> => {
  const hits: EchoHit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({
        method: req.method ?? "?",
        url: req.url ?? "/",
        headers: req.headers as Record<string, string>,
        body,
      });
      res.statusCode = 200;
      // Hop-by-hop + multi-value set-cookie on the way back, so the strip
      // is asserted in both directions.
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close");
      res.setHeader("x-echo", "yes");
      res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port, hits };
};

/** A TCP server that accepts connections but never answers (timeout path). */
const startSilentTarget = async (): Promise<TargetServer> => {
  const hits: EchoHit[] = [];
  const server = createServer(() => {
    // Intentionally never responds.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port, hits };
};

/** A port that is guaranteed free (bind to :0, read it, release it). */
const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

const stubExecutor = (sandboxFor: (runId: string) => RunSandboxInfo | undefined): Executor => ({
  startRun: () => {},
  abortRun: async () => ({ outcome: "not_found" }),
  activeRunIds: () => [],
  onRunStatus: () => () => {},
  sandboxInfo: async (runId) => sandboxFor(runId),
  stopHosting: async () => ({ outcome: "not_hosted" }),
  extendHosting: async () => ({ outcome: "not_hosted" }),
  resolveApproval: () => ({ outcome: "not_awaiting" }),
  maxConcurrentRuns: 1,
  shutdown: async () => {},
});

const created: Array<{ dir: string; db: Db }> = [];
const targets: Server[] = [];

/** Creates a run row (the caller passes its harness's project id). */
const makeRun = (db: Db, projectId: string, overrides: Partial<Run> = {}): Run => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const run: Run = {
    id,
    projectId,
    status: "running",
    branch: `agentloop/${id}`,
    iteration: 0,
    task: "serve",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  db.runs.create(run);
  return run;
};

const setup = async (options: { authToken?: string; proxy?: boolean } = {}): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), "openeuler-previews-"));
  const db = createDatabase({ path: join(dir, "test.db") });
  const projectId = crypto.randomUUID();
  db.projects.create({
    id: projectId,
    path: join(dir, "repo"),
    name: "repo",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  created.push({ dir, db });

  const target = await startEchoTarget();
  targets.push(target.server);
  const sandboxes = new Map<string, RunSandboxInfo>();
  const executor = stubExecutor((runId) => sandboxes.get(runId));

  const built = createApp({
    db,
    logger: createLogger("silent"),
    executor,
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
    ...(options.proxy === undefined
      ? {}
      : {
          previews: {
            proxy: createPreviewProxy({ connectTimeoutMs: 300, overallTimeoutMs: 2_000 }),
          },
        }),
  });

  const h: Harness = {
    dir,
    db,
    projectId,
    hits: target.hits,
    targetPort: target.port,
    request: (path, init) => Promise.resolve(built.app.request(path, init)),
    setSandbox: (runId, ports) => {
      // undefined = "no live sandbox" (terminal/local run); a ports array
      // (possibly empty) = a live sandbox with those port views.
      if (ports === undefined) {
        sandboxes.delete(runId);
        return;
      }
      sandboxes.set(runId, {
        id: `docker-${runId}`,
        image: "busybox:1.36",
        status: "running",
        ports,
      });
    },
  };
  return h;
};

afterEach(async () => {
  await Promise.all(
    targets.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  while (created.length > 0) {
    const { dir, db } = created.pop() as { dir: string; db: Db };
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- pure units

describe("parsePreviewPath (#108)", () => {
  it("splits both mounts into runId / explicit port / encoded subpath", () => {
    expect(parsePreviewPath("/previews/r1")).toEqual({ runId: "r1", subPath: "" });
    expect(parsePreviewPath("/previews/r1/")).toEqual({ runId: "r1", subPath: "" });
    expect(parsePreviewPath("/previews/r1/3000")).toEqual({
      runId: "r1",
      explicitPort: "3000",
      subPath: "",
    });
    expect(parsePreviewPath("/previews/r1/3000/app/x.js")).toEqual({
      runId: "r1",
      explicitPort: "3000",
      subPath: "app/x.js",
    });
    expect(parsePreviewPath("/api/previews/r1/3000/app")).toEqual({
      runId: "r1",
      explicitPort: "3000",
      subPath: "app",
    });
    // Non-numeric first segment = subpath (default-port convention), and
    // subpaths stay percent-encoded (smuggling safety).
    expect(parsePreviewPath("/previews/r1/a%0d%0ab")).toEqual({
      runId: "r1",
      subPath: "a%0d%0ab",
    });
    expect(parsePreviewPath("/previews/r1/abc/3000")).toEqual({
      runId: "r1",
      subPath: "abc/3000",
    });
    expect(parsePreviewPath("/previews/r1/%2Fetc")).toEqual({ runId: "r1", subPath: "%2Fetc" });
  });

  it("marks undecodable run ids malformed and foreign paths undefined", () => {
    expect(parsePreviewPath("/previews/%zz")).toBe("malformed");
    expect(parsePreviewPath("/api/previews/%zz/x")).toBe("malformed");
    expect(parsePreviewPath("/metrics")).toBeUndefined();
    expect(parsePreviewPath("/api/runs")).toBeUndefined();
  });
});

describe("forwardableSearch (#108)", () => {
  it("passes through untouched queries and strips the proxy's own params", () => {
    expect(forwardableSearch("")).toBe("");
    expect(forwardableSearch("?a=1&b=2")).toBe("?a=1&b=2");
    expect(forwardableSearch("?a=1&port=3000&b=2")).toBe("?a=1&b=2");
    expect(forwardableSearch("?port=3000&token=secret")).toBe("");
    expect(forwardableSearch("?token=secret&a=%20x")).toBe("?a=%20x");
  });

  it("strips percent-encoded spellings of token/port (no token reaches the sandbox)", () => {
    expect(forwardableSearch("?%74oken=secret&b=2")).toBe("?b=2");
    expect(forwardableSearch("?%50ORT=3000&x=1")).toBe("?x=1");
    expect(forwardableSearch("?%74%6F%6B%65%6E=secret")).toBe("");
  });
});

describe("forwardableHeaders (#108)", () => {
  it("strips hop-by-hop both ways, host on requests, and Connection-named extras", () => {
    const req = new Headers({
      host: "evil:9",
      connection: "keep-alive, x-drop-me",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      upgrade: "websocket",
      te: "trailers",
      trailer: "x-t",
      "x-drop-me": "gone",
      "x-keep": "yes",
    });
    const forwarded = forwardableHeaders(req, "request");
    expect(forwarded.get("x-keep")).toBe("yes");
    for (const name of [
      "host",
      "connection",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
      "te",
      "trailer",
      "x-drop-me",
    ]) {
      expect(forwarded.get(name)).toBeNull();
    }

    const res = new Headers({ connection: "close", "x-a": "1" });
    expect(forwardableHeaders(res, "response").get("connection")).toBeNull();
  });

  it("keeps multi-value set-cookie intact", () => {
    const res = new Headers();
    res.append("set-cookie", "a=1");
    res.append("set-cookie", "b=2");
    expect(forwardableHeaders(res, "response").getSetCookie()).toEqual(["a=1", "b=2"]);
  });
});

describe("resolvePreviewTarget (#108)", () => {
  const base: Run = {
    id: "r1",
    projectId: "p1",
    status: "running",
    branch: "b",
    iteration: 0,
    task: "t",
    createdAt: "",
    updatedAt: "",
  };
  const sandbox = (ports: RunPortView[]): RunSandboxInfo => ({
    id: "sbx",
    image: "img",
    status: "running",
    ports,
  });

  it("maps the resolution matrix", () => {
    expect(resolvePreviewTarget(undefined, undefined, undefined)).toEqual({
      outcome: "run_not_found",
    });
    expect(resolvePreviewTarget({ ...base, status: "success" }, undefined, 3000)).toMatchObject({
      outcome: "gone",
      terminal: true,
    });
    expect(resolvePreviewTarget({ ...base, status: "running" }, undefined, 3000)).toMatchObject({
      outcome: "gone",
      terminal: false,
    });
    expect(resolvePreviewTarget({ ...base, ports: [3000] }, sandbox([]), "abc")).toEqual({
      outcome: "invalid_port",
      raw: "abc",
    });
    expect(resolvePreviewTarget({ ...base, ports: [3000] }, sandbox([]), 99999)).toEqual({
      outcome: "invalid_port",
      raw: "99999",
    });
    expect(resolvePreviewTarget({ ...base, ports: [3000] }, sandbox([]), 5000)).toEqual({
      outcome: "not_declared",
      containerPort: 5000,
    });
    expect(
      resolvePreviewTarget({ ...base, detectedPorts: [5173] }, sandbox([]), undefined),
    ).toEqual({ outcome: "no_ports", detected: [5173] });
    expect(
      resolvePreviewTarget(
        { ...base, ports: [3000] },
        sandbox([{ container: 3000, declared: true }]),
        3000,
      ),
    ).toEqual({ outcome: "unmapped", containerPort: 3000 });
    expect(
      resolvePreviewTarget(
        { ...base, ports: [3000, 8080] },
        sandbox([
          { container: 3000, host: 49153, declared: true },
          { container: 8080, host: 49154, declared: true },
        ]),
        undefined,
      ),
    ).toEqual({ outcome: "ok", containerPort: 3000, hostPort: 49153 });
  });
});

// ------------------------------------------------------------ proxy routing

describe("GET/POST /previews/:runId round-trip (#108)", () => {
  let h: Harness;
  let run: Run;

  beforeEach(async () => {
    h = await setup();
    run = makeRun(h.db, h.projectId, { ports: [3000] });
    h.setSandbox(run.id, [{ container: 3000, host: h.targetPort, declared: true }]);
  });

  it("streams a GET through to the sandbox's host port and back", async () => {
    const res = await h.request(`/previews/${run.id}?port=3000`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { method: string; url: string };
    expect(body.method).toBe("GET");
    expect(body.url).toBe("/");
    expect(h.hits.length).toBe(1);
    const hit = h.hits[0]!;
    expect(hit.method).toBe("GET");
    expect(hit.url).toBe("/"); // ?port= and ?token= never reach the target
    expect(hit.headers["host"]).toBe(`127.0.0.1:${h.targetPort}`);
  });

  it("defaults to the first declared port and resolves relative subpaths", async () => {
    const res = await h.request(`/previews/${run.id}/index.html`);
    expect(res.status).toBe(200);
    expect(h.hits[0]?.url).toBe("/index.html");
  });

  it("treats an explicitly empty ?port= as absent (default port)", async () => {
    const res = await h.request(`/previews/${run.id}?port=`);
    expect(res.status).toBe(200);
    expect(h.hits[0]?.url).toBe("/");
  });

  it("path-form port wins over ?port= (both mounts)", async () => {
    const run2 = makeRun(h.db, h.projectId, { ports: [3000, 8080] });
    h.setSandbox(run2.id, [
      { container: 3000, host: h.targetPort, declared: true },
      { container: 8080, host: h.targetPort, declared: true },
    ]);
    const res = await h.request(`/previews/${run2.id}/8080/x?port=3000`);
    expect(res.status).toBe(200);
    expect(h.hits[0]?.url).toBe("/x"); // 8080 won (path form); ?port= was consumed
  });

  it("passes methods and streamed bodies through (POST/PUT/PATCH/DELETE)", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await h.request(`/previews/${run.id}/3000/echo`, {
        method,
        headers: { "content-type": "text/plain" },
        body: `payload-${method}`,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { method: string; body: string };
      expect(body.method).toBe(method);
      expect(body.body).toBe(`payload-${method}`);
    }
    expect(h.hits.map((hit) => hit.method)).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
    expect(h.hits.every((hit) => hit.headers["content-type"] === "text/plain")).toBe(true);
  });

  it("keeps HEAD responses bodyless with headers intact", async () => {
    const res = await h.request(`/previews/${run.id}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-echo")).toBe("yes");
    expect(await res.text()).toBe("");
  });

  it("answers on the /api/previews alias identically", async () => {
    const res = await h.request(`/api/previews/${run.id}?port=3000`);
    expect(res.status).toBe(200);
    expect(h.hits[0]?.url).toBe("/");
  });

  it("forwards arbitrary query params but never token/port", async () => {
    const res = await h.request(`/previews/${run.id}?port=3000&a=1&b=%20x`);
    expect(res.status).toBe(200);
    expect(h.hits[0]?.url).toBe("/?a=1&b=%20x");
  });

  it("passes upstream statuses and error bodies through untouched", async () => {
    // Echo server always 200s; drive a 404 through a fresh stub app.
    const dir = mkdtempSync(join(tmpdir(), "openeuler-previews-404-"));
    const db = createDatabase({ path: join(dir, "test.db") });
    const projectId = crypto.randomUUID();
    db.projects.create({
      id: projectId,
      path: join(dir, "repo"),
      name: "repo",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    created.push({ dir, db });
    const target = createServer((req, res) => {
      res.statusCode = 404;
      res.setHeader("content-type", "text/html");
      res.end("<h1>not found</h1>");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    targets.push(target);
    const port = (target.address() as { port: number }).port;
    const run404 = makeRun(db, projectId, { ports: [3000] });
    const built = createApp({
      db,
      logger: createLogger("silent"),
      executor: stubExecutor((runId) =>
        runId === run404.id
          ? {
              id: "sbx",
              image: "i",
              status: "running",
              ports: [{ container: 3000, host: port, declared: true }],
            }
          : undefined,
      ),
    });
    const res = await Promise.resolve(built.app.request(`/previews/${run404.id}`));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toBe("<h1>not found</h1>");
  });
});

describe("hop-by-hop + smuggling (#108)", () => {
  let h: Harness;
  let run: Run;

  beforeEach(async () => {
    h = await setup();
    run = makeRun(h.db, h.projectId, { ports: [3000] });
    h.setSandbox(run.id, [{ container: 3000, host: h.targetPort, declared: true }]);
  });

  it("strips hop-by-hop headers in both directions and keeps the rest", async () => {
    const res = await h.request(`/previews/${run.id}`, {
      headers: {
        connection: "keep-alive, x-drop-me",
        "keep-alive": "timeout=5",
        upgrade: "websocket",
        te: "trailers",
        trailer: "x-t",
        "x-drop-me": "gone",
        "x-custom": "kept",
      },
    });
    expect(res.status).toBe(200);
    const sent = h.hits[0]!.headers;
    expect(sent["x-custom"]).toBe("kept");
    // The client's hop-by-hop headers never reach the target. (`connection`
    // may appear as undici's own transport-level "keep-alive" — that is the
    // proxy hop's semantics, not the client's header — but its tokens must
    // not leak, and no other hop-by-hop name may appear.)
    expect(String(sent["connection"] ?? "")).not.toContain("x-drop-me");
    expect(String(sent["connection"] ?? "")).not.toContain("upgrade");
    for (const name of ["keep-alive", "upgrade", "te", "trailer", "x-drop-me"]) {
      expect(sent[name]).toBeUndefined();
    }
    expect(sent["host"]).toBe(`127.0.0.1:${h.targetPort}`);
    // Response direction: connection dropped, echo + cookies preserved.
    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("x-echo")).toBe("yes");
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("rejects CRLF path smuggling: %0d%0a stays encoded on the target's request line", async () => {
    const res = await h.request(`/previews/${run.id}/a%0d%0aX-Evil:%201`);
    expect(res.status).toBe(200);
    const rawUrl = h.hits[0]!.url;
    expect(rawUrl).not.toMatch(/[\r\n]/);
    expect(rawUrl).toBe("/a%0d%0aX-Evil:%201");
    expect(h.hits[0]!.headers["x-evil"]).toBeUndefined();
  });
});

describe("resolution matrix (#108)", () => {
  it("404s unknown runs", async () => {
    const h = await setup();
    const res = await h.request("/previews/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RUN_NOT_FOUND");
  });

  it("403s undeclared ports with the declare-to-preview hint (query + path form)", async () => {
    const h = await setup();
    const run = makeRun(h.db, h.projectId, { ports: [3000] });
    h.setSandbox(run.id, [{ container: 3000, host: h.targetPort, declared: true }]);

    for (const path of [`/previews/${run.id}?port=5000`, `/previews/${run.id}/5000/`]) {
      const res = await h.request(path);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("PREVIEW_PORT_NOT_DECLARED");
      expect(body.error.message).toContain("declare ports on the run");
    }
    expect(h.hits.length).toBe(0);
  });

  it("403s with detected-port hints when a run declared nothing", async () => {
    const h = await setup();
    const run = makeRun(h.db, h.projectId, { detectedPorts: [5173] });
    h.setSandbox(run.id, [{ container: 5173, declared: false, hint: UNDECLARED_PORT_HINT }]);
    const res = await h.request(`/previews/${run.id}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { detected: number[] } };
    };
    expect(body.error.code).toBe("PREVIEW_PORT_NOT_DECLARED");
    expect(body.error.message).toContain("5173");
    expect(body.error.details.detected).toEqual([5173]);
  });

  it("404s a portless run with nothing detected", async () => {
    const h = await setup();
    const run = makeRun(h.db, h.projectId);
    h.setSandbox(run.id, []);
    const res = await h.request(`/previews/${run.id}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PREVIEW_NO_PORTS");
  });

  it("410s terminal runs and sandbox-less (local) runs", async () => {
    const h = await setup();
    const terminal = makeRun(h.db, h.projectId, { status: "success", ports: [3000] });
    const local = makeRun(h.db, h.projectId, { status: "running", ports: [3000] });
    h.setSandbox(terminal.id, undefined);
    h.setSandbox(local.id, undefined);

    const gone = await h.request(`/previews/${terminal.id}?port=3000`);
    expect(gone.status).toBe(410);
    const goneBody = (await gone.json()) as { error: { code: string; message: string } };
    expect(goneBody.error.code).toBe("PREVIEW_GONE");
    expect(goneBody.error.message).toContain("success");

    const localRes = await h.request(`/previews/${local.id}?port=3000`);
    expect(localRes.status).toBe(410);
    expect(((await localRes.json()) as { error: { code: string } }).error.code).toBe(
      "PREVIEW_GONE",
    );
  });

  it("502s a declared port whose mapping vanished (sandbox stopping)", async () => {
    const h = await setup();
    const run = makeRun(h.db, h.projectId, { ports: [3000] });
    h.setSandbox(run.id, [{ container: 3000, declared: true }]);
    const res = await h.request(`/previews/${run.id}`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "PREVIEW_UPSTREAM_UNAVAILABLE",
    );
  });

  it("422s non-integer or out-of-range ports (query + path form)", async () => {
    const h = await setup();
    const run = makeRun(h.db, h.projectId, { ports: [3000] });
    h.setSandbox(run.id, [{ container: 3000, host: h.targetPort, declared: true }]);
    for (const path of [`/previews/${run.id}?port=abc`, `/previews/${run.id}/99999`]) {
      const res = await h.request(path);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_PORT");
    }
  });
});

describe("auth on both mounts (#108)", () => {
  let h: Harness;
  let run: Run;

  beforeEach(async () => {
    h = await setup({ authToken: "sekrit" });
    run = makeRun(h.db, h.projectId, { ports: [3000] });
    h.setSandbox(run.id, [{ container: 3000, host: h.targetPort, declared: true }]);
  });

  it("401s without a token on /previews and /api/previews", async () => {
    for (const path of [`/previews/${run.id}?port=3000`, `/api/previews/${run.id}?port=3000`]) {
      const res = await h.request(path);
      expect(res.status).toBe(401);
    }
    expect(h.hits.length).toBe(0);
  });

  it("accepts the bearer header on all methods, and ?token= on GET only", async () => {
    const post = await h.request(`/previews/${run.id}`, {
      method: "POST",
      headers: { Authorization: "Bearer sekrit" },
      body: "x",
    });
    expect(post.status).toBe(200);

    const get = await h.request(`/previews/${run.id}?port=3000&token=sekrit`);
    expect(get.status).toBe(200);
    expect(h.hits.at(-1)?.url).toBe("/"); // token stripped before forwarding

    const postQuery = await h.request(`/previews/${run.id}?token=sekrit`, {
      method: "POST",
      body: "x",
    });
    expect(postQuery.status).toBe(401);
  });

  it("401s a wrong token", async () => {
    const res = await h.request(`/previews/${run.id}?port=3000&token=wrong`);
    expect(res.status).toBe(401);
  });
});

describe("frame headers on previews (#97/#108)", () => {
  it("keeps XFO DENY by default and switches to frame-ancestors 'self' with PREVIEW_IFRAME", async () => {
    const denied = await setup();
    const runDenied = makeRun(denied.db, denied.projectId, { ports: [3000] });
    denied.setSandbox(runDenied.id, [{ container: 3000, host: denied.targetPort, declared: true }]);
    const resDenied = await denied.request(`/previews/${runDenied.id}`);
    expect(resDenied.status).toBe(200);
    expect(resDenied.headers.get("x-frame-options")).toBe("DENY");
    expect(resDenied.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");

    const framed = await setup();
    // Rebuild the app with the iframe flag on the same db/target.
    const target = createServer((req, res) => res.end("ok"));
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    targets.push(target);
    const port = (target.address() as { port: number }).port;
    const runFramed = makeRun(framed.db, framed.projectId, { ports: [3000] });
    const framedApp = createApp({
      db: framed.db,
      logger: createLogger("silent"),
      executor: stubExecutor(() => ({
        id: "sbx",
        image: "i",
        status: "running",
        ports: [{ container: 3000, host: port, declared: true }],
      })),
      previewIframe: true,
      corsOrigin: "http://app.example:3000",
    });
    const res = await Promise.resolve(framedApp.app.request(`/previews/${runFramed.id}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self' http://app.example:3000",
    );
  });
});

describe("upstream failures (#108)", () => {
  it("502s with the actionable hint on connection refused (published port, no listener)", async () => {
    const h = await setup();
    const port = await freePort();
    const run = makeRun(h.db, h.projectId, { ports: [3000] });
    h.setSandbox(run.id, [{ container: 3000, host: port, declared: true }]);
    const res = await h.request(`/previews/${run.id}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(body.error.code).toBe("PREVIEW_UPSTREAM_UNAVAILABLE");
    expect(body.error.message).toContain(String(port));
    expect(body.error.details.runId).toBe(run.id);
    expect(String(body.error.details.hint)).toContain("/api/runs/");
  });

  it("502s within the connect timeout when the target never answers", async () => {
    const h = await setup({ proxy: true });
    const silent = await startSilentTarget();
    targets.push(silent.server);
    const run = makeRun(h.db, h.projectId, { ports: [3000] });
    h.setSandbox(run.id, [{ container: 3000, host: silent.port, declared: true }]);
    const startedAt = Date.now();
    const res = await h.request(`/previews/${run.id}`);
    expect(res.status).toBe(502);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5_000);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("PREVIEW_UPSTREAM_UNAVAILABLE");
    expect(body.error.message).toContain("connect/headers timeout");
  });
});

describe("load: 100 concurrent proxied GETs (#108)", () => {
  it("serves all 100 without loss", async () => {
    const h = await setup();
    const run = makeRun(h.db, h.projectId, { ports: [3000] });
    h.setSandbox(run.id, [{ container: 3000, host: h.targetPort, declared: true }]);
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        h.request(`/previews/${run.id}/3000/load?i=${i}`).then((res) => res.status),
      ),
    );
    expect(responses.filter((status) => status === 200)).toHaveLength(100);
    expect(h.hits.length).toBe(100);
  });
});
