"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export const UNSAVED_GUARD_STATE_KEY = "__unsavedChangesGuard";

export function isGuardHistoryState(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as Record<string, unknown>)[UNSAVED_GUARD_STATE_KEY] === true
  );
}

/**
 * True when two URLs are identical except for the fragment — the signature
 * of a same-document hash navigation, which must not trip the back-guard.
 * Identical URLs (a Back onto the mirrored dummy entry) return false.
 */
export function differsOnlyByFragment(before: string | null, after: string): boolean {
  if (before === null || before === after) return false;
  try {
    const from = new URL(before);
    const to = new URL(after);
    return (
      from.origin === to.origin &&
      from.pathname === to.pathname &&
      from.search === to.search &&
      from.hash !== to.hash
    );
  } catch {
    return false;
  }
}

export interface ClickGuardInput {
  target: EventTarget | null;
  button?: number;
  defaultPrevented?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export function shouldInterceptClick(
  input: ClickGuardInput,
  dirty: boolean,
  origin: string,
): string | null {
  if (!dirty) return null;
  if (input.defaultPrevented) return null;
  if (input.metaKey || input.ctrlKey || input.shiftKey || input.altKey) return null;
  if (input.button !== undefined && input.button !== 0) return null;
  if (typeof Element === "undefined" || !(input.target instanceof Element)) return null;
  const anchor = input.target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.target !== "" && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;
  const href = anchor.getAttribute("href");
  if (href === null || href === "" || href.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return href;
}

export type GuardPending =
  | { kind: "back" }
  | { kind: "link"; href: string }
  | { kind: "programmatic" };

export type GuardEvent =
  | { type: "engage" }
  | { type: "disengage"; onDummyEntry: boolean }
  | { type: "popstate"; fragmentOnly?: boolean }
  | { type: "click"; href: string }
  | { type: "programmatic" }
  | { type: "stay" }
  | { type: "proceed" };

export type GuardEffect =
  | { kind: "push-dummy" }
  | { kind: "absorb-pin" }
  | { kind: "consume-dummy" }
  | { kind: "navigate-back" }
  | { kind: "navigate"; href: string }
  | { kind: "run-programmatic" };

export interface GuardState {
  engaged: boolean;
  confirm: GuardPending | null;
  traversing: boolean;
}

export const initialGuardState: GuardState = {
  engaged: false,
  confirm: null,
  traversing: false,
};

export function guardReducer(
  state: GuardState,
  event: GuardEvent,
): { state: GuardState; effects: GuardEffect[] } {
  switch (event.type) {
    case "engage": {
      if (state.engaged) return { state, effects: [] };
      return {
        state: { ...state, engaged: true },
        effects: [{ kind: "push-dummy" }],
      };
    }
    case "disengage": {
      if (!state.engaged) return { state, effects: [] };
      const effects: GuardEffect[] = [];
      if (event.onDummyEntry) effects.push({ kind: "consume-dummy" });
      return { state: initialGuardState, effects };
    }
    case "popstate": {
      if (!state.engaged) return { state, effects: [] };
      if (state.traversing) return { state: { ...state, traversing: false }, effects: [] };
      // Fragment churn absorbs the landed-on entry instead of growing the
      // stack, so the dialog (and its fixed back depth) only ever opens
      // from the renormalized `[previous, current, dummy]` position.
      if (event.fragmentOnly) return { state, effects: [{ kind: "absorb-pin" }] };
      if (state.confirm !== null) return { state, effects: [{ kind: "push-dummy" }] };
      return {
        state: { ...state, confirm: { kind: "back" } },
        effects: [{ kind: "push-dummy" }],
      };
    }
    case "click": {
      if (!state.engaged || state.confirm !== null) return { state, effects: [] };
      return {
        state: { ...state, confirm: { kind: "link", href: event.href } },
        effects: [],
      };
    }
    case "programmatic": {
      if (!state.engaged || state.confirm !== null) return { state, effects: [] };
      return {
        state: { ...state, confirm: { kind: "programmatic" } },
        effects: [],
      };
    }
    case "stay": {
      if (state.confirm === null) return { state, effects: [] };
      return { state: { ...state, confirm: null }, effects: [] };
    }
    case "proceed": {
      const pending = state.confirm;
      if (pending === null) return { state, effects: [] };
      if (pending.kind === "back") {
        return {
          state: { ...state, confirm: null, traversing: true },
          effects: [{ kind: "navigate-back" }],
        };
      }
      if (pending.kind === "link") {
        return {
          state: { ...state, confirm: null },
          effects: [{ kind: "navigate", href: pending.href }],
        };
      }
      return {
        state: { ...state, confirm: null },
        effects: [{ kind: "run-programmatic" }],
      };
    }
  }
}

export interface UnsavedChangesGuard {
  confirmOpen: boolean;
  pending: GuardPending | null;
  stay: () => void;
  proceed: () => void;
  requestLeave: (navigate: () => void) => void;
}

/** The leave request of the most recently mounted guard, if any. */
let activeRequestLeave: ((navigate: () => void) => void) | null = null;

/**
 * Programmatic navigation shared by shell chrome (the ⌘K command palette):
 * when an unsaved-changes guard is mounted, the navigation goes through its
 * confirm flow; with no guard mounted (clean pages) it runs immediately.
 */
export function navigateWithGuard(navigate: () => void): void {
  if (activeRequestLeave === null) {
    navigate();
    return;
  }
  activeRequestLeave(navigate);
}

/**
 * Route-exit guard (#67): while `dirty`, intercepts client-side navigation
 * (browser Back via a pinned dummy history entry, internal anchor clicks,
 * and programmatic leaves through {@link navigateWithGuard} /
 * {@link UnsavedChangesGuard.requestLeave}) and routes it through a confirm
 * dialog; `beforeunload` covers real document unloads.
 *
 * History accounting: engaging pushes exactly one dummy entry on top of the
 * current entry (pushState inherently truncates any forward history — the
 * user loses the forward stack while guarded). Every Back-triggered
 * popstate re-pins the dummy (truncate + push), so when the confirm dialog
 * opens the stack tail is invariantly `[previous, current, dummy]` with the
 * cursor on the dummy — a confirmed Back leave is therefore always a fixed
 * `history.go(-2)` (dummy → current → previous), never a counted depth.
 * Same-document fragment navigation never prompts: its popstate is
 * recognized by state/URL and the landed-on entry is absorbed into the pin
 * via replaceState (no stack growth); Back presses that undo hash churn
 * collapse those stale pins silently, and the first Back onto the real
 * current entry re-normalizes the stack and asks. Fragment churn under the
 * open modal dialog is unreachable (the dialog traps all interaction).
 *
 * Tradeoff: a confirmed link/programmatic leave simply `router.push`es, so
 * the pinned dummy (mirroring the current URL) stays one Back press away
 * from the destination — the user can return to the (now clean) page once.
 * Consuming it first would need an async go-back-then-push dance around the
 * router; accepted cost, asserted as expected behavior in the tests.
 */
export function useUnsavedChanges(dirty: boolean): UnsavedChangesGuard {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const stateRef = useRef<GuardState>(initialGuardState);
  const programmaticRef = useRef<(() => void) | null>(null);
  const pinnedUrlRef = useRef<string | null>(null);
  const [pending, setPending] = useState<GuardPending | null>(null);

  const perform = useCallback((effect: GuardEffect) => {
    switch (effect.kind) {
      case "push-dummy":
        window.history.pushState(
          {
            ...(window.history.state as Record<string, unknown> | null),
            [UNSAVED_GUARD_STATE_KEY]: true,
          },
          "",
          window.location.href,
        );
        pinnedUrlRef.current = window.location.href;
        break;
      case "absorb-pin":
        // Fragment churn: mark the entry the cursor landed on (the
        // same-document fragment entry, or a stale pin) as the new pin —
        // no stack growth, no dialog.
        window.history.replaceState(
          {
            ...(window.history.state as Record<string, unknown> | null),
            [UNSAVED_GUARD_STATE_KEY]: true,
          },
          "",
          window.location.href,
        );
        pinnedUrlRef.current = window.location.href;
        break;
      case "consume-dummy":
        window.history.back();
        break;
      case "navigate-back":
        // Fixed depth: the cursor sits on the pinned dummy directly above
        // the current entry, so -2 crosses dummy + current and lands on
        // the previous route (see the hook docblock).
        window.history.go(-2);
        break;
      case "navigate": {
        const url = new URL(effect.href, window.location.origin);
        routerRef.current.push(url.pathname + url.search + url.hash);
        break;
      }
      case "run-programmatic":
        programmaticRef.current?.();
        programmaticRef.current = null;
        break;
    }
  }, []);

  const run = useCallback((event: GuardEvent) => {
    const transition = guardReducer(stateRef.current, event);
    stateRef.current = transition.state;
    setPending(transition.state.confirm);
    for (const effect of transition.effects) perform(effect);
  }, [perform]);

  const stay = useCallback(() => run({ type: "stay" }), [run]);

  const proceed = useCallback(() => run({ type: "proceed" }), [run]);

  const requestLeave = useCallback(
    (navigate: () => void) => {
      if (!stateRef.current.engaged) {
        navigate();
        return;
      }
      programmaticRef.current = navigate;
      run({ type: "programmatic" });
    },
    [run],
  );

  // Publish the guard for shell-level programmatic navigation (⌘K palette).
  useEffect(() => {
    activeRequestLeave = requestLeave;
    return () => {
      if (activeRequestLeave === requestLeave) activeRequestLeave = null;
    };
  }, [requestLeave]);

  useEffect(() => {
    if (!dirty) return undefined;
    const onClick = (event: MouseEvent): void => {
      const href = shouldInterceptClick(event, true, window.location.origin);
      if (href === null) return;
      // preventDefault alone stops next/link (it bails on defaultPrevented)
      // while letting other capture/bubble click listeners still run.
      event.preventDefault();
      if (stateRef.current.confirm === null) run({ type: "click", href });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty, run]);

  useEffect(() => {
    if (!dirty) return undefined;
    const onPopstate = (event: PopStateEvent): void => {
      // Same-document fragment navigation (or landing back on one of our
      // pinned entries): re-pin silently instead of prompting.
      const fragmentOnly =
        isGuardHistoryState(event.state) ||
        differsOnlyByFragment(pinnedUrlRef.current, window.location.href);
      run({ type: "popstate", fragmentOnly });
    };
    window.addEventListener("popstate", onPopstate);
    return () => window.removeEventListener("popstate", onPopstate);
  }, [dirty, run]);

  useEffect(() => {
    if (!dirty) return undefined;
    run({ type: "engage" });
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      run({ type: "disengage", onDummyEntry: isGuardHistoryState(window.history.state) });
    };
  }, [dirty, run]);

  return {
    confirmOpen: pending !== null,
    pending,
    stay,
    proceed,
    requestLeave,
  };
}
