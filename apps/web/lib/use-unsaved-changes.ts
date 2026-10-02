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
  | { type: "popstate" }
  | { type: "click"; href: string }
  | { type: "programmatic" }
  | { type: "stay" }
  | { type: "proceed" };

export type GuardEffect =
  | { kind: "push-dummy" }
  | { kind: "consume-dummy" }
  | { kind: "navigate-back"; depth: number }
  | { kind: "navigate"; href: string }
  | { kind: "run-programmatic" };

export interface GuardState {
  engaged: boolean;
  confirm: GuardPending | null;
  dummies: number;
  traversing: boolean;
}

export const initialGuardState: GuardState = {
  engaged: false,
  confirm: null,
  dummies: 0,
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
        state: { ...state, engaged: true, dummies: 1 },
        effects: [{ kind: "push-dummy" }],
      };
    }
    case "disengage": {
      if (!state.engaged) return { state, effects: [] };
      const effects: GuardEffect[] = [];
      if (event.onDummyEntry) effects.push({ kind: "consume-dummy" });
      return {
        state: { engaged: false, confirm: null, dummies: 0, traversing: false },
        effects,
      };
    }
    case "popstate": {
      if (!state.engaged) return { state, effects: [] };
      if (state.traversing) return { state: { ...state, traversing: false }, effects: [] };
      const dummies = state.dummies + 1;
      if (state.confirm !== null) {
        return { state: { ...state, dummies }, effects: [{ kind: "push-dummy" }] };
      }
      return {
        state: { ...state, dummies, confirm: { kind: "back" } },
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
          effects: [{ kind: "navigate-back", depth: state.dummies + 1 }],
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

export function useUnsavedChanges(dirty: boolean): UnsavedChangesGuard {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const stateRef = useRef<GuardState>(initialGuardState);
  const programmaticRef = useRef<(() => void) | null>(null);
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
        break;
      case "consume-dummy":
        window.history.back();
        break;
      case "navigate-back":
        window.history.go(-effect.depth);
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

  useEffect(() => {
    if (!dirty) return undefined;
    const onClick = (event: MouseEvent): void => {
      const href = shouldInterceptClick(event, true, window.location.origin);
      if (href === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (stateRef.current.confirm === null) run({ type: "click", href });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty, run]);

  useEffect(() => {
    if (!dirty) return undefined;
    const onPopstate = (): void => {
      run({ type: "popstate" });
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
