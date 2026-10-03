import { describe, expect, it, vi } from "vitest";
import { SandboxError } from "./error.js";
import { createSandboxProviderRegistry } from "./registry.js";
import type { SandboxProvider } from "./types.js";

function stubProvider(id: string): SandboxProvider {
  return {
    id,
    create: () => {
      throw new Error("not implemented");
    },
    list: () => {
      throw new Error("not implemented");
    },
  };
}

describe("createSandboxProviderRegistry", () => {
  it("registers and looks up providers", () => {
    const registry = createSandboxProviderRegistry();
    const fake = stubProvider("fake");
    registry.registerSandboxProvider(fake);
    expect(registry.getSandboxProvider("fake")).toBe(fake);
  });

  it("lists providers in registration order", () => {
    const registry = createSandboxProviderRegistry();
    const first = stubProvider("first");
    const second = stubProvider("second");
    registry.registerSandboxProvider(first);
    registry.registerSandboxProvider(second);
    expect(registry.listSandboxProviders()).toEqual([first, second]);
    // The returned list is a copy; mutating it must not affect the registry.
    registry.listSandboxProviders().pop();
    expect(registry.listSandboxProviders()).toEqual([first, second]);
  });

  it("starts empty", () => {
    expect(createSandboxProviderRegistry().listSandboxProviders()).toEqual([]);
  });

  it("rejects duplicate ids with a typed SandboxError", () => {
    const registry = createSandboxProviderRegistry();
    registry.registerSandboxProvider(stubProvider("docker"));
    let caught: unknown;
    try {
      registry.registerSandboxProvider(stubProvider("docker"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ code: "SANDBOX_ALREADY_REGISTERED" });
    expect((caught as SandboxError).message).toContain("docker");
    // The original provider stays registered.
    expect(registry.getSandboxProvider("docker").id).toBe("docker");
    expect(registry.listSandboxProviders().length).toBe(1);
  });

  it("throws a typed SandboxError for unknown ids", () => {
    const registry = createSandboxProviderRegistry();
    let caught: unknown;
    try {
      registry.getSandboxProvider("does-not-exist");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect(caught).toMatchObject({ code: "SANDBOX_PROVIDER_NOT_FOUND" });
    expect((caught as SandboxError).message).toContain("does-not-exist");
  });
});

describe("default registry helpers", () => {
  it("registerSandboxProvider/getSandboxProvider/listSandboxProviders share a default registry", async () => {
    vi.resetModules();
    const registry = await import("./registry.js");
    const provider = stubProvider("default-registry-test");
    registry.registerSandboxProvider(provider);
    expect(registry.getSandboxProvider("default-registry-test")).toBe(provider);
    expect(registry.listSandboxProviders().map((entry) => entry.id)).toContain(
      "default-registry-test",
    );
    expect(
      registry.defaultSandboxProviderRegistry.getSandboxProvider("default-registry-test"),
    ).toBe(provider);

    let caught: unknown;
    try {
      registry.registerSandboxProvider(stubProvider("default-registry-test"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "SANDBOX_ALREADY_REGISTERED" });
  });
});
