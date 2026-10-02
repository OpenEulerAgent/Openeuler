// @vitest-environment jsdom
//
// TokenGate flow (#92): renders on a 401 notification, stores the entered
// token, retries the failed action and heals (reload) on success; keeps the
// card open (token cleared) when the daemon rejects again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TokenGate } from "./TokenGate";
import { ApiError } from "@/lib/api";
import { __clearPendingRetry, notifyUnauthorized, setPendingRetry } from "@/lib/auth-gate";
import { clearStoredToken, getStoredToken } from "@/lib/token";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (reload: () => void): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(createElement(TokenGate, { reload })));
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const setInputValue = (value: string): void => {
  const input = document.querySelector("input");
  if (!input) throw new Error("token input not rendered");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const submit = (): void => {
  const form = document.querySelector("form");
  if (!form) throw new Error("form not rendered");
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
};

const text = (): string => document.body.textContent ?? "";

const retries: number[] = [];

beforeEach(() => {
  window.localStorage.clear();
  __clearPendingRetry();
  retries.length = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  clearStoredToken();
});

describe("TokenGate (#92)", () => {
  it("renders nothing until a 401 arrives, then shows the dialog", () => {
    const reload = vi.fn();
    render(reload);

    expect(document.querySelector('[role="dialog"]')).toBeNull();

    act(() => notifyUnauthorized());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(text()).toContain("Daemon token required");
  });

  it("saves the token, retries the failed action and reloads on success", async () => {
    const reload = vi.fn();
    render(reload);
    act(() => notifyUnauthorized());

    setPendingRetry(async () => {
      retries.push(1);
    });
    setInputValue(" good-token ");
    submit();
    await settle();

    expect(getStoredToken()).toBe("good-token");
    expect(retries).toEqual([1]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("stays open, clears the token and shows an error when the retry 401s again", async () => {
    const reload = vi.fn();
    render(reload);
    act(() => notifyUnauthorized());

    setPendingRetry(async () => {
      retries.push(1);
      throw new ApiError("UNAUTHORIZED", "missing or invalid bearer token", 401);
    });
    setInputValue("bad-token");
    submit();
    await settle();

    expect(getStoredToken()).toBeNull();
    expect(text()).toContain("rejected this token");
    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(retries).toEqual([1]);
  });

  it("heals globally (reload, no throw) when the retry fails for a non-auth reason", async () => {
    const reload = vi.fn();
    render(reload);
    act(() => notifyUnauthorized());

    setPendingRetry(async () => {
      throw new ApiError("NETWORK_ERROR", "daemon down", 0);
    });
    setInputValue("likely-good-token");
    submit();
    await settle();

    expect(getStoredToken()).toBe("likely-good-token");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty submission without storing anything", async () => {
    const reload = vi.fn();
    render(reload);
    act(() => notifyUnauthorized());

    setInputValue("   ");
    submit();
    await settle();

    expect(getStoredToken()).toBeNull();
    expect(text()).toContain("Enter the daemon token");
    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("can be dismissed without clearing an already-stored token", () => {
    const reload = vi.fn();
    render(reload);
    act(() => notifyUnauthorized());

    const dismiss = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Not now",
    );
    expect(dismiss).toBeDefined();
    act(() => dismiss?.click());

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});
