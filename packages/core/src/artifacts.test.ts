import { describe, expect, it } from "vitest";
import {
  MAX_ARTIFACT_FILES,
  MAX_ARTIFACT_PATTERNS,
  MAX_ARTIFACT_TOTAL_BYTES,
  WorkflowGraphSchema,
  WorkflowArtifactsSchema,
  artifactPatternIssue,
  compileArtifactPattern,
  linearToGraph,
  matchesArtifactPath,
} from "./index.js";
import type { Step } from "./index.js";

const step = (id: string): Step => ({
  id,
  name: id,
  driver: "opencode",
  mode: "auto",
  promptTemplate: "{{task}}",
  continueSession: false,
});

describe("artifactPatternIssue", () => {
  it("accepts safe globs with wildcards and negation", () => {
    for (const pattern of [
      "dist/**",
      "dist",
      "*.log",
      "build/*.js",
      "reports/**/coverage.*",
      "?.txt",
      "!**/*.map",
      "a?c/*.ts",
    ]) {
      expect(artifactPatternIssue(pattern), pattern).toBeUndefined();
    }
  });

  it("rejects escaping and unsupported syntax", () => {
    for (const pattern of [
      "",
      "/etc/passwd",
      "C:/win",
      "a\\b",
      "../outside",
      "a/../b",
      "./here",
      "a//b",
      "no ! inside",
      "!",
      "braces-{a,b}",
      "class[abc]",
      "null\0byte",
    ]) {
      expect(artifactPatternIssue(pattern), JSON.stringify(pattern)).not.toBeUndefined();
    }
  });

  it("rejects over-long patterns", () => {
    expect(artifactPatternIssue("a".repeat(257))).not.toBeUndefined();
  });
});

describe("WorkflowArtifactsSchema", () => {
  it("accepts a bounded list of safe patterns", () => {
    expect(WorkflowArtifactsSchema.parse(["dist/**", "!**/*.map"])).toEqual([
      "dist/**",
      "!**/*.map",
    ]);
  });

  it("caps the pattern count", () => {
    const many = Array.from({ length: MAX_ARTIFACT_PATTERNS + 1 }, (_, i) => `d${i}/**`);
    expect(WorkflowArtifactsSchema.safeParse(many).success).toBe(false);
  });
});

describe("compileArtifactPattern", () => {
  it("anchors slash-containing patterns at the root", () => {
    const matcher = compileArtifactPattern("dist/*.js");
    expect(matcher("dist/a.js")).toBe(true);
    expect(matcher("nested/dist/a.js")).toBe(false);
    expect(matcher("dist/a.css")).toBe(false);
  });

  it("matches slash-free patterns at any depth", () => {
    const matcher = compileArtifactPattern("*.log");
    expect(matcher("a.log")).toBe(true);
    expect(matcher("build/deep/a.log")).toBe(true);
    expect(matcher("a.js")).toBe(false);
  });

  it("treats ** as a multi-segment wildcard", () => {
    const matcher = compileArtifactPattern("dist/**");
    expect(matcher("dist/a.js")).toBe(true);
    expect(matcher("dist/nested/deep/a.js")).toBe(true);
    expect(matcher("dist")).toBe(false);
    expect(matcher("other/a.js")).toBe(false);

    const interior = compileArtifactPattern("reports/**/coverage.lcov");
    expect(interior("reports/coverage.lcov")).toBe(true);
    expect(interior("reports/n1/n2/coverage.lcov")).toBe(true);
    expect(interior("docs/reports/coverage.lcov")).toBe(false);
  });

  it("keeps * and ? within one segment", () => {
    const star = compileArtifactPattern("dist/*.js");
    expect(star("dist/nested/a.js")).toBe(false);
    const q = compileArtifactPattern("?.txt");
    expect(q("a.txt")).toBe(true);
    expect(q("ab.txt")).toBe(false);
  });

  it("escapes regex metacharacters in pattern text", () => {
    const dot = compileArtifactPattern("v1.2/*.txt");
    expect(dot("v1.2/a.txt")).toBe(true);
    expect(dot("v1x2/a.txt")).toBe(false);
    const group = compileArtifactPattern("a+b.txt");
    expect(group("a+b.txt")).toBe(true);
    expect(group("aab.txt")).toBe(false);
  });

  it("matches a bare directory name itself", () => {
    const matcher = compileArtifactPattern("dist");
    expect(matcher("dist")).toBe(true);
    expect(matcher("distribution")).toBe(false);
  });
});

describe("matchesArtifactPath", () => {
  it("includes a directory's subtree when the pattern names the directory", () => {
    expect(matchesArtifactPath("dist/a/b.js", ["dist"])).toBe(true);
    expect(matchesArtifactPath("src/a.js", ["dist"])).toBe(false);
  });

  it("resolves negations with last-match-wins", () => {
    expect(matchesArtifactPath("dist/a.js", ["dist/**", "!**/*.map"])).toBe(true);
    expect(matchesArtifactPath("dist/a.js.map", ["dist/**", "!**/*.map"])).toBe(false);
    // Order matters: a later include re-includes.
    expect(matchesArtifactPath("dist/a.js.map", ["!**/*.map", "dist/**"])).toBe(true);
    // Negating a directory excludes its subtree (ancestor match).
    expect(matchesArtifactPath("dist/sub/a.js", ["dist/**", "!dist/sub"])).toBe(false);
  });

  it("excludes unmatched paths by default", () => {
    expect(matchesArtifactPath("a/b.js", [])).toBe(false);
    expect(matchesArtifactPath("a/b.js", ["dist/**"])).toBe(false);
  });

  it("supports the everything pattern", () => {
    expect(matchesArtifactPath("any/thing.txt", ["**"])).toBe(true);
  });
});

describe("WorkflowGraphSchema artifacts (#122)", () => {
  it("accepts a graph with artifact patterns and defaults absent to undefined", () => {
    const base = linearToGraph({ steps: [step("a")] });
    const withArtifacts = WorkflowGraphSchema.parse({ ...base, artifacts: ["dist/**"] });
    expect(withArtifacts.artifacts).toEqual(["dist/**"]);

    const without = WorkflowGraphSchema.parse(base);
    expect(without.artifacts).toBeUndefined();
  });

  it("rejects unsafe patterns on the graph", () => {
    const base = linearToGraph({ steps: [step("a")] });
    expect(WorkflowGraphSchema.safeParse({ ...base, artifacts: ["../escape"] }).success).toBe(
      false,
    );
    expect(WorkflowGraphSchema.safeParse({ ...base, artifacts: [42] }).success).toBe(false);
  });
});

describe("capture caps (#122)", () => {
  it("exposes the documented constants", () => {
    expect(MAX_ARTIFACT_FILES).toBe(200);
    expect(MAX_ARTIFACT_TOTAL_BYTES).toBe(50 * 1024 * 1024);
  });
});
