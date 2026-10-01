import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches exact strings with a high score", () => {
    const match = fuzzyMatch("runs", "runs");
    expect(match).not.toBeNull();
    expect(match!.positions).toEqual([0, 1, 2, 3]);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("RNS", "runs")).not.toBeNull();
    expect(fuzzyMatch("dsd", "Dashboard")).not.toBeNull();
  });

  it("matches subsequences in order (greedy first match)", () => {
    const match = fuzzyMatch("psh", "projects/settings/health");
    expect(match).not.toBeNull();
    expect(match!.positions).toEqual([0, 7, 18]);
  });

  it("returns null when a character is missing", () => {
    expect(fuzzyMatch("runsx", "runs")).toBeNull();
    expect(fuzzyMatch("z", "abc")).toBeNull();
  });

  it("returns null when characters are out of order", () => {
    expect(fuzzyMatch("sr", "runs")).toBeNull();
  });

  it("empty query matches everything with a neutral score", () => {
    const match = fuzzyMatch("", "anything");
    expect(match).toEqual({ positions: [], score: 0 });
  });
});

describe("fuzzyMatch scoring", () => {
  it("prefix beats scattered subsequence", () => {
    const prefix = fuzzyMatch("pro", "projects")!;
    const scattered = fuzzyMatch("prt", "copartment")!;
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });

  it("consecutive runs beat gaps", () => {
    const tight = fuzzyMatch("abc", "xxabcxx")!;
    const gapped = fuzzyMatch("abc", "axbxc")!;
    expect(tight.score).toBeGreaterThan(gapped.score);
  });

  it("word-boundary start beats mid-word start", () => {
    const boundary = fuzzyMatch("pro", "my projects")!;
    const midWord = fuzzyMatch("pro", "xyprojects")!;
    expect(boundary.score).toBeGreaterThan(midWord.score);
  });
});

describe("fuzzyFilter", () => {
  const candidates = ["dashboard", "projects", "runs", "settings"];

  it("returns everything (original order) for an empty query", () => {
    const result = fuzzyFilter("", candidates, (c) => c);
    expect(result.map((entry) => entry.candidate)).toEqual(candidates);
  });

  it("drops non-matching candidates", () => {
    const result = fuzzyFilter("run", candidates, (c) => c);
    expect(result.map((entry) => entry.candidate)).toEqual(["runs"]);
  });

  it("sorts best matches first", () => {
    const result = fuzzyFilter("s", candidates, (c) => c);
    const labels = result.map((entry) => entry.candidate);
    // Every result contains an s; settings (prefix match) ranks first.
    for (const label of labels) expect(label.includes("s")).toBe(true);
    expect(labels[0]).toBe("settings");
  });

  it("is stable for ties", () => {
    const result = fuzzyFilter("a", ["a1", "a2", "a3"], (c) => c);
    expect(result.map((entry) => entry.candidate)).toEqual(["a1", "a2", "a3"]);
  });
});
