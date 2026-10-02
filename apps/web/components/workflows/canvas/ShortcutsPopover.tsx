"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Small help popover documenting the canvas keyboard shortcuts (#46).
 * Toggled by the "?" toolbar button; closes on outside click / Escape.
 */
export function ShortcutsPopover({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        aria-label="Keyboard shortcuts"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex size-8 items-center justify-center rounded-md border border-border bg-surface text-sm font-semibold text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        ?
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          className="absolute top-10 right-0 z-30 w-64 rounded-lg border border-border bg-surface p-3 shadow-3"
        >
          <p className="text-sm font-medium text-fg">Keyboard shortcuts</p>
          <dl className="mt-2 flex flex-col gap-1.5 text-xs text-muted-fg">
            {SHORTCUTS.map((shortcut) => (
              <div key={shortcut.keys} className="flex items-center justify-between gap-3">
                <dt>
                  <kbd className="rounded border border-border bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-fg">
                    {shortcut.keys}
                  </kbd>
                </dt>
                <dd className="text-right">{shortcut.action}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

const SHORTCUTS: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: "⌘/Ctrl + S", action: "Save (new revision)" },
  { keys: "⌘/Ctrl + Z", action: "Undo" },
  { keys: "⇧⌘/Ctrl + Z", action: "Redo" },
  { keys: "Delete / Backspace", action: "Delete selection" },
  { keys: "Space + drag", action: "Pan the canvas" },
  { keys: "Scroll", action: "Pan · ⌘/Ctrl + scroll zooms" },
  { keys: "Shift + click", action: "Add to selection" },
  { keys: "Esc", action: "Leave area selection" },
  { keys: "Drag from handle", action: "Connect nodes" },
];
