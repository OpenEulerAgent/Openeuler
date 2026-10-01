"use client";

import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FOCUSABLE_SELECTOR, nextFocusTarget } from "@/lib/focus-trap";
import { cn } from "@/lib/cn";

/**
 * Shared overlay behavior for modal primitives (Dialog/Drawer, issue #50):
 * portal render, Escape to close, focus trap (Tab cycles inside), initial
 * focus, focus restoration, and body scroll lock.
 */
export function useModalBehavior(
  open: boolean,
  onClose: () => void,
): {
  containerRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const scrollbarWasLocked = document.body.style.overflow === "hidden";
    document.body.style.overflow = "hidden";
    const container = containerRef.current;
    if (container) {
      const focusables = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      (focusables[0] ?? container).focus();
    }
    return () => {
      if (!scrollbarWasLocked) document.body.style.overflow = "";
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) return;
      const next = nextFocusTarget(focusables, document.activeElement, event.shiftKey);
      if (next) {
        event.preventDefault();
        next.focus();
      }
    },
    [onClose],
  );

  return { containerRef, onKeyDown };
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Elements rendered inside the overlay, before the panel (e.g. portal guard). */
  label: string;
  className?: string;
  children: ReactNode;
}

/**
 * Centered modal dialog: focus-trapped, Escape-closable, overlay-click
 * closable. Rendered in a portal so it stacks above the app shell.
 */
export function Dialog({ open, onClose, label, className, children }: DialogProps) {
  const { containerRef, onKeyDown } = useModalBehavior(open, onClose);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        className={cn(
          "w-full max-w-lg rounded-xl border border-border bg-surface p-5 shadow-3 outline-none",
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
