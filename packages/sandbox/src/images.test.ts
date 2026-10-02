import { describe, expect, it } from "vitest";
import { SandboxError } from "./error.js";
import { type DockerCliResult, type DockerStdinCliRunner } from "./docker-cli.js";
import {
  buildSandboxImage,
  COMMON_BASE_IMAGES,
  imageBuildTag,
  imageNameIssue,
  imageRefIssue,
  listSandboxImages,
  normalizeImageRef,
  parseDockerCreatedAtMs,
  parseDockerSizeToBytes,
  pullSandboxImage,
  removeSandboxImage,
} from "./images.js";

/**
 * Image-management unit tests (#100): validation rules and exact CLI argv
 * assertions against scripted runners (refs pass through verbatim; invalid
 * refs never reach the CLI). Real-daemon behavior lives in the daemon's
 * integration suite.
 */

class RecordingRunner {
  readonly calls: string[][] = [];
  private readonly results: Array<DockerCliResult | Error> = [];

  push(result: DockerCliResult | Error): this {
    this.results.push(result);
    return this;
  }

  ok(stdout = ""): this {
    return this.push({ code: 0, stdout, stderr: "" });
  }

  fail(code: number, stderr: string): this {
    return this.push({ code, stdout: "", stderr });
  }

  async run(args: readonly string[]): Promise<DockerCliResult> {
    this.calls.push([...args]);
    const next = this.results.shift();
    if (next === undefined) {
      throw new Error(`unexpected docker call: docker ${args.join(" ")}`);
    }
    if (next instanceof Error) throw next;
    return next;
  }
}

class RecordingStdinRunner {
  readonly calls: Array<{ args: string[]; input: string }> = [];
  private result: DockerCliResult | Error = { code: 0, stdout: "", stderr: "" };

  resolve(result: DockerCliResult | Error): this {
    this.result = result;
    return this;
  }

  run: DockerStdinCliRunner = async (args, input) => {
    this.calls.push({ args: [...args], input });
    if (this.result instanceof Error) throw this.result;
    return this.result;
  };
}

const imagesRow = (
  row: Partial<{ Repository: string; Tag: string; ID: string }> & Record<string, string>,
): string => JSON.stringify(row);

describe("validation: build names (#100)", () => {
  it("accepts flat lowercase names", () => {
    expect(imageNameIssue("worker")).toBeNull();
    expect(imageNameIssue("test-img")).toBeNull();
    expect(imageNameIssue("py3.12_dev.v2")).toBeNull();
    expect(imageNameIssue("a")).toBeNull();
    expect(imageNameIssue("a-b_c.d")).toBeNull();
  });

  it("rejects uppercase, slashes, empties, dashes and too-long names", () => {
    expect(imageNameIssue("")).toMatch(/non-empty/);
    expect(imageNameIssue("MyImage")).toMatch(/a-z 0-9/);
    expect(imageNameIssue("nested/name")).toMatch(/a-z 0-9/);
    expect(imageNameIssue("with space")).toMatch(/a-z 0-9/);
    expect(imageNameIssue("nested/name")).toMatch(/a-z 0-9/);
    expect(imageNameIssue("x".repeat(65))).toMatch(/at most 64/);
  });

  it("derives the build tag under the openeuler/ namespace", () => {
    expect(imageBuildTag("test-img")).toBe("openeuler/test-img:latest");
  });
});

describe("validation: pull refs (#100)", () => {
  it("accepts registry refs with tags, digests and namespaces", () => {
    expect(imageRefIssue("busybox:musl")).toBeNull();
    expect(imageRefIssue("node:22-alpine")).toBeNull();
    expect(imageRefIssue("alpine")).toBeNull();
    expect(imageRefIssue("denoland/deno:2")).toBeNull();
    expect(imageRefIssue("openeuler/worker@sha256:abc123")).toBeNull();
    expect(imageRefIssue("a".repeat(255))).toBeNull();
  });

  it("rejects flag-like, whitespace, uppercase and host-port refs", () => {
    expect(imageRefIssue("")).toMatch(/non-empty/);
    expect(imageRefIssue("--privileged")).toMatch(/dash|a-z/i);
    expect(imageRefIssue(" busybox")).toMatch(/whitespace/);
    expect(imageRefIssue("BusyBox")).toMatch(/a-z 0-9/);
    expect(imageRefIssue("localhost:5000/img")).toMatch(/a-z 0-9/);
    expect(imageRefIssue("a".repeat(256))).toMatch(/at most 255/);
  });

  it("normalizes untagged refs to :latest for comparisons", () => {
    expect(normalizeImageRef("openeuler/worker")).toBe("openeuler/worker:latest");
    expect(normalizeImageRef("openeuler/worker:latest")).toBe("openeuler/worker:latest");
    expect(normalizeImageRef("openeuler/worker@sha256:abc")).toBe("openeuler/worker@sha256:abc");
    expect(normalizeImageRef("denoland/deno")).toBe("denoland/deno:latest");
  });
});

describe("docker output parsing (#100)", () => {
  it("parses go-units decimal size strings to bytes", () => {
    expect(parseDockerSizeToBytes("95.1MB")).toBe(95_100_000);
    expect(parseDockerSizeToBytes("4.19kB")).toBe(4_190);
    expect(parseDockerSizeToBytes("1.5GB")).toBe(1_500_000_000);
    expect(parseDockerSizeToBytes("123B")).toBe(123);
    expect(Number.isNaN(parseDockerSizeToBytes("4.19 MiB"))).toBe(true);
    expect(Number.isNaN(parseDockerSizeToBytes(undefined))).toBe(true);
  });

  it("parses docker's CreatedAt with numeric offsets, treating bare stamps as UTC", () => {
    expect(parseDockerCreatedAtMs("2026-10-02 09:49:06 +0800 CST")).toBe(
      Date.UTC(2026, 9, 2, 1, 49, 6),
    );
    expect(parseDockerCreatedAtMs("2026-10-02 09:49:06 -0500 EST")).toBe(
      Date.UTC(2026, 9, 2, 14, 49, 6),
    );
    expect(parseDockerCreatedAtMs("2026-10-02 09:49:06")).toBe(Date.UTC(2026, 9, 2, 9, 49, 6));
    expect(Number.isNaN(parseDockerCreatedAtMs("garbage"))).toBe(true);
  });
});

describe("pullSandboxImage (#100)", () => {
  it("passes the ref through to the CLI verbatim after validation", async () => {
    const runner = new RecordingRunner().ok("musl: Pull complete\n");
    await pullSandboxImage("busybox:musl", { runner: (a) => runner.run(a) });
    expect(runner.calls).toEqual([["pull", "busybox:musl"]]);
  });

  it("never reaches the CLI for an invalid ref", async () => {
    const runner = new RecordingRunner();
    await expect(
      pullSandboxImage("--danger", { runner: (a) => runner.run(a) }),
    ).rejects.toMatchObject({
      code: "SANDBOX_INVALID_SPEC",
    });
    expect(runner.calls).toEqual([]);
  });

  it("maps a failed pull to SANDBOX_IMAGE_MISSING with the stderr tail", async () => {
    const runner = new RecordingRunner().fail(
      1,
      "Error response from daemon: pull access denied for nope/nope, repository does not exist",
    );
    await expect(
      pullSandboxImage("nope/nope", { runner: (a) => runner.run(a) }),
    ).rejects.toMatchObject({
      code: "SANDBOX_IMAGE_MISSING",
      message: expect.stringContaining("repository does not exist"),
    });
  });

  it("maps a daemon-down pull to SANDBOX_UNAVAILABLE", async () => {
    const runner = new RecordingRunner().fail(
      1,
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    );
    await expect(
      pullSandboxImage("busybox:musl", { runner: (a) => runner.run(a) }),
    ).rejects.toMatchObject({
      code: "SANDBOX_UNAVAILABLE",
    });
  });
});

describe("buildSandboxImage (#100)", () => {
  it("pipes the Dockerfile to `docker build -t openeuler/<name>:latest -`", async () => {
    const stdinRunner = new RecordingStdinRunner();
    const outcome = await buildSandboxImage(
      { name: "test-img", dockerfileText: "FROM busybox:musl\nRUN echo hi\n" },
      { stdinRunner: stdinRunner.run },
    );
    expect(outcome).toEqual({ tag: "openeuler/test-img:latest" });
    expect(stdinRunner.calls).toEqual([
      {
        args: ["build", "-t", "openeuler/test-img:latest", "-"],
        input: "FROM busybox:musl\nRUN echo hi\n",
      },
    ]);
  });

  it("rejects invalid names, empty Dockerfiles and NUL bytes before any build", async () => {
    const stdinRunner = new RecordingStdinRunner();
    await expect(
      buildSandboxImage(
        { name: "Bad/Name", dockerfileText: "FROM alpine\n" },
        { stdinRunner: stdinRunner.run },
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    await expect(
      buildSandboxImage({ name: "ok", dockerfileText: "   " }, { stdinRunner: stdinRunner.run }),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    await expect(
      buildSandboxImage(
        { name: "ok", dockerfileText: "FROM alpine\n\u0000" },
        { stdinRunner: stdinRunner.run },
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });
    expect(stdinRunner.calls).toEqual([]);
  });

  it("maps a missing base image to SANDBOX_IMAGE_MISSING", async () => {
    const stdinRunner = new RecordingStdinRunner().resolve({
      code: 1,
      stdout: "",
      stderr:
        "ERROR: failed to solve: alpine:9.9.9: failed to resolve source metadata for docker.io/library/alpine:9.9.9: manifest unknown",
    });
    await expect(
      buildSandboxImage(
        { name: "x", dockerfileText: "FROM alpine:9.9.9" },
        { stdinRunner: stdinRunner.run },
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_IMAGE_MISSING" });
  });

  it("maps other build failures to SANDBOX_EXEC_FAILED with the output tail", async () => {
    const stdinRunner = new RecordingStdinRunner().resolve({
      code: 1,
      stdout: "",
      stderr: 'ERROR: failed to solve: process "/bin/sh -c boom" did not complete successfully',
    });
    await expect(
      buildSandboxImage(
        { name: "x", dockerfileText: "FROM alpine\nRUN boom" },
        { stdinRunner: stdinRunner.run },
      ),
    ).rejects.toMatchObject({
      code: "SANDBOX_EXEC_FAILED",
      message: expect.stringContaining("did not complete successfully"),
    });
  });
});

describe("removeSandboxImage (#100)", () => {
  it("inspects then removes, passing the ref verbatim", async () => {
    const runner = new RecordingRunner().ok("{}").ok("Untagged: openeuler/test-img:latest\n");
    await removeSandboxImage("openeuler/test-img:latest", { runner: (a) => runner.run(a) });
    expect(runner.calls).toEqual([
      ["image", "inspect", "openeuler/test-img:latest"],
      ["rmi", "openeuler/test-img:latest"],
    ]);
  });

  it("answers SANDBOX_IMAGE_MISSING when inspect says no such image", async () => {
    const runner = new RecordingRunner().fail(1, "Error: No such image: openeuler/ghost:latest");
    await expect(
      removeSandboxImage("openeuler/ghost:latest", { runner: (a) => runner.run(a) }),
    ).rejects.toMatchObject({
      code: "SANDBOX_IMAGE_MISSING",
    });
    // rmi never ran
    expect(runner.calls).toHaveLength(1);
  });

  it("answers SANDBOX_IMAGE_IN_USE when docker reports a held image", async () => {
    const runner = new RecordingRunner()
      .ok("{}")
      .fail(
        1,
        "Error response from daemon: conflict: unable to delete c20193766f51 (must be forced) - image is being used by stopped container abc123",
      );
    await expect(
      removeSandboxImage("openeuler/test-img:latest", { runner: (a) => runner.run(a) }),
    ).rejects.toMatchObject({
      code: "SANDBOX_IMAGE_IN_USE",
    });
  });
});

describe("listSandboxImages (#100)", () => {
  const rows = [
    imagesRow({
      Repository: "openeuler/worker",
      Tag: "latest",
      ID: "aaaa1111bbbb",
      Size: "12.5MB",
      CreatedAt: "2026-10-01 10:00:00 +0000 UTC",
    }),
    imagesRow({
      Repository: "busybox",
      Tag: "musl",
      ID: "cccc2222dddd",
      Size: "4.2MB",
      CreatedAt: "2026-09-01 10:00:00 +0000 UTC",
    }),
    imagesRow({
      Repository: "typezo-web",
      Tag: "latest",
      ID: "eeee3333ffff",
      Size: "95.1MB",
      CreatedAt: "2026-10-02 09:49:06 +0800 CST",
    }),
    imagesRow({
      Repository: "<none>",
      Tag: "<none>",
      ID: "000000000000",
      Size: "1.0kB",
      CreatedAt: "2026-10-02 09:49:06 +0000 UTC",
    }),
    imagesRow({
      Repository: "openeuler/dangling",
      Tag: "<none>",
      ID: "111111111111",
      Size: "1.0kB",
      CreatedAt: "2026-10-02 09:49:06 +0000 UTC",
    }),
  ].join("\n");

  const inspectLines = [
    JSON.stringify({
      Id: "sha256:aaaa1111bbbb" + "0".repeat(52),
      Created: "2026-10-01T10:00:00.000000000Z",
      Size: 12_500_000,
    }),
    JSON.stringify({
      Id: "sha256:cccc2222dddd" + "0".repeat(52),
      Created: "2026-09-01T10:00:00.000000000Z",
      Size: 4_161_792,
    }),
  ].join("\n");

  it("lists ours + curated bases, enriched by the batched inspect", async () => {
    const runner = new RecordingRunner().ok(rows).ok(inspectLines);
    const images = await listSandboxImages({ runner: (a) => runner.run(a) });
    expect(runner.calls).toEqual([
      ["images", "--format", "json"],
      ["image", "inspect", "--format", "{{json .}}", "openeuler/worker:latest", "busybox:musl"],
    ]);
    expect(images).toEqual([
      {
        repository: "openeuler/worker",
        tag: "latest",
        id: "sha256:aaaa1111bbbb" + "0".repeat(52),
        sizeBytes: 12_500_000,
        createdAt: Date.UTC(2026, 9, 1, 10, 0, 0),
        ours: true,
      },
      {
        repository: "busybox",
        tag: "musl",
        id: "sha256:cccc2222dddd" + "0".repeat(52),
        sizeBytes: 4_161_792,
        createdAt: Date.UTC(2026, 8, 1, 10, 0, 0),
        ours: false,
      },
    ]);
  });

  it("falls back to row values when the enriching inspect fails entirely", async () => {
    const runner = new RecordingRunner().ok(rows).fail(1, "Error: No such image: gone");
    const images = await listSandboxImages({ runner: (a) => runner.run(a) });
    expect(images.map((image) => `${image.repository}:${image.tag}`)).toEqual([
      "openeuler/worker:latest",
      "busybox:musl",
    ]);
    expect(images[0]).toMatchObject({
      id: "aaaa1111bbbb",
      sizeBytes: 12_500_000,
      ours: true,
    });
    expect(images[1]).toMatchObject({
      id: "cccc2222dddd",
      sizeBytes: 4_200_000,
      ours: false,
    });
  });

  it("returns [] without a second CLI call when nothing matches", async () => {
    const runner = new RecordingRunner().ok(
      imagesRow({ Repository: "typezo-web", Tag: "latest", ID: "x", Size: "1MB" }),
    );
    expect(await listSandboxImages({ runner: (a) => runner.run(a) })).toEqual([]);
    expect(runner.calls).toHaveLength(1);
  });

  it("throws SANDBOX_UNAVAILABLE when the daemon is down", async () => {
    const runner = new RecordingRunner().fail(
      1,
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    );
    await expect(listSandboxImages({ runner: (a) => runner.run(a) })).rejects.toMatchObject({
      code: "SANDBOX_UNAVAILABLE",
    });
  });

  it("treats the curated list as refs (repository:tag pairs)", () => {
    for (const ref of COMMON_BASE_IMAGES) {
      expect(ref).toMatch(/^[a-z0-9._/-]+:[A-Za-z0-9._-]+$/);
    }
    expect(COMMON_BASE_IMAGES.length).toBeGreaterThanOrEqual(5);
    expect(COMMON_BASE_IMAGES.length).toBeLessThanOrEqual(6);
  });

  it("is usable via the package surface without a thrown SandboxError import cycle", () => {
    expect(SandboxError.name).toBe("SandboxError");
  });
});
