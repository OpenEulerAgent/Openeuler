import { describe, expect, it } from "vitest";
import { healthPayload } from "./health.js";

describe("@openeuler/daemon", () => {
  it("health payload reports ok", () => {
    expect(healthPayload()).toEqual({ ok: true, service: "@openeuler/daemon" });
  });
});
