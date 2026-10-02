// @vitest-environment jsdom
//
// Route-exit unsaved-changes guard (#67): pure click decision, the popstate
// guard state machine, and the hook's jsdom wiring (anchor clicks, Back
// presses, listener cleanup).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dialog } from "@/components/ui/dialog";
import {
  UNSAVED_GUARD_STATE_KEY,
  guardReducer,
  initialGuardState,
  isGuardHistoryState,
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
  return { useRouter: () => router };
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

describe("guardReducer (popstate flow state machine)", () => {
  const engaged: GuardState = guardReducer(initialGuardState, { type: "engage" }).state;

  it("engages once, pushing a single dummy history entry", () => {
    const first = guardReducer(initialGuardState, { type: "engage" });
    expect(first.state).toEqual({ ...initialGuardState, engaged: true, dummies: 1 });
    expect(first.effects).toEqual([{ kind: "push-dummy" }]);
    const again = guardReducer(first.state, { type: "engage" });
    expect(again.effects).toEqual([]);
  });

  it("popstate: re-pins and asks; stay keeps the user pinned on the page", () => {
    const popped = guardReducer(engaged, { type: "popstate" });
    expect(popped.state.dummies).toBe(2);
    expect(popped.state.confirm).toEqual({ kind: "back" });
    expect(popped.effects).toEqual([{ kind: "push-dummy" }]);

    const stayed = guardReducer(popped.state, { type: "stay" });
    expect(stayed.state.confirm).toBeNull();
    expect(stayed.state.dummies).toBe(2);

    const repop = guardReducer(stayed.state, { type: "popstate" });
    expect(repop.state.confirm).toEqual({ kind: "back" });
    expect(repop.state.dummies).toBe(3);
    expect(repop.effects).toEqual([{ kind: "push-dummy" }]);
  });

  it("popstate while the dialog is open keeps re-pinning without duplicating prompts", () => {
    const popped = guardReducer(engaged, { type: "popstate" });
    const poppedAgain = guardReducer(popped.state, { type: "popstate" });
    expect(poppedAgain.state.confirm).toEqual({ kind: "back" });
    expect(poppedAgain.effects).toEqual([{ kind: "push-dummy" }]);
  });

  it("proceed on back traverses past every dummy entry and ignores its popstate", () => {
    const stayed = guardReducer(guardReducer(engaged, { type: "popstate" }).state, {
      type: "stay",
    });
    const popped = guardReducer(stayed.state, { type: "popstate" });
    const proceeded = guardReducer(popped.state, { type: "proceed" });
    expect(proceeded.effects).toEqual([{ kind: "navigate-back", depth: popped.state.dummies + 1 }]);
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
// Hook wiring (jsdom + act).

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
      { open: guard.confirmOpen, onClose: guard.stay, label: "Unsaved changes" },
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

const click = (element: Element, init: MouseEventInit = {}): MouseEvent => {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
};

const dialog = (): Element | null => document.querySelector('[role="dialog"]');

const dialogButton = (label: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll('[role="dialog"] button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`dialog button not found: ${label}`);
  return button as HTMLButtonElement;
};

const firePopstate = (): void => {
  act(() => {
    window.dispatchEvent(new Event("popstate"));
  });
};

describe("useUnsavedChanges (hook wiring)", () => {
  let pushSpy: ReturnType<typeof vi.spyOn>;
  let backSpy: ReturnType<typeof vi.spyOn>;
  let goSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    routerMock.pushes = [];
    pushSpy = vi.spyOn(window.history, "pushState");
    backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    goSpy = vi.spyOn(window.history, "go").mockImplementation(() => {});
  });

  afterEach(() => {
    while (roots.length > 0) roots.pop()?.unmount();
    vi.restoreAllMocks();
  });

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

  it("popstate: confirm traverses back past the dummy entries", () => {
    mount(true);
    firePopstate();
    click(dialogButton("Keep editing"));
    firePopstate();
    click(dialogButton("Discard and leave"));
    expect(goSpy).toHaveBeenCalledWith(-4);
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
