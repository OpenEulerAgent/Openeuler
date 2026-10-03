// @vitest-environment jsdom
//
// Crash card (#96): the error-boundary harness proves the card renders as a
// fallback under a throwing child and that Retry (reset + router.refresh)
// remounts the segment; the copy-diagnostics tests pin the report shape
// (route, timestamp, health snapshot, user agent, digest, stack tail ≤15).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, Component, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HealthState } from "@/lib/health";

const routerMock = vi.hoisted(() => ({
  refreshes: 0,
  refresh(): void {
    this.refreshes += 1;
  },
}));

const healthMock = vi.hoisted(() => ({
  state: { status: "healthy", version: "1.4.2", uptime: 42 } as HealthState,
}));

const clipboardMock = vi.hoisted(() => ({ text: "", writes: 0, fail: false }));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/health", () => ({
  fetchHealth: async () => healthMock.state,
}));

import {
  buildDiagnostics,
  CrashCard,
  formatHealthState,
  stackTail,
  STACK_TAIL_LINES,
} from "./CrashCard.js";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

// ---------------------------------------------------------------------------
// Rendering harness (matches the repo's createRoot/act convention).

interface MountResult {
  container: HTMLElement;
  rerender: (element: ReactElement) => void;
  unmount: () => void;
}

const roots: MountResult[] = [];

const mount = (element: ReactElement): MountResult => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(element);
  });
  const result: MountResult = {
    container,
    rerender: (next) => {
      act(() => {
        root.render(next);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      const index = roots.indexOf(result);
      if (index !== -1) roots.splice(index, 1);
    },
  };
  roots.push(result);
  return result;
};

const buttonByName = (view: MountResult, name: string): HTMLButtonElement => {
  const button = [...view.container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );
  if (button === undefined) throw new Error(`No button labeled ${name}`);
  return button;
};

// ---------------------------------------------------------------------------
// Error-boundary harness: the minimal Next-style boundary — children, or the
// fallback (with a reset that clears the caught error, remounting them).

interface CatchBoundaryProps {
  children?: ReactNode;
  fallback: (error: Error, reset: () => void) => ReactNode;
}

class CatchBoundary extends Component<CatchBoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    return this.state.error === null
      ? this.props.children
      : this.props.fallback(this.state.error, this.reset);
  }
}

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("kaboom: render exploded");
  return <p data-testid="recovered">Recovered</p>;
}

const crashFallback = (error: Error, reset: () => void): ReactElement =>
  createElement(CrashCard, { error, reset });

// ---------------------------------------------------------------------------

let consoleError: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  routerMock.refreshes = 0;
  healthMock.state = { status: "healthy", version: "1.4.2", uptime: 42 };
  clipboardMock.text = "";
  clipboardMock.writes = 0;
  clipboardMock.fail = false;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string): Promise<void> => {
        clipboardMock.writes += 1;
        if (clipboardMock.fail) throw new Error("clipboard denied");
        clipboardMock.text = text;
      },
    },
  });
  // React logs every caught render error; the boundary tests throw on purpose.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  while (roots.length > 0) roots.pop()?.unmount();
  consoleError?.mockRestore();
  window.history.pushState({}, "", "/");
});

// ---------------------------------------------------------------------------

describe("stackTail", () => {
  it("keeps short stacks verbatim", () => {
    const stack = "Error: x\n    at a\n    at b";
    expect(stackTail(stack)).toBe(stack);
  });

  it("caps at the last 15 lines with an omission notice", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `    at frame${index}`);
    const result = stackTail(lines.join("\n"));
    const body = result.split("\n").filter((line) => !line.startsWith("…"));
    expect(body).toHaveLength(STACK_TAIL_LINES);
    expect(result).toContain("25 earlier lines omitted");
    expect(body.at(-1)).toContain("frame39");
  });

  it("degrades gracefully without a stack", () => {
    expect(stackTail(null)).toBe("(no stack available)");
    expect(stackTail(undefined)).toBe("(no stack available)");
    expect(stackTail("")).toBe("(no stack available)");
  });
});

describe("formatHealthState", () => {
  it("renders healthy with version and uptime", () => {
    expect(formatHealthState({ status: "healthy", version: "1.4.2", uptime: 42 })).toBe(
      "healthy (v1.4.2, up 42s)",
    );
  });

  it("omits uptime when auth hides it and spells out degradation", () => {
    expect(formatHealthState({ status: "healthy", version: "9.0.0" })).toBe("healthy (v9.0.0)");
    expect(formatHealthState({ status: "degraded", message: "daemon down" })).toBe(
      "degraded — daemon down",
    );
    expect(formatHealthState({ status: "checking" })).toBe("checking");
  });
});

describe("buildDiagnostics", () => {
  it("assembles every labeled line (digest only when present)", () => {
    const withDigest = buildDiagnostics({
      route: "/runs/r1",
      timestamp: "2026-10-03T10:00:00.000Z",
      health: "healthy (v1.4.2, up 42s)",
      userAgent: "jsdom-agent",
      name: "TypeError",
      message: "boom",
      digest: "abc123",
      stack: "TypeError: boom\n    at f",
    });
    expect(withDigest).toBe(
      [
        "Openeuler crash report",
        "Route: /runs/r1",
        "Time: 2026-10-03T10:00:00.000Z",
        "Error: TypeError: boom",
        "Digest: abc123",
        "Health: healthy (v1.4.2, up 42s)",
        "User agent: jsdom-agent",
        "Stack (last 15 lines):",
        "TypeError: boom",
        "    at f",
      ].join("\n"),
    );

    const withoutDigest = buildDiagnostics({
      route: "/",
      timestamp: "2026-10-03T10:00:00.000Z",
      health: "degraded — daemon down",
      userAgent: "ua",
      name: "Error",
      message: "x",
      stack: null,
    });
    expect(withoutDigest).not.toContain("Digest:");
    expect(withoutDigest).toContain("(no stack available)");
  });
});

describe("CrashCard as an error-boundary fallback", () => {
  it("renders the crash card when a child render throws", () => {
    const view = mount(
      createElement(
        CatchBoundary,
        { fallback: crashFallback },
        createElement(Bomb, { shouldThrow: true }),
      ),
    );
    const card = view.container.querySelector('[data-testid="crash-card"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute("role")).toBe("alert");
    expect(card?.textContent).toContain("Something went wrong");
    // Dev detail (NODE_ENV=test !== "production"): name + message inline.
    expect(card?.textContent).toContain("Error: kaboom: render exploded");
    view.unmount();
  });

  it("Retry refreshes the router and remounts the crashed segment", () => {
    const element = (shouldThrow: boolean): ReactElement =>
      createElement(
        CatchBoundary,
        { fallback: crashFallback },
        createElement(Bomb, { shouldThrow }),
      );
    const view = mount(element(true));
    expect(view.container.querySelector('[data-testid="crash-card"]')).not.toBeNull();

    // A re-render with healthy children must NOT retry them until reset —
    // the boundary still shows the card.
    view.rerender(element(false));
    expect(view.container.querySelector('[data-testid="crash-card"]')).not.toBeNull();

    act(() => {
      buttonByName(view, "Retry").click();
    });

    expect(routerMock.refreshes).toBe(1);
    expect(view.container.querySelector('[data-testid="recovered"]')?.textContent).toBe(
      "Recovered",
    );
    view.unmount();
  });
});

describe("CrashCard copy diagnostics", () => {
  const longStack = ["Error: kaboom", ...Array.from({ length: 30 }, (_, i) => `    at f${i}`)].join(
    "\n",
  );

  const renderCard = (error: Error): MountResult =>
    mount(createElement(CrashCard, { error, reset: () => {} }));

  it("copies route + timestamp + health + user agent + stack tail", async () => {
    window.history.pushState({}, "", "/runs/run-9");
    const error = new Error("kaboom");
    error.stack = longStack;
    const view = renderCard(error);

    await act(async () => {
      buttonByName(view, "Copy diagnostics").click();
    });

    expect(clipboardMock.writes).toBe(1);
    const text = clipboardMock.text;
    expect(text).toContain("Route: /runs/run-9");
    expect(text).toMatch(/^Time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/m);
    expect(text).toContain("Error: Error: kaboom");
    expect(text).toContain("Health: healthy (v1.4.2, up 42s)");
    expect(text).toContain(`User agent: ${navigator.userAgent}`);
    expect(text).toContain("Stack (last 15 lines):");
    const stackSection = text.split("Stack (last 15 lines):\n")[1] ?? "";
    const stackBody = stackSection.split("\n").filter((line) => !line.startsWith("…"));
    expect(stackBody).toHaveLength(STACK_TAIL_LINES);
    expect(stackBody.at(-1)).toContain("at f29");
    expect(buttonByName(view, "Diagnostics copied")).toBeTruthy();
    view.unmount();
  });

  it("includes the digest when the framework attached one", async () => {
    window.history.pushState({}, "", "/settings");
    const error = Object.assign(new Error("d"), { digest: "deadbeef" }) as Error & {
      digest?: string;
    };
    const view = renderCard(error);

    await act(async () => {
      buttonByName(view, "Copy diagnostics").click();
    });

    expect(clipboardMock.text).toContain("Digest: deadbeef");
    view.unmount();
  });

  it("reports a degraded daemon instead of throwing", async () => {
    healthMock.state = { status: "degraded", message: "Could not reach daemon" };
    const view = renderCard(new Error("x"));

    await act(async () => {
      buttonByName(view, "Copy diagnostics").click();
    });

    expect(clipboardMock.text).toContain("Health: degraded — Could not reach daemon");
    expect(buttonByName(view, "Diagnostics copied")).toBeTruthy();
    view.unmount();
  });

  it("surfaces Copy failed when the clipboard rejects", async () => {
    clipboardMock.fail = true;
    const view = renderCard(new Error("x"));

    await act(async () => {
      buttonByName(view, "Copy diagnostics").click();
    });

    expect(clipboardMock.writes).toBe(1);
    expect(clipboardMock.text).toBe("");
    expect(buttonByName(view, "Copy failed")).toBeTruthy();
    view.unmount();
  });

  it("offers a Go home link", () => {
    const view = renderCard(new Error("x"));
    const home = view.container.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(home?.textContent).toContain("Go home");
    view.unmount();
  });
});
