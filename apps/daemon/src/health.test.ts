import { describe, expect, it } from "vitest";
import { healthPayload } from "./health.js";
import { getVersion } from "./version.js";

describe("@openeuler/daemon", () => {
  it("health payload reports ok with version and uptime", () => {
    expect(healthPayload()).toEqual({
      ok: true,
      version: getVersion(),
      uptime: expect.any(Number),
    });
  });
});
