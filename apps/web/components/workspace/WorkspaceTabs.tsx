"use client";

import { cn } from "@/lib/cn";

export type WorkspaceTab = "files" | "workflows" | "runs";

export const WORKSPACE_TABS: ReadonlyArray<{ id: WorkspaceTab; label: string }> = [
  { id: "files", label: "Files" },
  { id: "workflows", label: "Workflows" },
  { id: "runs", label: "Runs" },
];

/** Files | Workflows | Runs switcher for the project workspace. */
export function WorkspaceTabs({
  active,
  onChange,
}: {
  active: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
}) {
  return (
    <div role="tablist" aria-label="Workspace sections" className="flex items-center gap-1">
      {WORKSPACE_TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              selected
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
