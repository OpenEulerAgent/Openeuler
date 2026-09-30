import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, ping } from "./index.js";

describe(PACKAGE_NAME, () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@openeuler/core");
  });

  it("ping responds with pong", () => {
    expect(ping()).toBe("pong");
  });
});
