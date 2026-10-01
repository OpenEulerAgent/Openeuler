"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Left palette inside the canvas editor (#46): draggable node sources.
 * `application/openeuler-canvas-node` carries the node kind; dropping it on
 * the canvas creates the node at the drop point. Structured as sections so
 * #49 can add a "Your team" presets section without touching the canvas.
 */

export const CANVAS_NODE_MIME = "application/openeuler-canvas-node";

export type PaletteNodeKind = "agent" | "exit";

export interface PaletteSection {
  id: string;
  title: string;
  description?: string;
  items: Array<{
    kind: PaletteNodeKind;
    title: string;
    description: string;
    icon: ReactNode;
  }>;
}

export function AgentIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn("size-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <circle cx="6" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ExitIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn("size-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="8" cy="8" r="6" />
      <rect x="5.5" y="5.5" width="5" height="5" rx="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PaletteItem({
  item,
  onAdd,
}: {
  item: PaletteSection["items"][number];
  onAdd: (kind: PaletteNodeKind) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(CANVAS_NODE_MIME, item.kind);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onAdd(item.kind)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onAdd(item.kind);
        }
      }}
      aria-label={`Add ${item.title}`}
      className="flex cursor-grab items-start gap-2.5 rounded-lg border border-border bg-surface p-2.5 text-left shadow-1 transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing"
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-elevated text-muted-fg">
        {item.icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{item.title}</span>
        <span className="block text-xs text-muted-fg">{item.description}</span>
      </span>
    </div>
  );
}

export function Palette({
  sections,
  onAdd,
  className,
}: {
  sections: readonly PaletteSection[];
  onAdd: (kind: PaletteNodeKind) => void;
  className?: string;
}) {
  return (
    <aside
      aria-label="Node palette"
      className={cn(
        "flex w-60 shrink-0 flex-col gap-4 border-r border-border bg-bg p-3",
        className,
      )}
    >
      {sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-2" data-palette-section={section.id}>
          <header>
            <h2 className="text-xs font-semibold tracking-wide text-fg uppercase">
              {section.title}
            </h2>
            {section.description ? (
              <p className="mt-0.5 text-xs text-muted-fg">{section.description}</p>
            ) : null}
          </header>
          <div className="flex flex-col gap-2">
            {section.items.map((item) => (
              <PaletteItem key={item.kind} item={item} onAdd={onAdd} />
            ))}
          </div>
        </section>
      ))}
    </aside>
  );
}
