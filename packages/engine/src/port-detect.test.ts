import { describe, expect, it } from "vitest";
import { MAX_RUN_PORTS } from "@openeuler/core";
import { detectPorts, mergeDetectedPorts, runPortList } from "./port-detect.js";

/**
 * #107: the detector against real-world dev-server output lines (Next.js,
 * Vite, Flask, Uvicorn, Rails/Puma, Express, python http.server, webpack,
 * npm scripts) plus false-positive guards (dates, timestamps, paths, exit
 * codes, port-less URLs) — the issue checklist.
 */
describe("detectPorts (#107)", () => {
  it.each([
    // Next.js
    ["▲ Next.js 14.2.3 - ready on http://localhost:3000", [3000]],
    ["▲ Next.js 15 - ready on http://0.0.0.0:3000 in 1.2s", [3000]],
    // Vite
    ["  ➜  Local:   http://localhost:5173/", [5173]],
    ["  ➜  Network: http://192.168.1.42:5173/", [5173]],
    // Flask / Werkzeug
    [" * Running on http://127.0.0.1:5000", [5000]],
    // Uvicorn
    ["INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)", [8000]],
    // Rails / Puma
    ["* Listening on http://0.0.0.0:3000 in development mode", [3000]],
    ["* Listening on tcp://0.0.0.0:3000", [3000]],
    // Express / Node
    ["Server listening on port 3000", [3000]],
    ["App listening on port 3001", [3001]],
    ["listening on :4000", [4000]],
    // python http.server
    ["Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/)", [8000]],
    // webpack dev server
    ["<i> [webpack-dev-server] Project is running at: http://localhost:8080/", [8080]],
    // env-style
    ["PORT=3000", [3000]],
    ["export PORT=5173", [5173]],
    // bare host:port mentions
    ["try it at localhost:3000", [3000]],
    ["the API is up at 127.0.0.1:8787", [8787]],
    // IPv6 bracketed hosts (Vite IPv6-prefering machines, Puma)
    ["Local:   http://[::1]:5173/", [5173]],
    ["* Listening on http://[::]:3000", [3000]],
    ["bare [::1]:3000 mention", [3000]],
    ["[::]:8080 binding", [8080]],
    // sentence-ending periods must not break detection
    ["Server started on port 3000.", [3000]],
    ["listening on :3000.", [3000]],
    // decimals never match
    ["port 3000.5 rejected", []],
    // weak pattern: :NNNN directly after serving/running/started
    ["dev server running :3000", [3000]],
    ["server started :8081", [8081]],
    // mixed multi-port output
    [
      "frontend on http://localhost:3000\napi listening on port 4000\ndb at localhost:5432",
      [3000, 4000, 5432],
    ],
    // issue-body patterns verbatim
    ["listening on :3000", [3000]],
    ["on port 3000", [3000]],
    ["http://0.0.0.0:3000", [3000]],
  ])("detects %j -> %j", (line, expected) => {
    expect(detectPorts(line)).toEqual(expected);
  });

  it.each([
    // dates and timestamps (issue: "2026-10-02 has no colon-prefix context")
    ["2026-10-02"],
    ["run at 2026-10-02T05:30:44Z"],
    ["05:30:44 task finished"],
    // code locations and exit codes
    ["src/app/page.tsx:42:3"],
    ["process exited with code 127"],
    // URLs without ports
    ["see https://github.com/openeuler/repo for details"],
    ["docs at http://example.com/docs"],
    // https default port excluded on purpose
    ["server behind https://example.com (port 443 terminated upstream)"],
    ["listening on port 80"],
    // paths and versions
    ["upgraded to TypeScript 5.9.2"],
    ["node_modules/.pnpm/vite@5.2.0"],
    // a bare number is never a port without listen context
    ["3000 files changed"],
    ["budget 10000 ms"],
    // weak pattern requires the serving/running/started prefix
    ["also check :3000 later"],
    // serial-port style text
    ["Listening on serial port /dev/ttyUSB0"],
  ])("ignores %j", (line) => {
    expect(detectPorts(line)).toEqual([]);
  });

  it("caps at 3 unique ports (first-seen order)", () => {
    const text = [
      "frontend listening on port 3000",
      "api on port 4000",
      "db on port 5432",
      "cache on port 6379", // over the cap
    ].join("\n");
    expect(detectPorts(text)).toEqual([3000, 4000, 5432]);
  });

  it("dedupes the same port found by multiple patterns", () => {
    expect(detectPorts("listening on :3000 and http://localhost:3000/ (port 3000)")).toEqual([
      3000,
    ]);
  });

  it("never returns excluded or out-of-range ports", () => {
    expect(detectPorts("on port 0, port 80, port 443 and port 65536")).toEqual([]);
    expect(detectPorts("http://localhost:443")).toEqual([]);
  });

  it("handles empty and whitespace-only text", () => {
    expect(detectPorts("")).toEqual([]);
    expect(detectPorts("\n\n  \t")).toEqual([]);
  });
});

describe("mergeDetectedPorts (#107)", () => {
  it("unions in first-seen order, deduped, capped", () => {
    expect(mergeDetectedPorts(undefined, [3000])).toEqual([3000]);
    expect(mergeDetectedPorts([3000], [3000, 4000])).toEqual([3000, 4000]);
    expect(mergeDetectedPorts([3000, 4000], [5432, 6379])).toEqual([3000, 4000, 5432]);
  });

  it("treats undefined current as empty", () => {
    expect(mergeDetectedPorts(undefined, [1, 2, 3, 4])).toEqual([1, 2, 3]);
  });

  it("caps at MAX_RUN_PORTS", () => {
    expect(mergeDetectedPorts([8080, 3000, 9090], [4000])).toHaveLength(MAX_RUN_PORTS);
  });
});

describe("runPortList (#107)", () => {
  it("declared ports first in declaration order, then detected extras, capped", () => {
    expect(runPortList([8080, 3000], [3000, 5000])).toEqual([8080, 3000, 5000]);
    expect(runPortList(undefined, [3000])).toEqual([3000]);
    expect(runPortList([3000], undefined)).toEqual([3000]);
    expect(runPortList([3000, 4000, 5000], [6000])).toEqual([3000, 4000, 5000]);
  });

  it("empty inputs render an empty list", () => {
    expect(runPortList(undefined, undefined)).toEqual([]);
  });
});
