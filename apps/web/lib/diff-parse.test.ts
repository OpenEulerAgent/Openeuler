import { describe, expect, it } from "vitest";
import { languageForPath, parsePatch } from "./diff-parse.js";

const multiFilePatch = [
  "diff --git a/README.md b/README.md",
  "index 1234567..89abcde 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1,2 @@",
  "-# demo",
  "+# demo",
  "+changed",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..abcdef1",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const x = 1;",
  "+export const y = 2;",
].join("\n");

describe("parsePatch", () => {
  it("splits the patch into file entries with paths and +/- counts", () => {
    const entries = parsePatch(multiFilePatch);
    expect(entries).toHaveLength(2);

    expect(entries[0]).toMatchObject({
      path: "README.md",
      oldPath: "README.md",
      newPath: "README.md",
      additions: 2,
      deletions: 1,
      isNew: false,
      isDeleted: false,
      isBinary: false,
    });
    expect(entries[1]).toMatchObject({
      path: "src/new.ts",
      oldPath: "",
      newPath: "src/new.ts",
      additions: 2,
      deletions: 0,
      isNew: true,
    });
  });

  it("reconstructs old/new sides from hunks (context feeds both)", () => {
    const entries = parsePatch(multiFilePatch);
    expect(entries[0]?.oldText).toBe("# demo");
    expect(entries[0]?.newText).toBe("# demo\nchanged");
    // New file: empty pre-image, full post-image.
    expect(entries[1]?.oldText).toBe("");
    expect(entries[1]?.newText).toBe("export const x = 1;\nexport const y = 2;");
  });

  it("marks deleted files and binary sections", () => {
    const patch = [
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index abc..000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/logo.png b/logo.png",
      "index 111..222",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    const entries = parsePatch(patch);
    expect(entries[0]).toMatchObject({
      isDeleted: true,
      oldPath: "gone.txt",
      newPath: "",
      deletions: 1,
      oldText: "bye",
      newText: "",
    });
    expect(entries[1]).toMatchObject({ path: "logo.png", isBinary: true });
  });

  it("handles renames via rename from/to", () => {
    const patch = [
      "diff --git a/old-name.md b/new-name.md",
      "similarity index 90%",
      "rename from old-name.md",
      "rename to new-name.md",
      "index abc..def 100644",
      "--- a/old-name.md",
      "+++ b/new-name.md",
      "@@ -1 +1 @@",
      "-# old",
      "+# new",
    ].join("\n");
    const entries = parsePatch(patch);
    expect(entries[0]).toMatchObject({
      isRename: true,
      oldPath: "old-name.md",
      newPath: "new-name.md",
      path: "new-name.md",
    });
  });

  it("counts match git-style hunks across multiple sections of one file", () => {
    const patch = [
      "diff --git a/big.txt b/big.txt",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -1,3 +1,3 @@",
      " keep1",
      "-drop1",
      "+add1",
      " keep2",
      "@@ -10,2 +10,3 @@",
      " keep3",
      "+add2",
      "+add3",
    ].join("\n");
    const entries = parsePatch(patch);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ additions: 3, deletions: 1 });
    expect(entries[0]?.oldText).toBe("keep1\ndrop1\nkeep2\nkeep3");
    expect(entries[0]?.newText).toBe("keep1\nadd1\nkeep2\nkeep3\nadd2\nadd3");
  });

  it("tolerates a truncated tail cut mid-hunk (server line cap)", () => {
    const lines = multiFilePatch.split("\n");
    const truncated = lines.slice(0, lines.length - 1).join("\n"); // cut before the last "+"
    const entries = parsePatch(truncated);
    expect(entries).toHaveLength(2);
    expect(entries[1]?.additions).toBe(1); // only the surviving "+" line counted
  });

  it("returns [] for empty patches", () => {
    expect(parsePatch("")).toEqual([]);
  });

  it("ignores '\u005c No newline at end of file' markers", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
    ].join("\n");
    const entries = parsePatch(patch);
    expect(entries[0]).toMatchObject({ additions: 1, deletions: 1 });
    expect(entries[0]?.oldText).toBe("old");
    expect(entries[0]?.newText).toBe("new");
  });
});

describe("languageForPath", () => {
  it("maps common extensions to refractor languages", () => {
    expect(languageForPath("src/index.ts")).toBe("typescript");
    expect(languageForPath("app/page.tsx")).toBe("tsx");
    expect(languageForPath("lib/api.js")).toBe("javascript");
    expect(languageForPath("package.json")).toBe("json");
    expect(languageForPath("README.md")).toBe("markdown");
    expect(languageForPath("styles.css")).toBe("css");
    expect(languageForPath("index.html")).toBe("html");
    expect(languageForPath("scripts/run.sh")).toBe("bash");
    expect(languageForPath("main.py")).toBe("python");
    expect(languageForPath("svc.go")).toBe("go");
    expect(languageForPath("lib.rs")).toBe("rust");
    expect(languageForPath("ci.yaml")).toBe("yaml");
    expect(languageForPath("Makefile")).toBe("makefile");
  });

  it("falls back to undefined (plain text) for unknown or missing extensions", () => {
    expect(languageForPath("data.bin")).toBeUndefined();
    expect(languageForPath("LICENSE")).toBeUndefined();
    expect(languageForPath("weird.unknownext")).toBeUndefined();
  });
});
