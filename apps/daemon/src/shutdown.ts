import type { Logger } from "./logger.js";

export type ShutdownHook = () => void | Promise<void>;

export interface ShutdownRegistry {
  onShutdown(hook: ShutdownHook, name?: string): void;
  handleShutdown(signal?: string): Promise<void>;
}

export interface ShutdownRegistryOptions {
  logger?: Logger;
  /** Per-hook timeout in milliseconds; a hook exceeding it is abandoned (error logged, not fatal). */
  hookTimeoutMs?: number;
  /** Exit strategy, injectable for tests. Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

interface RegisteredHook {
  name: string;
  fn: ShutdownHook;
}

const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

export function createShutdownRegistry(options: ShutdownRegistryOptions = {}): ShutdownRegistry {
  const logger = options.logger;
  const timeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const hooks: RegisteredHook[] = [];
  let shuttingDown = false;

  function onShutdown(hook: ShutdownHook, name?: string): void {
    const registered: RegisteredHook = { name: name ?? `hook-${hooks.length + 1}`, fn: hook };
    hooks.push(registered);
    logger?.debug({ hook: registered.name }, "shutdown hook registered");
  }

  async function runHook(hook: RegisteredHook, signal: string): Promise<void> {
    try {
      await Promise.race([
        Promise.resolve(hook.fn()),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`shutdown hook "${hook.name}" timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timer.unref();
        }),
      ]);
      logger?.info({ hook: hook.name }, "shutdown hook complete");
    } catch (err) {
      logger?.error({ hook: hook.name, signal, err }, "shutdown hook failed (continuing)");
    }
  }

  async function handleShutdown(signal = "SIGTERM"): Promise<void> {
    if (shuttingDown) {
      logger?.warn({ signal }, "shutdown already in progress, ignoring signal");
      return;
    }
    shuttingDown = true;
    logger?.info({ signal, hooks: hooks.length }, "graceful shutdown started");
    for (const hook of [...hooks].reverse()) {
      await runHook(hook, signal);
    }
    logger?.info({ signal }, "graceful shutdown complete");
    exit(0);
  }

  return { onShutdown, handleShutdown };
}
