"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useModalBehavior } from "./dialog";
import { cn } from "@/lib/cn";

/**
 * Right-side panel drawer (issue #50) — node/edge inspectors will use it.
 * Same focus-trap/Escape/overlay semantics as Dialog, docked to the right.
 */
export function Drawer({
  open,
  onClose,
  label,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const { containerRef, onKeyDown } = useModalBehavior(open, onClose);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/60" onClick={onClose}>
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        className={cn(
          "absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto border-l border-border bg-surface p-5 shadow-3 outline-none",
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
