"use client";

import { Tabs, type TabItem } from "@/components/ui/tabs";

export type WorkspaceTab = "files" | "workflows" | "runs";

export const WORKSPACE_TABS: ReadonlyArray<TabItem<WorkspaceTab>> = [
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
    <Tabs tabs={WORKSPACE_TABS} active={active} onChange={onChange} label="Workspace sections" />
  );
}
