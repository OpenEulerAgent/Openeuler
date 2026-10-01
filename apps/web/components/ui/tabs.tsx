"use client";

import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Tabs primitive (issue #50): controlled roving-tabindex tablist per WAI-ARIA.
 * ArrowLeft/ArrowRight move selection AND focus, Home/End jump to the ends.
 * Tabs get `aria-controls`; panels opt in via {@link tabPanelProps}.
 */

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
}

export function tabId(id: string): string {
  return `tab-${id}`;
}

export function tabPanelId(id: string): string {
  return `tab-panel-${id}`;
}

/** Spread onto the element rendering a tab's panel (id/aria wiring). */
export function tabPanelProps<T extends string>(id: T) {
  return {
    id: tabPanelId(id),
    role: "tabpanel" as const,
    "aria-labelledby": tabId(id),
    tabIndex: 0,
  };
}

/** Pure keyboard-navigation helper: the next tab id for an arrow/Home/End key. */
export function nextTabId<T extends string>(
  key: string,
  tabs: ReadonlyArray<TabItem<T>>,
  current: T,
): T | null {
  const ids = tabs.map((tab) => tab.id);
  const index = ids.indexOf(current);
  if (index === -1) return null;
  switch (key) {
    case "ArrowRight":
      return ids[(index + 1) % ids.length] as T;
    case "ArrowLeft":
      return ids[(index - 1 + ids.length) % ids.length] as T;
    case "Home":
      return ids[0] as T;
    case "End":
      return ids[ids.length - 1] as T;
    default:
      return null;
  }
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
  className,
}: {
  tabs: ReadonlyArray<TabItem<T>>;
  active: T;
  onChange: (tab: T) => void;
  /** Accessible name for the tablist. */
  label: string;
  className?: string;
}) {
  const tabRefs = useRef(new Map<T, HTMLButtonElement | null>());

  return (
    <div role="tablist" aria-label={label} className={cn("flex items-center gap-1", className)}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              tabRefs.current.set(tab.id, element);
            }}
            type="button"
            role="tab"
            id={tabId(tab.id)}
            aria-selected={selected}
            aria-controls={tabPanelId(tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const next = nextTabId(event.key, tabs, tab.id);
              if (next !== null) {
                event.preventDefault();
                onChange(next);
                tabRefs.current.get(next)?.focus();
              }
            }}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              selected
                ? "bg-accent text-accent-fg"
                : "text-muted-fg hover:bg-elevated hover:text-fg",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
