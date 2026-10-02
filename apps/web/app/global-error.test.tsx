// @vitest-environment jsdom
//
// global-error.tsx (#96): renders standalone — its own <html>/<body>, no
// shell, no provider, no global CSS — and its Retry both resets the boundary
// and force-reloads. Rendered into document.documentElement like Next does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import GlobalError from "./global-error.js";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

describe("GlobalError (standalone root failure card)", () => {
  let root: Root;
  let originalDocument: string;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalDocument = document.documentElement.outerHTML;
    root = createRoot(document.documentElement);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    // createRoot into <html> replaces its children; restore the jsdom shell.
    document.documentElement.innerHTML = originalDocument
      .replace(/^<html[^>]*>/, "")
      .replace(/<\/html>$/, "");
    consoleError.mockRestore();
  });

  const render = (error: Error & { digest?: string }): void => {
    act(() => {
      root.render(<GlobalError error={error} reset={() => {}} />);
    });
  };

  it("renders its own html/body with no app shell", () => {
    render(new Error("shell died"));
    expect(document.documentElement.querySelector("main[role='alert']")?.textContent).toContain(
      "Something went wrong",
    );
    // Dev detail (NODE_ENV=test): the error itself.
    expect(document.body.textContent).toContain("Error: shell died");
    // Standalone means no shell chrome, no nav/sidebar landmarks.
    expect(document.documentElement.outerHTML).not.toContain("AppShell");
    expect(document.querySelectorAll("nav, aside")).toHaveLength(0);
  });

  it("Retry resets the boundary and reloads the page", () => {
    const reset = vi.fn();
    const reload = vi.fn();
    // jsdom's Location#reload is non-configurable; swap the whole location.
    const originalLocation = window.location;
    delete (window as { location?: Location }).location;
    (window as { location: Location }).location = { ...originalLocation, reload };

    act(() => {
      root.render(<GlobalError error={new Error("x")} reset={reset} />);
    });
    const retry = [...document.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    expect(retry).toBeDefined();
    act(() => {
      retry?.click();
    });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);

    delete (window as { location?: Location }).location;
    (window as { location: Location }).location = originalLocation;
  });

  it("links home", () => {
    render(new Error("x"));
    const home = document.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(home?.textContent).toContain("Go home");
  });
});
