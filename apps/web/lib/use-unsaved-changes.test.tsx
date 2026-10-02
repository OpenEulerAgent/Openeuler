// @vitest-environment jsdom
//
// Route-exit unsaved-changes guard (#67): pure click decision, the popstate
// guard state machine, and the hook's jsdom wiring (anchor clicks, Back
// presses against a spec-faithful history model, palette navigation,
// fragment navigation, listener cleanup).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dialog, type DialogProps } from "@/components/ui/dialog";
import { ToastProvider } from "@/components/ui/toast";
import { CommandPalette } from "@/components/shell/CommandPalette";
import {
  differsOnlyByFragment,
  UNSAVED_GUARD_STATE_KEY,
  guardReducer,
  initialGuardState,
  isGuardHistoryState,
  navigateWithGuard,
  shouldInterceptClick,
  useUnsavedChanges,
  type GuardState,
} from "@/lib/use-unsaved-changes";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const routerMock = vi.hoisted(() => ({
  pushes: [] as string[],
  push(href: string): void {
    routerMock.pushes.push(href);
  },
}));

vi.mock("next/navigation", () => {
  const router = { push: routerMock.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
  return {
    useRouter: () => router,
    usePathname: () => "/projects/p1/workflows/w1/edit",
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, apiFetch: async () => ({ projects: [], runs: [] }) };
});

const ORIGIN = "http://localhost:3000";

const anchorWith = (attrs: Record<string, string>): HTMLAnchorElement => {
  const anchor = document.createElement("a");
  for (const [name, value] of Object.entries(attrs)) anchor.setAttribute(name, value);
  return anchor;
};

// ---------------------------------------------------------------------------

describe("shouldInterceptClick (pure decision)", () => {
  const intercept = (input: Partial<Parameters<typeof shouldInterceptClick>[0]>, dirty = true) =>
    shouldInterceptClick({ target: anchorWith({ href: "/runs" }), ...input }, dirty, ORIGIN);

  it("intercepts internal links while dirty", () => {
    expect(intercept({})).toBe("/runs");
    expect(intercept({ target: anchorWith({ href: "/projects/p1?tab=x#top" }) })).toBe(
      "/projects/p1?tab=x#top",
    );
  });

  it("intercepts a click on a child element of an anchor", () => {
    const span = document.createElement("span");
    anchorWith({ href: "/runs" }).append(span);
    expect(intercept({ target: span })).toBe("/runs");
  });

  it("allows absolute same-origin hrefs", () => {
    expect(intercept({ target: anchorWith({ href: `${ORIGIN}/runs` }) })).toBe(
      `${ORIGIN}/runs`,
    );
  });

  it("never intercepts a clean editor", () => {
    expect(intercept({}, false)).toBeNull();
  });

  it("ignores external links", () => {
    expect(intercept({ target: anchorWith({ href: "https://example.com/away" }) })).toBeNull();
    expect(intercept({ target: anchorWith({ href: "//example.com/away" }) })).toBeNull();
    expect(intercept({ target: anchorWith({ href: "mailto:a@b.c" }) })).toBeNull();
  });

  it("ignores new-tab targets, downloads, and hash links", () => {
    expect(intercept({ target: anchorWith({ href: "/runs", target: "_blank" }) })).toBeNull();
    expect(intercept({ target: anchorWith({ href: "/runs", target: "_top" }) })).toBeNull();
    expect(intercept({ target: anchorWith({ href: "/runs", download: "doc.txt" }) })).toBeNull();
    expect(intercept({ target: anchorWith({ href: "#top" }) })).toBeNull();
    expect(intercept({ target: anchorWith({ href: "" }) })).toBeNull();
    expect(intercept({ target: anchorWith({ href: "/runs", target: "_self" }) })).toBe("/runs");
  });

  it("ignores modifier clicks and non-primary buttons", () => {
    expect(intercept({ metaKey: true })).toBeNull();
    expect(intercept({ ctrlKey: true })).toBeNull();
    expect(intercept({ shiftKey: true })).toBeNull();
    expect(intercept({ altKey: true })).toBeNull();
    expect(intercept({ button: 1 })).toBeNull();
    expect(intercept({ button: 0 })).toBe("/runs");
  });

  it("ignores non-anchor targets and already-prevented events", () => {
    expect(intercept({ target: document.createElement("button") })).toBeNull();
    expect(intercept({ target: null })).toBeNull();
    expect(intercept({ target: document.body })).toBeNull();
    expect(intercept({ defaultPrevented: true })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("differsOnlyByFragment (pure decision)", () => {
  it("flags fragment-only differences", () => {
    expect(differsOnlyByFragment(`${ORIGIN}/edit`, `${ORIGIN}/edit#node-1`)).toBe(true);
    expect(differsOnlyByFragment(`${ORIGIN}/edit#node-1`, `${ORIGIN}/edit#node-2`)).toBe(true);
  });

  it("passes identical URLs, route changes, and search changes through", () => {
    expect(differsOnlyByFragment(`${ORIGIN}/edit`, `${ORIGIN}/edit`)).toBe(false);
    expect(differsOnlyByFragment(`${ORIGIN}/edit`, `${ORIGIN}/runs`)).toBe(false);
    expect(differsOnlyByFragment(`${ORIGIN}/edit?a=1`, `${ORIGIN}/edit?a=2`)).toBe(false);
    expect(differsOnlyByFragment(`${ORIGIN}/edit`, `https://elsewhere.org/edit#x`)).toBe(false);
    expect(differsOnlyByFragment(null, `${ORIGIN}/edit`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("guardReducer (popstate flow state machine)", () => {
  const engaged: GuardState = guardReducer(initialGuardState, { type: "engage" }).state;

  it("engages once, pushing a single dummy history entry", () => {
    const first = guardReducer(initialGuardState, { type: "engage" });
    expect(first.state).toEqual({ ...initialGuardState, engaged: true });
    expect(first.effects).toEqual([{ kind: "push-dummy" }]);
    const again = guardReducer(first.state, { type: "engage" });
    expect(again.effects).toEqual([]);
  });

  it("popstate: re-pins and asks; stay keeps the user pinned on the page", () => {
    const popped = guardReducer(engaged, { type: "popstate" });
    expect(popped.state.confirm).toEqual({ kind: "back" });
    expect(popped.effects).toEqual([{ kind: "push-dummy" }]);

    const stayed = guardReducer(popped.state, { type: "stay" });
    expect(stayed.state.confirm).toBeNull();

    const repop = guardReducer(stayed.state, { type: "popstate" });
    expect(repop.state.confirm).toEqual({ kind: "back" });
    expect(repop.effects).toEqual([{ kind: "push-dummy" }]);
  });

  it("popstate while the dialog is open keeps re-pinning without duplicating prompts", () => {
    const popped = guardReducer(engaged, { type: "popstate" });
    const poppedAgain = guardReducer(popped.state, { type: "popstate" });
    expect(poppedAgain.state.confirm).toEqual({ kind: "back" });
    expect(poppedAgain.effects).toEqual([{ kind: "push-dummy" }]);
  });

  it("fragment-only popstate re-pins silently without prompting", () => {
    const frag = guardReducer(engaged, { type: "popstate", fragmentOnly: true });
    expect(frag.state.confirm).toBeNull();
    expect(frag.effects).toEqual([{ kind: "absorb-pin" }]);

    const clicked = guardReducer(engaged, { type: "click", href: "/runs" });
    const fragWhileOpen = guardReducer(clicked.state, { type: "popstate", fragmentOnly: true });
    expect(fragWhileOpen.state.confirm).toEqual({ kind: "link", href: "/runs" });
    expect(fragWhileOpen.effects).toEqual([{ kind: "absorb-pin" }]);
  });

  it("proceed on back traverses with the fixed two-entry depth and ignores its popstate", () => {
    const stayed = guardReducer(guardReducer(engaged, { type: "popstate" }).state, {
      type: "stay",
    });
    const popped = guardReducer(stayed.state, { type: "popstate" });
    const proceeded = guardReducer(popped.state, { type: "proceed" });
    expect(proceeded.effects).toEqual([{ kind: "navigate-back" }]);
    expect(proceeded.state.traversing).toBe(true);

    const landed = guardReducer(proceeded.state, { type: "popstate" });
    expect(landed.effects).toEqual([]);
    expect(landed.state.traversing).toBe(false);
  });

  it("link clicks and programmatic leaves open the dialog and proceed by navigating", () => {
    const clicked = guardReducer(engaged, { type: "click", href: "/runs" });
    expect(clicked.state.confirm).toEqual({ kind: "link", href: "/runs" });
    const nav = guardReducer(clicked.state, { type: "proceed" });
    expect(nav.effects).toEqual([{ kind: "navigate", href: "/runs" }]);

    const asked = guardReducer(engaged, { type: "programmatic" });
    expect(asked.state.confirm).toEqual({ kind: "programmatic" });
    const ran = guardReducer(asked.state, { type: "proceed" });
    expect(ran.effects).toEqual([{ kind: "run-programmatic" }]);
  });

  it("ignores new intents while a confirm is pending", () => {
    const clicked = guardReducer(engaged, { type: "click", href: "/runs" });
    const other = guardReducer(clicked.state, { type: "click", href: "/settings" });
    expect(other.state.confirm).toEqual({ kind: "link", href: "/runs" });
    const prog = guardReducer(clicked.state, { type: "programmatic" });
    expect(prog.state.confirm).toEqual({ kind: "link", href: "/runs" });
  });

  it("disengaging consumes the top dummy entry and resets", () => {
    const popped = guardReducer(engaged, { type: "popstate" });
    const done = guardReducer(popped.state, { type: "disengage", onDummyEntry: true });
    expect(done.state).toEqual(initialGuardState);
    expect(done.effects).toEqual([{ kind: "consume-dummy" }]);
    const offPage = guardReducer(popped.state, { type: "disengage", onDummyEntry: false });
    expect(offPage.effects).toEqual([]);
    const noop = guardReducer(initialGuardState, { type: "disengage", onDummyEntry: true });
    expect(noop.effects).toEqual([]);
  });

  it("ignores popstate while disengaged", () => {
    const off = guardReducer(initialGuardState, { type: "popstate" });
    expect(off.effects).toEqual([]);
    expect(off.state).toEqual(initialGuardState);
  });
});

// ---------------------------------------------------------------------------
// Hook wiring (jsdom + act) against a spec-faithful history model.

/**
 * Spec-faithful session-history simulator (#67 QA): an entries array + a
 * cursor. `pushState` truncates every forward entry; `go` clamps at index 0
 * (an out-of-range traverse is a no-op) and fires `popstate` on the window
 * only when the cursor actually moves; `pushState`/`replaceState` never
 * fire it. jsdom's own traversal is not spec-faithful (`back()` is a no-op,
 * `go(delta)` moves a single step), so the wiring tests drive this model —
 * only `location`/`history.state` syncing still leans on jsdom's real
 * pushState/replaceState.
 */
interface SimEntry {
  url: string;
  state: unknown;
}

class SpecHistory {
  entries: SimEntry[] = [];
  cursor = 0;

  constructor(
    private realPushState: (state: unknown, unused: string, url: string | null) => void,
    private realReplaceState: (state: unknown, unused: string, url: string | null) => void,
  ) {}

  get url(): string {
    return this.entries[this.cursor]?.url ?? "";
  }

  push(state: unknown, url: string): void {
    this.entries.splice(this.cursor + 1);
    this.entries.push({ url, state });
    this.cursor = this.entries.length - 1;
    this.realPushState(state, "", url);
  }

  replace(state: unknown, url: string): void {
    this.entries[this.cursor] = { url, state };
    this.realReplaceState(state, "", url);
  }

  go(delta: number): void {
    const target = Math.max(0, Math.min(this.cursor + delta, this.entries.length - 1));
    if (target === this.cursor) return;
    const entry = this.entries[target];
    if (entry === undefined) return;
    this.cursor = target;
    this.realReplaceState(entry.state, "", entry.url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: entry.state }));
  }
}

interface MountResult {
  container: HTMLElement;
  rerender: (dirty: boolean) => void;
  unmount: () => void;
}

function GuardHost({ dirty, basePath }: { dirty: boolean; basePath: string }) {
  const guard = useUnsavedChanges(dirty);
  return createElement(
    "div",
    null,
    createElement("a", { href: "/runs" }, "Runs"),
    createElement("a", { href: "https://example.com/away" }, "Away"),
    createElement(
      "button",
      { type: "button", onClick: () => guard.requestLeave(() => routerMock.push(basePath)) },
      "Back",
    ),
    createElement(
      Dialog,
      { open: guard.confirmOpen, onClose: guard.stay, label: "Unsaved changes" } as DialogProps,
      createElement("button", { key: "keep", type: "button", onClick: guard.stay }, "Keep editing"),
      createElement(
        "button",
        { key: "discard", type: "button", onClick: guard.proceed },
        "Discard and leave",
      ),
    ),
  );
}

const roots: MountResult[] = [];
const extraTeardown: Array<() => void> = [];

const mount = (dirty: boolean): MountResult => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(createElement(GuardHost, { dirty, basePath: "/back-path" }));
  });
  const result: MountResult = {
    container,
    rerender: (next: boolean) => {
      act(() => {
        root.render(createElement(GuardHost, { dirty: next, basePath: "/back-path" }));
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

/** Mount an arbitrary element outside the GuardHost shape (palette tests). */
const mountRaw = (element: ReactElement): void => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(element);
  });
  extraTeardown.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
};

const click = (element: Element, init: MouseEventInit = {}): MouseEvent => {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
};

const dialog = (): Element | null =>
  document.querySelector('[role="dialog"][aria-label="Unsaved changes"]');

const dialogButton = (label: string): HTMLButtonElement => {
  const button = [...dialog()?.querySelectorAll("button") ?? []].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`dialog button not found: ${label}`);
  return button as HTMLButtonElement;
};

const firePopstate = (state: unknown = undefined): void => {
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
};

describe("useUnsavedChanges (hook wiring)", () => {
  let pushSpy: ReturnType<typeof vi.spyOn>;
  let backSpy: ReturnType<typeof vi.spyOn>;
  let goSpy: ReturnType<typeof vi.spyOn>;
  let sim: SpecHistory;
  let realPushState: (state: unknown, unused: string, url: string | null) => void;
  let realReplaceState: (state: unknown, unused: string, url: string | null) => void;

  const resolveUrl = (url: string | URL | null | undefined): string => {
    if (url instanceof URL) return url.href;
    return url === null || url === undefined
      ? window.location.href
      : new URL(url, window.location.href).href;
  };

  const startAt = (path: string): void => {
    sim.entries = [{ url: `${ORIGIN}${path}`, state: null }];
    sim.cursor = 0;
    realReplaceState(null, "", `${ORIGIN}${path}`);
  };

  /** App navigation (what the router's push does to the session history). */
  const navigate = (path: string): void => {
    act(() => {
      window.history.pushState(null, "", path);
    });
  };

  /** A real Back press: the cursor moves and popstate fires. */
  const goBack = (): void => {
    act(() => {
      sim.go(-1);
    });
  };

  /** Same-document fragment navigation (hash link): push + popstate. */
  const fragmentNavigate = (hash: string): void => {
    act(() => {
      window.history.pushState(null, "", hash);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
  };

  beforeEach(() => {
    routerMock.pushes = [];
    realPushState = window.history.pushState.bind(window.history);
    realReplaceState = window.history.replaceState.bind(window.history);
    sim = new SpecHistory(realPushState, realReplaceState);
    pushSpy = vi.spyOn(window.history, "pushState").mockImplementation((state, _, url) => {
      sim.push(state, resolveUrl(url));
    });
    vi.spyOn(window.history, "replaceState").mockImplementation((state, _, url) => {
      sim.replace(state, resolveUrl(url));
    });
    backSpy = vi.spyOn(window.history, "back").mockImplementation(() => sim.go(-1));
    goSpy = vi.spyOn(window.history, "go").mockImplementation((delta) => sim.go(delta ?? 0));
    startAt("/list");
  });

  afterEach(() => {
    while (extraTeardown.length > 0) extraTeardown.pop()?.();
    while (roots.length > 0) roots.pop()?.unmount();
    vi.restoreAllMocks();
  });

  // -- spec-model back-depth accounting (#67 QA blocker) -------------------

  it("back: discard lands on the previous route — not stuck, not overshooting", () => {
    startAt("/home");
    navigate("/list");
    navigate("/edit");
    mount(true);
    goBack();
    expect(dialog()).not.toBeNull();
    click(dialogButton("Discard and leave"));
    expect(goSpy).toHaveBeenCalledWith(-2);
    expect(sim.cursor).toBe(1);
    expect(sim.url).toBe(`${ORIGIN}/list`);
    expect(dialog()).toBeNull();
    expect(routerMock.pushes).toEqual([]);
  });

  it("back: list → edit alone still lands on list with the fixed depth", () => {
    navigate("/edit");
    mount(true);
    goBack();
    click(dialogButton("Discard and leave"));
    expect(sim.cursor).toBe(0);
    expect(sim.url).toBe(`${ORIGIN}/list`);
  });

  it("repeated Backs while the dialog is open stay guarded on the edit route", () => {
    navigate("/edit");
    mount(true);
    goBack();
    goBack();
    goBack();
    expect(dialog()).not.toBeNull();
    expect(sim.url).toBe(`${ORIGIN}/edit`);
    expect(isGuardHistoryState(window.history.state)).toBe(true);
    click(dialogButton("Discard and leave"));
    expect(sim.url).toBe(`${ORIGIN}/list`);
  });

  it("back: cancel keeps the user on edit with the dummy re-pinned", () => {
    navigate("/edit");
    mount(true);
    goBack();
    click(dialogButton("Keep editing"));
    expect(dialog()).toBeNull();
    expect(sim.url).toBe(`${ORIGIN}/edit`);
    expect(isGuardHistoryState(window.history.state)).toBe(true);
    goBack();
    expect(dialog()).not.toBeNull();
  });

  // -- fragment navigation (#67 QA minor) -----------------------------------

  it("fragment navigation re-pins silently without a false-positive dialog", () => {
    navigate("/edit");
    mount(true);
    fragmentNavigate("#node-1");
    expect(dialog()).toBeNull();
    expect(sim.url).toBe(`${ORIGIN}/edit#node-1`);
    expect(isGuardHistoryState(window.history.state)).toBe(true);
    // Hash churn is undone silently: the first Back collapses the stale
    // pre-fragment pin (landing on a guard-marked entry)…
    goBack();
    expect(dialog()).toBeNull();
    expect(sim.url).toBe(`${ORIGIN}/edit`);
    // …but leaving the document still asks, from a renormalized stack.
    goBack();
    expect(dialog()).not.toBeNull();
  });

  it("popstate onto one of our pinned dummy entries re-pins without prompting", () => {
    navigate("/edit");
    mount(true);
    firePopstate(window.history.state);
    expect(dialog()).toBeNull();
    // Absorbed via replaceState: exactly the two pushes so far (the app's
    // navigation + the engage pin), no third entry.
    expect(pushSpy).toHaveBeenCalledTimes(2);
    expect(isGuardHistoryState(window.history.state)).toBe(true);
  });

  // -- original wiring ------------------------------------------------------

  it("dirty editor: internal anchor click shows the dialog and defers navigation", () => {
    const view = mount(true);
    expect(isGuardHistoryState(window.history.state)).toBe(true);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    const event = click(view.container.querySelector('a[href="/runs"]') as Element);
    expect(event.defaultPrevented).toBe(true);
    expect(dialog()).not.toBeNull();
    expect(routerMock.pushes).toEqual([]);

    click(dialogButton("Discard and leave"));
    expect(routerMock.pushes).toEqual(["/runs"]);
    expect(dialog()).toBeNull();
  });

  it("intercepted clicks do not suppress sibling click listeners", () => {
    const view = mount(true);
    let documentClicks = 0;
    let anchorClicks = 0;
    const onDocumentClick = (): void => {
      documentClicks += 1;
    };
    const anchor = view.container.querySelector('a[href="/runs"]') as HTMLAnchorElement;
    const onAnchorClick = (): void => {
      anchorClicks += 1;
    };
    document.addEventListener("click", onDocumentClick);
    anchor.addEventListener("click", onAnchorClick);
    try {
      const event = click(anchor);
      expect(event.defaultPrevented).toBe(true);
      expect(dialog()).not.toBeNull();
      expect(documentClicks).toBe(1);
      expect(anchorClicks).toBe(1);
    } finally {
      document.removeEventListener("click", onDocumentClick);
      anchor.removeEventListener("click", onAnchorClick);
    }
  });

  it("dirty editor: external links are not intercepted", () => {
    const view = mount(true);
    const event = click(view.container.querySelector('a[href="https://example.com/away"]') as Element);
    expect(event.defaultPrevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("clean editor: no interception, no dialog, no dummy state", () => {
    const view = mount(false);
    expect(pushSpy).not.toHaveBeenCalled();

    const event = click(view.container.querySelector('a[href="/runs"]') as Element);
    expect(event.defaultPrevented).toBe(false);
    expect(dialog()).toBeNull();

    click(view.container.querySelector("button") as Element);
    expect(routerMock.pushes).toEqual(["/back-path"]);
    expect(dialog()).toBeNull();
  });

  it("popstate: cancel stays on the page with the dummy state re-pushed", () => {
    mount(true);
    firePopstate();
    expect(dialog()).not.toBeNull();
    expect(pushSpy).toHaveBeenCalledTimes(2);
    expect(isGuardHistoryState(window.history.state)).toBe(true);

    click(dialogButton("Keep editing"));
    expect(dialog()).toBeNull();
    expect(isGuardHistoryState(window.history.state)).toBe(true);

    firePopstate();
    expect(dialog()).not.toBeNull();
    expect(pushSpy).toHaveBeenCalledTimes(3);
  });

  it("popstate: confirm traverses back with the fixed two-entry depth", () => {
    mount(true);
    firePopstate();
    click(dialogButton("Keep editing"));
    firePopstate();
    click(dialogButton("Discard and leave"));
    expect(goSpy).toHaveBeenCalledWith(-2);
    expect(dialog()).toBeNull();
    expect(routerMock.pushes).toEqual([]);
  });

  it("guarded programmatic leave shares the same confirm flow", () => {
    const view = mount(true);
    click([...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Back",
    ) as Element);
    expect(dialog()).not.toBeNull();
    expect(routerMock.pushes).toEqual([]);

    click(dialogButton("Discard and leave"));
    expect(routerMock.pushes).toEqual(["/back-path"]);
  });

  it("confirmed link leave keeps the dummy one Back away from the destination", () => {
    // Documented tradeoff (hook docblock): the confirmed link leave pushes
    // without consuming the dummy, so the destination has one extra Back
    // into a stale (now unguarded) mirror of the left page.
    navigate("/edit");
    const view = mount(true);
    click(view.container.querySelector('a[href="/runs"]') as Element);
    click(dialogButton("Discard and leave"));
    expect(routerMock.pushes).toEqual(["/runs"]);
    navigate("/runs");
    view.unmount();
    goBack();
    expect(sim.url).toBe(`${ORIGIN}/edit`);
    expect(dialog()).toBeNull();
  });

  // -- programmatic navigation API (palette wiring) --------------------------

  it("navigateWithGuard defers to the confirm flow while a guard is engaged", () => {
    navigate("/edit");
    mount(true);
    act(() => {
      navigateWithGuard(() => routerMock.push("/runs"));
    });
    expect(dialog()).not.toBeNull();
    expect(routerMock.pushes).toEqual([]);
    click(dialogButton("Discard and leave"));
    expect(routerMock.pushes).toEqual(["/runs"]);
  });

  it("navigateWithGuard runs immediately with no guard or a clean guard", () => {
    act(() => {
      navigateWithGuard(() => routerMock.push("/dashboard"));
    });
    expect(routerMock.pushes).toEqual(["/dashboard"]);

    mount(false);
    act(() => {
      navigateWithGuard(() => routerMock.push("/projects"));
    });
    expect(routerMock.pushes).toEqual(["/dashboard", "/projects"]);
    expect(dialog()).toBeNull();
  });

  it("⌘K palette navigation opens the guard dialog instead of discarding edits", async () => {
    navigate("/edit");
    mount(true);
    await act(async () => {
      mountRaw(
        createElement(
          ToastProvider,
          null,
          createElement(CommandPalette, { open: true, onClose: () => {} }),
        ),
      );
    });
    const input = document.querySelector('[role="combobox"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(dialog()).not.toBeNull();
    expect(routerMock.pushes).toEqual([]);

    click(dialogButton("Discard and leave"));
    expect(routerMock.pushes).toEqual(["/projects"]);
    expect(dialog()).toBeNull();
  });

  it("beforeunload prompts only while dirty", () => {
    const view = mount(true);
    const blocked = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);

    view.rerender(false);
    const allowed = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(allowed);
    expect(allowed.defaultPrevented).toBe(false);
  });

  it("cleans up listeners when dirty flips false and on unmount", () => {
    const view = mount(true);
    view.rerender(false);
    expect(backSpy).toHaveBeenCalledTimes(1);

    const event = click(view.container.querySelector('a[href="/runs"]') as Element);
    expect(event.defaultPrevented).toBe(false);
    expect(dialog()).toBeNull();

    const pushesAfterClean = pushSpy.mock.calls.length;
    firePopstate();
    expect(pushSpy.mock.calls.length).toBe(pushesAfterClean);
    expect(dialog()).toBeNull();

    view.rerender(true);
    firePopstate();
    expect(dialog()).not.toBeNull();
    const pushesWhileDirty = pushSpy.mock.calls.length;
    view.unmount();
    firePopstate();
    expect(pushSpy.mock.calls.length).toBe(pushesWhileDirty);
    expect(dialog()).toBeNull();
  });

  it("uses the guard state key without clobbering existing history state", () => {
    window.history.replaceState({ nextKey: "abc" }, "", window.location.href);
    mount(true);
    expect(isGuardHistoryState(window.history.state)).toBe(true);
    expect((window.history.state as Record<string, unknown>)["nextKey"]).toBe("abc");
    expect((window.history.state as Record<string, unknown>)[UNSAVED_GUARD_STATE_KEY]).toBe(true);
  });
});
