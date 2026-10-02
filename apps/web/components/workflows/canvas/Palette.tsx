"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { PalettePreset } from "@/lib/graph/presets";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Left palette inside the canvas editor (#46): draggable node sources.
 * `application/openeuler-canvas-node` carries the node kind; dropping it on
 * the canvas creates the node at the drop point. Structured as sections so
 * #49 can add a "Your team" presets section without touching the canvas.
 *
 * The "Your team" section (#49) lists the project's agent presets;
 * `application/openeuler-canvas-preset` carries the preset id, and dropping
 * it creates a node preconfigured from the preset's config copy.
 */

export const CANVAS_NODE_MIME = "application/openeuler-canvas-node";
export const CANVAS_PRESET_MIME = "application/openeuler-canvas-preset";

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

const ITEM_CLASS =
  "flex cursor-grab items-start gap-2.5 rounded-lg border border-border bg-surface p-2.5 text-left shadow-1 transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing";

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
      className={ITEM_CLASS}
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

function PresetItem({
  preset,
  onAdd,
}: {
  preset: PalettePreset;
  onAdd: (presetId: string) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(CANVAS_PRESET_MIME, preset.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onAdd(preset.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onAdd(preset.id);
        }
      }}
      aria-label={`Add ${preset.name} preset`}
      data-palette-preset={preset.id}
      className={ITEM_CLASS}
    >
      <span
        aria-hidden
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-elevated text-base leading-none"
      >
        {preset.icon ?? <AgentIcon />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg">
          {preset.name}
          {preset.builtin ? (
            <span className="ml-1.5 align-middle text-[10px] font-normal text-muted-fg">
              builtin
            </span>
          ) : null}
        </span>
        <span className="block text-xs text-muted-fg">
          {preset.description.length > 0 ? preset.description : "Saved agent preset"}
        </span>
      </span>
    </div>
  );
}

/** Skeleton rows shaped like {@link PresetItem} while the roster fetches (#72). */
function PresetSkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div
      className="flex flex-col gap-2"
      role="status"
      aria-label="Loading team presets"
      data-palette-skeleton
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-start gap-2.5 rounded-lg border border-border bg-surface p-2.5"
        >
          <Skeleton className="mt-0.5 size-7 shrink-0 rounded-md" />
          <span className="min-w-0 flex-1">
            <Skeleton className={cn("h-3.5", index % 2 === 0 ? "w-2/3" : "w-1/2")} />
            <Skeleton className="mt-1.5 h-2.5 w-full" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function Palette({
  sections,
  onAdd,
  presets = [],
  presetsLoading = false,
  onAddPreset,
  onManagePresets,
  className,
}: {
  sections: readonly PaletteSection[];
  onAdd: (kind: PaletteNodeKind) => void;
  /** The project's agent presets (#49): the "Your team" roster. */
  presets?: readonly PalettePreset[];
  /** While the roster fetch is in flight (#72): skeleton rows instead of
   *  a misleading "No presets yet" hint. */
  presetsLoading?: boolean;
  /** Click-to-add: creates a preset node at the canvas center. */
  onAddPreset?: (presetId: string) => void;
  onManagePresets?: () => void;
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

      <section className="flex flex-col gap-2" data-palette-section="your-team">
        <header className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-xs font-semibold tracking-wide text-fg uppercase">Your team</h2>
            <p className="mt-0.5 text-xs text-muted-fg">Reusable agent presets</p>
          </div>
          {onManagePresets ? (
            <button
              type="button"
              onClick={onManagePresets}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Manage
            </button>
          ) : null}
        </header>
        <div className="flex flex-col gap-2">
          {presetsLoading ? (
            <PresetSkeletonRows />
          ) : presets.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-2.5 text-xs text-muted-fg">
              No presets yet — configure a node, then use “Save as preset…” in its inspector.
            </p>
          ) : (
            presets.map((preset) => (
              <PresetItem
                key={preset.id}
                preset={preset}
                onAdd={onAddPreset ?? (() => undefined)}
              />
            ))
          )}
        </div>
      </section>
    </aside>
  );
}
