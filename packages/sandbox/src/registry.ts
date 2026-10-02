import { SandboxError } from "./error.js";
import type { SandboxProvider } from "./types.js";

/** Registry of available {@link SandboxProvider}s. The daemon composes one at boot. */
export interface SandboxProviderRegistry {
  /** Register a provider. Throws `SandboxError` (`SANDBOX_ALREADY_REGISTERED`) on duplicate ids. */
  registerSandboxProvider(provider: SandboxProvider): void;
  /** Look up a provider by id. Throws `SandboxError` (`SANDBOX_PROVIDER_NOT_FOUND`) for unknown ids. */
  getSandboxProvider(id: string): SandboxProvider;
  /** All registered providers, in registration order. */
  listSandboxProviders(): SandboxProvider[];
}

/** Create an independent sandbox provider registry. */
export function createSandboxProviderRegistry(): SandboxProviderRegistry {
  const providers = new Map<string, SandboxProvider>();
  return {
    registerSandboxProvider(provider: SandboxProvider): void {
      if (providers.has(provider.id)) {
        throw new SandboxError(
          "SANDBOX_ALREADY_REGISTERED",
          `sandbox provider "${provider.id}" is already registered`,
        );
      }
      providers.set(provider.id, provider);
    },
    getSandboxProvider(id: string): SandboxProvider {
      const provider = providers.get(id);
      if (provider === undefined) {
        throw new SandboxError(
          "SANDBOX_PROVIDER_NOT_FOUND",
          `no sandbox provider registered with id "${id}"`,
        );
      }
      return provider;
    },
    listSandboxProviders(): SandboxProvider[] {
      return [...providers.values()];
    },
  };
}

/** Process-wide default registry, used by the standalone helpers below. */
export const defaultSandboxProviderRegistry: SandboxProviderRegistry =
  createSandboxProviderRegistry();

/** Register a provider on the default registry. */
export function registerSandboxProvider(provider: SandboxProvider): void {
  defaultSandboxProviderRegistry.registerSandboxProvider(provider);
}

/** Look up a provider on the default registry. */
export function getSandboxProvider(id: string): SandboxProvider {
  return defaultSandboxProviderRegistry.getSandboxProvider(id);
}

/** List providers on the default registry, in registration order. */
export function listSandboxProviders(): SandboxProvider[] {
  return defaultSandboxProviderRegistry.listSandboxProviders();
}
