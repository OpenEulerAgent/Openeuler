import { describe, expect, it } from "vitest";
import {
  MIN_SECRET_REDACTION_LENGTH,
  SECRET_NAME_SCHEMA,
  redactJson,
  redactSecrets,
  secretRedactionMarker,
} from "./secrets.js";

describe("SECRET_NAME_SCHEMA", () => {
  it.each(["NPM_TOKEN", "_PRIVATE", "A", "API_KEY_2", "X".repeat(64)])("accepts %s", (name) => {
    expect(SECRET_NAME_SCHEMA.safeParse(name).success).toBe(true);
  });

  it.each([
    "",
    "lowercase",
    "1LEADING_DIGIT",
    "HAS SPACE",
    "DASH-NO",
    "X".repeat(65),
    "unicode→key",
  ])("rejects %s", (name) => {
    expect(SECRET_NAME_SCHEMA.safeParse(name).success).toBe(false);
  });
});

describe("redactSecrets", () => {
  const secrets = [
    { name: "NPM_TOKEN", value: "npat_abc123def456" },
    { name: "API_KEY", value: "sk-live-9876543210xyz" },
  ];

  it("replaces a plain occurrence with the name marker", () => {
    expect(redactSecrets("token is npat_abc123def456 ok", secrets)).toBe(
      `token is ${secretRedactionMarker("NPM_TOKEN")} ok`,
    );
  });

  it("replaces every occurrence, not just the first", () => {
    expect(redactSecrets("a npat_abc123def456 b npat_abc123def456", secrets)).toBe(
      `a ${secretRedactionMarker("NPM_TOKEN")} b ${secretRedactionMarker("NPM_TOKEN")}`,
    );
  });

  it("is case-sensitive (a different-case copy is left alone)", () => {
    expect(redactSecrets("NPAT_ABC123DEF456 stays", secrets)).toBe("NPAT_ABC123DEF456 stays");
  });

  it("catches values inside quoted and JSON-shaped text", () => {
    const text = `config = "npat_abc123def456"; {"token":"npat_abc123def456"}`;
    expect(redactSecrets(text, secrets)).not.toContain("npat_abc123def456");
    expect(redactSecrets(text, secrets)).toContain(secretRedactionMarker("NPM_TOKEN"));
  });

  it("redacts overlapping values longest-first", () => {
    const overlapping = [
      { name: "LONG", value: "secret-token-value-1" },
      { name: "SHORT", value: "secret-token" },
    ];
    expect(redactSecrets("found secret-token-value-1 here", overlapping)).toBe(
      "found ***LONG*** here",
    );
    // The shorter value alone still redacts when the longer one is absent.
    expect(redactSecrets("found secret-token here", overlapping)).toBe("found ***SHORT*** here");
  });

  it("skips empty and short (<4 char) values so nothing over-redacts", () => {
    const risky = [
      { name: "EMPTY", value: "" },
      { name: "TINY", value: "ab" },
      { name: "THREE", value: "abc" },
      { name: "FOUR", value: "abcd" },
    ];
    expect(redactSecrets("abc abc ab abcd", risky)).toBe(
      `abc abc ab ${secretRedactionMarker("FOUR")}`,
    );
    expect(MIN_SECRET_REDACTION_LENGTH).toBe(4);
  });

  it("returns the input untouched when no secrets are configured", () => {
    expect(redactSecrets("npat_abc123def456", [])).toBe("npat_abc123def456");
  });
});

describe("redactJson", () => {
  const secrets = [{ name: "NPM_TOKEN", value: "npat_abc123def456" }];

  it("redacts strings nested inside objects and arrays", () => {
    const payload = {
      type: "message-delta",
      seq: 7,
      delta: "publishing with npat_abc123def456",
      nested: { toolOutput: ["auth=npat_abc123def456", 42, null, true] },
    };
    const out = redactJson(payload, secrets) as typeof payload;
    expect(out.delta).toBe(`publishing with ${secretRedactionMarker("NPM_TOKEN")}`);
    expect(out.nested.toolOutput[0]).toBe(`auth=${secretRedactionMarker("NPM_TOKEN")}`);
    expect(out.nested.toolOutput[1]).toBe(42);
    expect(out.nested.toolOutput[2]).toBeNull();
    expect(out.seq).toBe(7);
  });

  it("never touches structural keys (event type survives even on collision)", () => {
    const awkward = [{ name: "STATUS", value: "success" }];
    const payload = { type: "run.status", status: "success", output: "result: success" };
    const out = redactJson(payload, awkward) as typeof payload;
    expect(out.type).toBe("run.status");
    expect(out.status).toBe("success");
    expect(out.output).toBe("result: ***STATUS***");
  });

  it("does not mutate the input payload", () => {
    const payload = { delta: "npat_abc123def456" };
    redactJson(payload, secrets);
    expect(payload.delta).toBe("npat_abc123def456");
  });

  it("passes primitives through", () => {
    expect(redactJson(5, secrets)).toBe(5);
    expect(redactJson(null, secrets)).toBeNull();
    expect(redactJson(undefined, secrets)).toBeUndefined();
  });
});
