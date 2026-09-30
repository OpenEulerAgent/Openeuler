import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";
import { createShutdownRegistry } from "./shutdown.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const build = (exit: (code: number) => void = vi.fn()) =>
  createShutdownRegistry({ exit, logger: createLogger("silent") });

describe("createShutdownRegistry", () => {
  it("runs hooks LIFO, waiting for async hooks, then exits 0", async () => {
    const exit = vi.fn();
    const order: string[] = [];
    const { onShutdown, handleShutdown } = build(exit);

    onShutdown(async () => {
      await delay(15);
      order.push("first");
    }, "first");
    onShutdown(() => {
      order.push("second");
    }, "second");
    onShutdown(async () => {
      order.push("third");
      await delay(5);
    }, "third");

    await handleShutdown("SIGTERM");

    expect(order).toEqual(["third", "second", "first"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("logs hook errors and keeps going (not fatal)", async () => {
    const exit = vi.fn();
    const ranAfter: boolean[] = [];
    const { onShutdown, handleShutdown } = build(exit);

    onShutdown(() => {
      throw new Error("hook blew up");
    }, "bad");
    onShutdown(() => {
      ranAfter.push(true);
    }, "good");

    await handleShutdown("SIGINT");

    expect(ranAfter).toEqual([true]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("abandons a hook that exceeds its timeout and still exits 0", async () => {
    const exit = vi.fn();
    const { onShutdown, handleShutdown } = createShutdownRegistry({
      exit,
      logger: createLogger("silent"),
      hookTimeoutMs: 30,
    });

    let hookFinished = false;
    onShutdown(async () => {
      await delay(200);
      hookFinished = true;
    }, "slow");

    const start = Date.now();
    await handleShutdown("SIGTERM");

    expect(Date.now() - start).toBeLessThan(150);
    expect(hookFinished).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("ignores a second shutdown trigger while already shutting down", async () => {
    const exit = vi.fn();
    const { onShutdown, handleShutdown } = build(exit);
    onShutdown(() => undefined, "noop");

    await handleShutdown("SIGTERM");
    await handleShutdown("SIGTERM");

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("works with zero registered hooks", async () => {
    const exit = vi.fn();
    const { handleShutdown } = build(exit);
    await handleShutdown("SIGTERM");
    expect(exit).toHaveBeenCalledWith(0);
  });
});
