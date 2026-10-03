import { describe, expect, it } from "vitest";
import {
  __clearPendingRetry,
  notifyUnauthorized,
  onUnauthorized,
  setPendingRetry,
  takePendingRetry,
} from "./auth-gate";

describe("auth-gate hub (#92)", () => {
  it("notifies subscribers on 401 and stops after unsubscribe", () => {
    const calls: number[] = [];
    const a = (): void => {
      calls.push(1);
    };
    const stopB = onUnauthorized(() => {
      throw new Error("one throwing listener must not starve the others");
    });
    const stopA = onUnauthorized(a);

    notifyUnauthorized();
    expect(calls).toEqual([1]);

    stopA();
    stopB();
    notifyUnauthorized();
    expect(calls).toEqual([1]);
  });

  it("hands the pending retry to exactly one taker", async () => {
    __clearPendingRetry();
    expect(takePendingRetry()).toBeNull();

    let ran = 0;
    setPendingRetry(async () => {
      ran += 1;
    });
    const retry = takePendingRetry();
    expect(retry).not.toBeNull();
    // A newer 401 overwrites the older retry.
    setPendingRetry(async () => {
      ran += 10;
    });
    setPendingRetry(async () => {
      ran += 100;
    });
    const latest = takePendingRetry();
    await latest?.();
    expect(ran).toBe(100);
    expect(takePendingRetry()).toBeNull();
    __clearPendingRetry();
  });
});
