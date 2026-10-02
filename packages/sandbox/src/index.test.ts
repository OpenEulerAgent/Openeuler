import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, SandboxError } from "./index.js";
import {
  createFakeSandboxProvider,
  createSandboxProviderRegistry,
  getSandboxProvider,
  listSandboxProviders,
  registerSandboxProvider,
} from "./index.js";

describe(PACKAGE_NAME, () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@openeuler/sandbox");
  });

  it("exports the public contract", () => {
    expect(typeof createSandboxProviderRegistry).toBe("function");
    expect(typeof createFakeSandboxProvider).toBe("function");
    expect(typeof registerSandboxProvider).toBe("function");
    expect(typeof getSandboxProvider).toBe("function");
    expect(typeof listSandboxProviders).toBe("function");
    expect(new SandboxError("SANDBOX_UNAVAILABLE", "down")).toBeInstanceOf(Error);
  });
});
